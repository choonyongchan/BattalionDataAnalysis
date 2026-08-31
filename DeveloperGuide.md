# Developer Guide

Architecture and design rationale for the Strength Tracker project. Read this
before making changes — several design choices are non-obvious and exist to
handle real, messy input data. For setup/deployment/operations, see
[README.md](README.md).

## 1. What this system does, in one paragraph

A parade state arrives as free text — normally relayed automatically from a
WhatsApp group by the `whatsapp/` bridge (§9), or else pasted by a company
clerk into a Google Form with a single question, "Drop your Parade State
here". Either way it lands as a new row in the "Parade State Responses"
sheet and is processed immediately — no batching, no waiting. Processing
sends the free text to OpenAI with a strict JSON schema
that extracts *everything*: which of the six companies the message belongs
to, its date, its parade session (first/last), company-level and per-platoon
strength figures, and every personnel entry (Att C/MC, Report Sick, Status,
Off/Leave, MA, Others). Once that identity (company+date+session) is known,
it deletes any earlier submission for the same identity — both the
old raw row and everything derived from it — then runs a lightweight
structural validation pass and writes the result to three sheets: "Strength
Data" (a clean time series of strength numbers), "Personnel Data" (one row
per person) and "Command Roster". Anything that doesn't validate, and anything
that fails outright (API error, malformed response), is recorded on the
submission's own row: `parade_response_id` reads `ERROR` and the reason sits
beside it in `error`. Nothing is ever silently dropped. A Looker Studio
dashboard reads "Strength Data" and "Personnel Data" directly as data sources.

## 2. Why this architecture

**One free-text Form question, not four structured ones.** An earlier
iteration of this design put Company/Date/Parade-type into their own Form
questions specifically so the AI wouldn't have to infer them — but that
duplicated data the clerk was already about to paste (a parade-state message
states its own company and date somewhere in the text)
and added friction to the one step that needs to be fast: submitting the
parade state. The Form was shrunk back down to the single free-text
question, and `ParserAi.buildPrompt_()` now identifies company, date,
and session from the message text itself — including a specific rule for
Hercules, the battalion's own HQ element, which never spells out its name
and only ever says "HQ Company".
The tradeoff, accepted deliberately: identity extraction can now fail (an
ambiguous or truncated message), in which case `ParserRows.validate()` returns
a reason that is written to the row's `error` column rather than guessing.

**Processing is immediate, not batched.** With ingestion now a discrete event
(not an arbitrary paste that might happen mid-edit), there's no
need for the old 15-minute time-driven trigger or its `PENDING → PROCESSING
→ DONE/ERROR` state machine. Exactly the row that just arrived is processed,
synchronously, before the next one can. This is simpler and gives near-instant
feedback (check the row's `parade_response_id` right after submitting).

**The row is the only state.** There is no status ledger, no attempt counter, no
retry budget and no error tab. `parade_response_id` carries every outcome —
empty means due, a key means done, `ERROR` means failed with the reason in
`error` beside it — and clearing that one cell by hand is the only reprocess
gesture. An earlier design tracked the same information across four extra
columns plus a two-row-type errors tab, which required a placeholder key
(`logRef`) purely so a failure could be filed *somewhere else* before its real
key was known. Putting the error next to the text that caused it removed all of
it, and made the failure visible in the place an operator is already looking.

For the WhatsApp path this happens inside the `doPost` that appended the row, so
no trigger is involved at all. For the Form and forced-reprocess paths it happens
in an installable trigger — installable, not a simple `onFormSubmit(e)`/`onEdit(e)`
function, specifically because simple triggers cannot call `UrlFetchApp`; a human
runs `installTriggers()` once from the editor to grant that authorization, exactly
as the old `installProcessingTrigger()` was.

That constraint is also the reason the WhatsApp bridge posts rather than writing
the sheet: **installable triggers do not fire for API requests** either, so a
direct Sheets-API write would land a row and trigger nothing. See §9.1.

**The key is derived from extraction, then persisted — it can't be
recomputed on demand.** `ParserSchema.paradeResponseId_(company, isoDate,
session)` is still a pure function of the three identity fields, and it's
still not a generated UUID. But because those three fields no longer live
in their own Parade State Responses cells — they only exist inside the free-text
`rawText` blob — a row's key can't be cheaply recomputed by just re-reading
its cells the way it could when they were structured Form columns;
recomputing it would mean re-running AI extraction on every row just to
scan for duplicates. So `Parser.processRow` computes the key once, right after
a successful extraction, and `ParserSheets.finishRow` writes it onto that row's
own `parade_response_id` column. Later dedup scans
(`ParserSheets.deleteDuplicateRawResponses_`) then just compare against that
persisted column — cheap, but it does mean a row sitting at `ERROR` (which
holds the sentinel, not a key) is invisible to the dedup scan until it's
successfully reprocessed. See the known limitations section for the consequence.

`PARADE_ERROR_SENTINEL` can never collide with a real key, since
`paradeResponseId_` always produces `company_date_session` — which is what lets
one column carry both "which submission is this" and "did it work".

**Deleting a duplicate shifts the row being written.** `deleteDuplicateRawResponses_`
walks bottom-up so deletions don't disturb rows it hasn't visited, but a deletion
*above* the row currently being processed still shifts that row up by one. It
therefore returns how many such rows it removed, and `Parser.processRow` subtracts
that before calling `finishRow`. Without it the key is written one row too low —
silently, onto whatever submission happens to be there. This was a live bug in the
pre-`src/parser` code, found by `test/parser.contract.test.js`.

**Extraction is AI-based, not regex/fixed-format parsing.** Real sample
messages from every company were reviewed during design. Every
company's clerk formats the free-text parade-state box differently —
different headers, different category orderings, some split into per-platoon
blocks, some flat, strength expressed as fractions in one message and as two
separate labeled lines in another. A fixed parser would need constant
maintenance as formatting drifts; an AI model with a strict response schema
and a heavily-worked prompt tolerates this variance far better. See
`ParserAi.buildPrompt_()` for the exact rules distilled from the sample
data.

**The prompt asks the model to read, never to compute.** An obvious-looking
optimisation is to derive `num_days` from the start/end dates in code and stop
asking for it. Auditing the labelled data killed the idea: every entry carrying
both dates already states its own count, so a derivation would fire *only* where
no count is stated — and that shape is the overnight duty
(`DATE & TIME: 180626 1630 - 190626 0800`, 17 entries in `archer.txt`), which is
one duty, not the two days an inclusive count gives. Two other entries state a
count that disagrees with their own date range, and the stated figure is the one
the unit tracks. Same reasoning bars inferring `in_camp` from a location name:
an audit found 35 of 41 non-null `in_camp` labels had been inferred that way,
including 31 in a message that never mentions a camp at all.

**Company-level and per-platoon strength are extracted separately, in one
call.** `braves.txt` and `archer.txt` both restate strength once for the
whole company and again inside each platoon's own sub-block. Rather than
splitting messages into independent "blocks" (the old design's approach),
the response schema has a single `platoons` array whose first entry is the
mandatory company total (`platoon: "Company"`, `unit_type: "Company"`) — the
whole message is one extraction, and the company total is just another row
rather than a separate top-level object, so both grains Looker Studio needs
read out of one tab: a company-wide trend line and a per-platoon breakdown,
filterable by `platoon` and `unit_type` in "Strength Data".

**Personnel entries carry their own platoon attribution.** The same sample
messages nest personnel listings (MC, Report Sick, etc.) inside each
platoon's block, not just at the company level. The prompt instructs the AI
to tag each personnel entry with the platoon label it appeared under (or
leave it null for a genuinely company/HQ-level entry), so "Personnel Data"
stays filterable by platoon the same way "Strength Data" is.

**Duration is split from reason, uniformly across all six categories.** The
old design concatenated everything descriptive (reason, duration, date
range, location) into one free-text `remarks` string. This design asks
the AI to separate the day-count/date-range portion (`duration`, e.g. "7D
(170626-300626)") from the underlying reason/condition/appointment text
(`reason`, e.g. "MC"), for every personnel entry regardless of category —
not just Att C/MC and Report Sick — so "Personnel Data" has one consistent
schema a Looker Studio table or filter can rely on, rather than duration
sometimes being embedded in free text and sometimes not.

**Two output sheets, not one combined sheet.** The old "Canonical Data"
sheet put strength figures and one absentee's detail on the same row, which
means a platoon's strength number gets duplicated across every personnel row
for that platoon (or once with blank personnel fields, if there are none). A
Looker Studio time-series chart of `total_strength` over `date` doesn't want
that duplication or those blank-row artifacts. Splitting into "Strength
Data" (always exactly company-total-row-plus-one-row-per-platoon, per
submission) and "Personnel Data" (exactly one row per person, per
submission) keeps both cleanly chartable on their own terms and keyed
together by the same `parade_response_id`.

**No arithmetic reconciliation.** Carried forward unchanged from the prior
design's explicit product decision: the category counts clerks write in
message headers are frequently wrong (e.g. `archer.txt` platoon 1: header
says `OTHERS: 02`, eight entries follow), and in several samples the
arithmetic doesn't reconcile even when every field is read correctly,
because categories like "Status" often represent present-but-restricted
personnel rather than genuine absentees — a semantic distinction the source
messages don't consistently signal. `ParserRows` therefore performs
structural validation only (required fields present and correctly typed),
not a sum-of-personnel-vs-strength check.

**Cascade delete runs after extraction, once a key exists.** The real
`parade_response_id` isn't known until the AI has extracted
company/date/session, and now that a failure is recorded on the row itself there
is nothing to file under a placeholder in the meantime — the `logRef` scheme the
old design needed for that is gone entirely. On the success path, once the key is
computed, `deleteDuplicateRawResponses_` removes any other row persisted with the
same key and `deleteOutputsForKey()` clears any prior Strength Data / Personnel
Data / Command Roster rows for it before fresh output is written. This keeps "at
most one outcome per company+date+session" true, which is what makes a
resubmission converge cleanly instead of leaving stale numbers behind for Looker
Studio to double-count.

`processRow` also takes `previousId` — the key the row held before a maintainer
cleared it. A corrected message can resolve to a *different* key (a fixed date,
say), and its old output rows would otherwise sit in all three tabs forever with
nothing pointing at them. Apps Script supplies `e.oldValue` only for a
single-cell edit, which is exactly the clear-one-id gesture, so a multi-row clear
passes `''` and accepts the limitation.

On the failure path nothing is deleted at all. The key is only known after
validation passes, so a reprocess that now fails leaves the previous run's output
intact rather than silently emptying the tabs for a submission that was fine.

**Lock discipline.** `LockService.getScriptLock()` is held only around sheet
reads/writes, never across a network call. `Parser.processRow` does the (slow) AI
call with no lock held, then acquires the lock only for the short dedup scan,
output-clearing pass, and final writes. Holding a script-wide lock across an AI
call would block any other concurrent submission for as long as the API takes to
respond — this matters more than usual on the Flex processing tier, which trades
higher latency for lower cost.

**Errors never propagate uncaught — except the one that must.** `processRow`
catches everything and writes it to the row. The exception is lock contention:
`finishRow` needs the lock too, so if the lock is unavailable the write itself
cannot happen and the error propagates out to `handlePost`, which rethrows it.
That is deliberate and load-bearing — a thrown error is the only way Apps Script
emits a 5xx, and a 5xx is the only thing that makes the bridge resend. Recording
"could not acquire lock" on the row would answer 200 and lose the message.

## 3. Data flow

Three entry points converge on one processing core:

```
WhatsApp bridge POSTs ?route=paradestate        [primary]
        │  doPost [WebApp.js] → Parser.handlePost
        │  token check, then ParserSheets.appendIfNew(text, messageId)
        │  duplicate wa_message_id → if the row is still blank, reprocess it;
        │                            else reply appended:false, stop here
        │
Clerk submits the Google Form                   [fallback]
        │  new row appended to "Parade State Responses" (Form owns columns A–B)
        │  onFormSubmitHandler(e) [installable onFormSubmit trigger]
        │
Maintainer clears a row's parade_response_id    [forced re-run]
        │  onEditHandler(e) [installable onEdit trigger]
        │  previousId = e.oldValue, for a single-cell clear
        │
        └──────────────────┬──────────────────┘
                           ▼
  Parser.processRow(rowIndex, previousId)
        │  ParserSheets.readText → rawText
        │       header mismatch → log expected vs actual, write NOTHING, stop
        │       blank text      → stop (an empty row never costs an API call)
        │  ParserSheets.markProcessing(thisRow)  [error = 'Processing...', id left blank]
        ▼
  ParserAi.extract(rawText)                      [throws on failure; 2 attempts]
        │      buildPrompt_ + buildResponseSchema_ → call_ (UrlFetchApp) → parseResponse_
        │      returns {company, date, session, platoons, command_team, personnel}
        ▼
  ParserRows.validate(extraction)                [returns '' or a one-line reason]
        │
        │  reason → throw, caught below
        │
        │  ''     → key = ParserSchema.paradeResponseId_(company, date, session)
        │           ParserSheets.deleteOutputsForKey(previousId)   [only if the key changed]
        │           ParserSheets.deleteOutputsForKey(key)
        │           n = ParserSheets.deleteDuplicateRawResponses_(key, thisRow)
        │           ParserSheets.appendRows × 3 → Strength Data / Personnel Data / Command Roster
        │           ParserSheets.finishRow(thisRow - n, key, '')    [n rows were deleted above this one]
        ▼
  catch → ParserSheets.finishRow(thisRow, 'ERROR', err.message)

  Lock contention is the one error NOT recorded: finishRow (and markProcessing) need the
  lock too, so it propagates to handlePost and is rethrown, producing the 5xx that makes
  the bridge resend.

  Looker Studio reads "Strength Data" and "Personnel Data" directly as Google Sheets data sources.
```

## 4. File responsibilities

The parade-state pipeline lives in `src/parser/`. All service files are ES6
classes with **static** methods — there's no per-instance state, so a class here
is purely a namespace that groups a service's public surface and its
`_`-suffixed private helpers. `Parser.js` also exports plain top-level functions
(`onFormSubmitHandler`, `onEditHandler`, `installTriggers`, `removeTriggers`,
`reprocessRow`, `reprocessPendingRows`) because trigger handlers, editor-dropdown
entry points and Sheets menu macros must be global function names for Apps Script
to invoke them; each immediately delegates
to the matching `Parser.*` static method. `WebApp.js` exports the project's single
global `doPost`, for the same reason.

`src/` holds **execution code only** — no `setup()`, no `verifySetup()`, no
diagnostics. Anything that merely verifies lives in `test/`, which is outside the
clasp deployment boundary. See §4.1.

| File | Responsibility | Notable methods |
|---|---|---|
| `parser/ParserSchema.js` | Sheet names, column layouts, enums, script-property keys, model constants, the deterministic key builder, on-demand tab creation | `sheet_`, `columnIndex_`, `paradeResponseId_`, `isIsoDate_` |
| `parser/ParserAi.js` | Prompt/schema definition (including company/date/session identification), the HTTP call, defensive response parsing | `extract` (public), `buildPrompt_`, `buildResponseSchema_`, `call_`, `parseResponse_` |
| `parser/ParserRows.js` | Structural validation of an extraction; shaping it into row arrays for all three output tabs | `validate`, `buildStrengthRows`, `buildPersonnelRows`, `buildCommandRosterRows` |
| `parser/ParserSheets.js` | All sheet I/O, every mutating method wrapped in `LockService` | `readText`, `readParadeResponseId`, `appendIfNew`, `markProcessing`, `finishRow`, `deleteDuplicateRawResponses_`, `deleteOutputsForKey`, `appendRows` |
| `parser/Parser.js` | Every intake into the parade-state pipeline, the processing core, plus trigger install/teardown | `processRow`, `handlePost`, `onEditHandler`, `onFormSubmitHandler`, `reprocessPendingRows`, `installTriggers` |
| `WebApp.js` | The project's single `doPost`, dispatching by `?route=`; no logic of its own | `doPost` |
| `appsscript.json` | Manifest: timezone, minimal OAuth scopes | — |

Dependency direction is strictly one-way and matches the table's order
bottom-to-top: `Parser` depends on `ParserSheets`, `ParserAi` and `ParserRows`;
all of those depend only on `ParserSchema`; none depends on `Parser`. This keeps
each service independently testable and reasoned-about.

### 4.1 Where setup went

`Config.setup()` and `Config.verifySetup()` used to live here. Both are gone, and
what they did now happens on the path that needs it:

| It used to | Now |
|---|---|
| `setup()` wrote script properties from placeholders pasted into the source | Type them into **Project Settings → Script Properties**. The old flow ended with "now delete the real key from `Config.js`", and the failure mode was forgetting |
| `verifySetup()` created the script-owned tabs | `ParserSchema.sheet_` creates each tab with its header row on first write, exactly as `FormSgSchema.sheet` already did |
| `verifySetup()` flagged a Form-owned header mismatch | `ParserSheets.readText` refuses to read or write and logs expected vs actual. It fires when it matters, not when someone remembers to run it |
| `verifySetup()` checked the properties were set | `ParserAi` throws a named error onto the row; `isAuthorised_` fails closed |
| `listInstalledTriggers()` logged the installed triggers | The editor's Triggers panel already lists them |

## 5. Sheet schemas (source of truth: `parser/ParserSchema.js` column arrays)

**Parade State Responses** — `Timestamp, Drop your Parade State here,
wa_message_id, parade_response_id, error`
Columns A–B are owned by the linked Google Form's single question and must
match its title exactly; columns C onward are this script's own
bookkeeping and a Form submission never touches them.

`parade_response_id` carries the pipeline's entire state:

| Value | Meaning |
|---|---|
| `''` | Not processed yet — this is what makes a row due |
| `''`, with `error` = `Processing...` (`PARADE_PROCESSING_SENTINEL`) | A run started and did not finish; still due |
| `Archer_2026-06-22_FPS` | Processed; output rows exist under this key |
| `ERROR` (`PARADE_ERROR_SENTINEL`) | Failed; `error` holds the one-line reason |

The sentinel can never collide with a real key, since `paradeResponseId_` always
produces `company_date_session` — which is what allows one column to answer both
"which submission is this" and "did it work". `processRow` stamps
`Processing...` into `error` before extraction and every completed run overwrites
`error` again (cleared on success, the reason on failure), so a row still showing
that marker with a blank id was killed mid-run and is treated exactly like a
blank row. `error` is cleared on every success, so a row never shows a stale
reason. Clearing `parade_response_id` by hand is the reprocess gesture;
`onEditHandler` picks it up, and the `reprocessPendingRows` Sheets menu macro is
the capped batch equivalent for every still-blank row at once.

**Strength Data** — `parade_response_id, date, session, company, platoon,
unit_type, total_strength, total_present, officer_strength, officer_present,
wospec_strength, wospec_present, enlistee_strength, enlistee_present`
One row per `platoons[]` entry, including the mandatory company-total row
(`platoon = 'Company'`, `unit_type = 'Company'`). `unit_type` distinguishes a real
platoon from an HQ block or a company-wide command element (Cougar's
`COMMANDERS: 20/25`), so a consumer never double-counts one as a platoon. A rank
tier the message didn't state is `''`, never `0` — `0` is a real headcount.

**Personnel Data** — `parade_response_id, date, session, company, platoon,
four_d, name, rank, reason_category, start_date, end_date, num_days, reason,
location, in_camp`
One row per personnel entry across all six `REASON_CATEGORIES`. `platoon` is the
label the AI attributed the entry to, or `''` for a company/HQ-level entry not
inside any specific platoon's block. `start_date`/`end_date`/`num_days` replace a
single combined duration string, and each is `''` when the message doesn't state
it — including the deliberately common cases of an open-ended status (start only),
an open-started one (end only), and an entry with no dates at all. `in_camp` is
`''` unless the message says so explicitly; it is never inferred from `location`.

**Command Roster** — `parade_response_id, date, session, company, role, rank, name`
One row per command-team member in the message's header block (`CDO: 2LT RYAN`).
`role` is normalised to one of `COMMAND_ROLES` (`PDS1`, not `PDS 1`). Companies
whose messages carry no command block simply produce no rows.

There is **no errors tab.** Failures live on the response row, and exceptions that
escape even that (only lock contention can) surface in the editor's **Executions**
log.

## 6. Extending the system

- **Adding a reason_category value**: update `REASON_CATEGORIES` in
  `parser/ParserSchema.js` (also updates the AI response schema automatically,
  since `ParserAi.buildResponseSchema_` reads from it) and add the new
  heading-text mapping to the table in `ParserAi.buildPrompt_`.
  `test/parser.schema.test.js` asserts the two stay in step.
- **Adding a company**: update `COMPANIES` in `parser/ParserSchema.js` —
  `ParserAi.buildPrompt_` interpolates that list directly into the company
  identification instructions, so no separate prompt edit is needed unless
  the new company also needs a special-case heading rule (like Hercules/"HQ
  Company").
- **Adding a Strength Data or Personnel Data column**: update the relevant
  `*_COLUMNS` array in `parser/ParserSchema.js`, add the corresponding field to
  the matching `ParserRows.build*Rows` method (and to
  `ParserAi.buildResponseSchema_`/`buildPrompt_` if the value must come from
  extraction). Script-owned tabs are only created with their header on first
  write, so an existing tab's header row is updated by hand — there is no
  auto-migration by design.
- **Reintroducing arithmetic reconciliation**: if message quality improves
  enough to make this viable, add the check inside `ParserRows.validate()` and
  let it return a reason like any other failure — keep the single
  validate-then-record shape intact.
- **Changing the model**: `OPENAI_MODEL` in `parser/ParserSchema.js` is the only
  place the name is referenced (`OPENAI_CHAT_COMPLETIONS_URL` sits next to it).
  Change it deliberately and re-check extraction quality against real
  parade-state messages, not on a hunch.
- **Reprocessing without a new submission**: clear the row's
  `parade_response_id` in the sheet, or run `reprocessRow(rowIndex)` from the
  editor. The `reprocessPendingRows` Sheets menu macro is the batch equivalent —
  it reprocesses every still-blank row (including one left showing `Processing...`
  after a killed run), capped at `MAX_ONEDIT_REPROCESS_ROWS`; it does not touch
  `ERROR` rows, which are retried by clearing the cell as before. There is still
  no attempt counter — a failure that needs retrying is visible in the `error`
  column, and clearing the cell is the retry.

## 7. Known limitations

- **"Status" category semantics are ambiguous in source data.** Some
  messages use it for present-but-restricted personnel (e.g. "excuse
  kneeling"), which isn't reliably distinguishable from genuine absence by
  text alone. Currently every listed Status entry is recorded as-is; no
  attempt is made to infer presence. Downstream reporting/consumers of
  Personnel Data should be aware Status rows may not all represent
  absentees.
- **No arithmetic reconciliation** (see section 2) — Strength Data and
  Personnel Data trust the AI's extraction of whatever figures the message
  reports, without cross-checking internal consistency. A row's `error` only
  catches structural problems (missing fields, invalid types), not numeric
  mismatches.
- **Duplicate-person-different-category entries aren't deduplicated.** If a
  source message lists the same person under two categories on the same day
  (seen in `archer.txt`), both are recorded as separate Personnel Data rows
  — this mirrors what the source message states rather than resolving which
  is authoritative.
- ~~**A Parade State Responses row edited or pasted in directly (bypassing the
  Form) never triggers processing on its own.**~~ Fixed: an installable `onEdit`
  trigger now reprocesses any row whose `parade_response_id` is cleared, so the
  gesture needs no editor access. `reprocessRow(rowIndex)` remains available. Note the limitation has only moved, not vanished — `onEdit`
  fires for human edits, never for Sheets-API writes, so a row written by a
  script or by the API still needs the id cleared by hand (or a POST to the
  web app, which processes on arrival). See §9.
- **Company/date/session identification can fail or misfire**, since it now
  depends entirely on the AI reading the message text rather than a
  human-filled Form field. A message that never states its date, or whose
  company name is spelled unusually, lands as `ERROR` on its own row with the
  reason beside it instead of silently guessing — but a message that states the *wrong* identity clearly
  (e.g. a copy-pasted template with last week's date never updated) will be
  extracted and filed under that wrong identity without any warning.
- **Dedup only catches rows that have previously succeeded.** Because
  `parade_response_id` is only persisted after a successful extraction+
  validation, a row sitting at `ERROR` holds the sentinel rather than a key and
  won't be found by `deleteDuplicateRawResponses_` — so
  it's possible to have one successfully-processed row for a given
  company+date+session *and* one or more older failed rows for the same
  identity still sitting in Parade State Responses. This is intentional (see section
  2's "key is derived from extraction" discussion) but worth knowing when
  auditing Parade State Responses row counts.

## 8. The FormSG ingestion module

A second intake path that shares nothing with the pipeline above:

```
FormSG  ->  Plumber  ->  doPost  ->  "Report Sick FormSG Responses"
            (decrypts)   (src/formsg)
```

FormSG encrypts each submission. [Plumber](https://plumber.gov.sg), OGP's own
automation tool, decrypts it and relays it here as plain JSON keyed by this sheet's
column headers. `src/formsg/` then does one thing: map that JSON to a row and append
it — **in the exact layout FormSG's own CSV export uses**, so a webhook row and an
imported row are indistinguishable.

Setup and operations are in [README.md](README.md) §8; this section covers why it is
built the way it is.

### 8.1 Why Plumber sits in the middle

The module used to receive FormSG's storage-mode webhook directly and decrypt it
in-script. Apps Script has no X25519 or ed25519 primitive, so that required vendoring
2,407 lines of TweetNaCl, a wrapper around it, and a self-test whose entire purpose
was proving a browser/Node crypto bundle loaded under the V8 runtime. Roughly 3,000
of the module's 3,671 lines existed to serve that one constraint.

Moving decryption to Plumber deleted all of it. What is left — four files, about 240
lines — is only the part that was ever about getting a row into a sheet.

The form's secret key moved to Plumber along with the decryption, so the FormSG
module holds **no key material and does no cryptography**. The one script property it
now reads is `FORMSG_INGEST_TOKEN`, a shared bearer token checked in
`FormSgSheet.isAuthorised_` (§8.4) — a plain secret comparison, not a cipher. There
is no `setup()` function; the token is set by hand in Project Settings.

### 8.2 Two runtime constraints that still shape the design

**ContentService always responds 200.** A status code cannot be set from Apps Script,
so the two failure kinds are distinguished by what the handler does rather than by
what it returns:

- **permanent** (a body that is not a submission) — log it and return 200, because a
  retry will never change the result;
- **transient** (lock contention, sheet unavailable) — throw, which is the only way
  to produce a 5xx from Apps Script, so Plumber retries.

**Apps Script answers through a 302 redirect.** A webhook client can record that as a
failure even though `doPost` already ran and already wrote the row, so a retry may
arrive after a *successful* write. This is why the append stayed here rather than
moving into Plumber's own Google Sheets action, which appends unconditionally. See
§8.3.

### 8.3 Idempotency is mandatory, not defensive

`FormSgSheet.appendIfNew_` scans the `Response ID` column before appending, and holds
a script lock across the read-then-append so two concurrent retries cannot both
decide the row is new. `Response ID` must therefore stay first in `FORMSG_COLUMNS`:
`hasSubmissionId_` scans column 1.

A body with no `submissionId` is rejected as a permanent bad request rather than
appended, because accepting one would let a retry write a duplicate.

Dedup is the single reason this module still exists as code. Pointing Plumber's
Sheets action straight at the tab would have deleted the remaining 240 lines too —
and reintroduced duplicate rows on every 302.

### 8.4 Every route is guarded by its own shared secret

The deployment must still be `ANYONE_ANONYMOUS`: Plumber cannot authenticate to
Google. In front of that, `FormSgSheet.isAuthorised_` requires every request to
carry a `token` field in its JSON body matching the `FORMSG_INGEST_TOKEN` script
property, or the request is rejected as `unauthorised` and no row is written. The
check runs *after* the body-shape check, so a raw FormSG envelope (§8.6) is still
named as `bad_request` rather than hidden behind an auth failure.

It fails closed: if `FORMSG_INGEST_TOKEN` was never set, `expected` is null and
every request is rejected. This mirrors the parade-state route's
`Parser.isAuthorised_` exactly, and the dashboard route's
`DashboardFeed.isAuthorised_` alongside it — the three routes hold separate secrets,
so any one can be rotated alone.

The dashboard route is the same shape guarding the opposite direction: it reads
rather than writes, so a correct guess there is worth the whole battalion's names and
medical reasons rather than junk rows in one tab. It therefore also counts failed
attempts in the script cache and stops answering after ten inside fifteen minutes —
including to the right password, so guessing cannot continue quietly. That is a speed
bump, not a lock (cache entries can be evicted, and the counter cannot be per-caller
when the handler cannot see who is calling); the defence that carries the weight is
the length of the passphrase. See `dashboard/README.md`.

The token lives in the body because Apps Script cannot read request headers at all,
which is also why verifying FormSG's `X-FormSG-Signature` remains impossible here.
An earlier revision dropped this check to keep the module free of script properties;
it was restored because the blast radius is OpenAI-adjacent — a flood of junk rows
is cheap, but the URL leaking (a log, a forwarded message) should not be enough to
write to the sheet at all.

**Rollout order matters, because the route is live and Apps Script always answers
200.** Set `FORMSG_INGEST_TOKEN` first, then add the `token` field to Plumber's body
and run its test step, and only then push and redeploy. Any other order silently
drops report-sick intake — Plumber records the 200 as a success while every request
is rejected.

### 8.5 One column spec, and why there is no catch-all column

`FORMSG_COLUMNS` in `src/formsg/FormSgColumns.js` is the single source of truth for
the sheet's shape. Three columns resolve from the request envelope
(`Response ID`, `Timestamp`, `Download Status`); every other header is looked up
verbatim in the payload's `answers` object.

The mapping is split across two places on purpose. `FORMSG_COLUMNS` owns **column
order and the sheet schema** — the half that must match FormSG's CSV export, and so
belongs in version control. Plumber's body template owns **which answer fills which
column** — the half that changes whenever a question is reworded, and so belongs
next to the form. The cost is that a renamed Plumber mapping silently blanks a
column, with no error anywhere; the header table in README.md §8.7 names that
symptom.

The layout has no catch-all column, because FormSG's CSV export has none. An answer
with no matching header is simply not sent by Plumber and never reaches this script.

`Masked NRIC` is retained but permanently blank on webhook rows: Plumber exposes only
the full verified NRIC. The column stays so pasted CSV rows still line up — one of
2,243 historical rows has a value there, and it is the oldest row in the sheet.

### 8.5.1 Timestamps are stored as dates, not text

The webhook path writes `submittedAt` as a real `Date`, so the column sorts
chronologically and Looker Studio reads it as a date. An unparseable value falls back
to the raw string rather than writing an `Invalid Date`.

The CSV path cannot make that guarantee: whether Google Sheets parses FormSG's
`07 May 2026 19:21:00` into a Date or leaves it as text depends on how the export was
pasted, which is why the column arrived half one and half the other.
`FormSgTimestamps.normalise` repairs it, and lives in its own file precisely because
it belongs to the CSV path rather than the webhook one. It parses the format
explicitly rather than handing it to `new Date(string)`, whose handling of non-ISO
formats is implementation-defined.

### 8.6 Testing

`test/` holds a `bun test` suite that runs with no Google account involved. The Apps
Script sources need no test-only modification: `test/harness.js` concatenates
`src/formsg/*.js` into one `node:vm` script — reproducing the single shared global
lexical scope Apps Script gives them — and stubs `SpreadsheetApp`, `LockService`,
`ContentService` and `Logger`.

The harness deliberately shares the host realm's intrinsics with the vm context.
Apps Script runs everything in one realm, so a `Date` the module builds and a `Date`
a test builds must be the same `Date`; without that, `value instanceof Date` in
`normalise` fails for reasons that exist only in the harness.

This replaced `FormSgSelfTest.js`, which ran inside the editor and reported through
`Logger` — it could not fail a build, and half of what it checked was whether the
vendored crypto bundle loaded, which no longer applies.

### 8.7 Known limitations

- **A renamed Plumber field silently blanks its column.** There is no error surface
  for this; it is caught by inspecting a test submission (README.md §8.6).
- **`Masked NRIC` is never populated by the webhook path** (§8.5).
- **Free text may break Plumber's JSON body.** If Plumber interpolates a quote or
  newline unescaped, the request arrives malformed and is rejected as
  `bad_request`. The fallback is a form-encoded body, which Apps Script reads from
  `e.parameter` with no JSON parsing at all.
- **`form_id` and `attachments_json` are not stored**, because the CSV layout has no
  such columns. Attachments are not recorded either — `attachmentDownloadUrls` holds
  presigned URLs that expire, and this form collects no attachments.
- **The endpoint requires a shared `token` in the body** (§8.4), held in the
  `FORMSG_INGEST_TOKEN` script property.
- **The web app must be redeployed to take effect.** A `clasp push` alone changes
  nothing about what the endpoint serves.

## 9. The WhatsApp intake module

`whatsapp/` is a long-running Bun process that watches a WhatsApp group, keeps only
genuine first parade states, and relays them to this project's web app. It is the
**primary** parade-state intake; the Google Form is the fallback.

### 9.1 Why the Form hop existed, and why it is gone

The bridge used to fill in the Google Form. That was not an accident of history — it
was the only thing that worked. Processing was driven by `onFormSubmit`, and
**installable triggers do not fire in response to API requests**. A bridge that wrote
the *Parade State Responses* sheet directly through the Sheets API would land the row
and trigger nothing at all.

So the Form was a relay whose entire purpose was to be a legitimate Form submission.
The cost was a hop, a scraped `entry.<digits>` id, a script to discover that id, and a
second place where the schema had to agree.

Handling a POST removes all of it. `Parser.handlePost` appends the row and calls
`processRow` in the same execution, so the trigger question does not arise.
The Form and its trigger stay installed, unchanged, as a manual path.

The alternative considered and rejected was a time-driven trigger polling for unprocessed
rows. It would have worked with a direct Sheets-API write, but it trades instant
processing for up to a minute of latency and burns a trigger execution every minute
whether or not anything arrived.

### 9.2 One doPost, two intakes

Apps Script allows a single `doPost` per project, and the FormSG module already had it.
`src/WebApp.js` now owns the global and dispatches on a `route` query parameter.

An unrouted or unknown request is **rejected**, never defaulted to either handler. The
reasoning is the §8.3 reasoning applied to routing: `ContentService` always answers 200,
so a body accepted by the wrong handler writes wrong rows to the wrong tab *and* tells
the caller it succeeded. Rejecting is the only outcome a caller can act on — and it is
logged by name, because a Plumber URL missing `?route=reportsick` otherwise presents as
"rows stopped arriving" with no other symptom.

Consequence worth stating plainly: **adding the route parameter to Plumber is a required
deployment step**, and it is safe to do before deploying, since the older code ignores
unknown query params.

### 9.3 Idempotency, again mandatory

`ParserSheets.appendIfNew` dedupes on a `wa_message_id` column, holding the
lock across the read-then-append. Two independent causes make this mandatory rather than
defensive:

1. The Apps Script 302 described in §8.3. The bridge follows redirects, which re-sends
   the POST body, so one call can run the handler twice.
2. Baileys redelivers messages after a reconnect.

The bridge therefore keeps no local dedupe state. It had a file-backed one; it could only
ever see cause 2, and having two half-blind dedupers is worse than one that sees both.

A duplicate is answered `appended: false`. It normally costs no AI call — but if the
row it matches is still blank (a first delivery whose `processRow` was killed before it
finished), the redelivery reprocesses that row in the same execution, so the bridge's
resend is what recovers a stranded first delivery. A row already carrying a key or
`ERROR` is left alone.

### 9.4 What the bridge decides, and what it does not

Two cheap gates: structural (≥ 8 non-empty lines, ≥ 200 characters, the phrase "parade
state") and first-parade (an explicit `FIRST PARADE`/`FPS` marker, or a header timing
before 12:00). Both exist to stop chatter costing an AI call.

A six-signal layout score used to follow them, requiring 3 of 6 matches. It has been
removed. Whether a message is really a parade state is a judgement `ParserAi` and
`ParserRows` already make, by reading the message rather than inferring from its shape —
so the score was a weaker second copy of it, sitting upstream of the real one. Its
failure mode was dropping a genuine parade state whose layout was merely unusual, with
the rejection recorded only in a debug log. Post-removal, such a message reaches the
sheet and, if it is not a parade state, surfaces as `ERROR` on its own row — visible
and reversible.

The trade accepted: slightly more junk can reach the AI. The gates make that cheap, and
a visible wrong answer beats a silent drop.

### 9.5 Known limitations

- **Baileys is an unofficial client.** WhatsApp has no official group-read API — Meta's
  Cloud API is 1:1 only. A ban is unlikely for read-only traffic but not impossible; use
  a secondary number. The durable alternatives are the Cloud API (companies DM the state)
  or Telegram's Bot API, which supports groups natively.
- **`auth/` is a live session.** Possessing it is equivalent to being logged in as that
  account. It is git-ignored and must stay so.
- **A shared token is the only gate on both web-app routes.** Each is checked fail-closed
  (`WHATSAPP_INGEST_TOKEN` for parade-state, `FORMSG_INGEST_TOKEN` for report-sick), but
  it is a shared secret in a query-free POST body, not a signature. Apps Script cannot
  read request headers at all, so an HMAC over the body is the strongest option available
  and was not judged worth the complexity.
- **`onEdit` reprocessing is capped** at `MAX_ONEDIT_REPROCESS_ROWS` rows per gesture, so
  clearing a whole column does nothing but log. Each row costs an AI call.
- **The listener reconnects by recursion.** `startListener` calls itself after a drop,
  building stack depth over a very long uptime. Untouched by this refactor and not
  observed to matter, but it is not a loop.

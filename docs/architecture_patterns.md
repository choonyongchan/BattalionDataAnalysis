# Architecture patterns

Canonical architecture reference for AI agents working in this repo. Read this before
codebase exploration, broad refactors, or architecture-impacting changes, and update
it whenever architecture or ownership boundaries change.

Depth lives elsewhere: [DeveloperGuide.md](../DeveloperGuide.md) explains *why* each
decision was made, [README.md](../README.md) is the operator runbook. This file is the
map.

## Three independent intakes

The repo holds three pipelines that share a spreadsheet and — since the web app grew
extra routes — one router. Otherwise they stay independent: no intake module imports
another, and a change to one cannot break another.

| Pipeline | Entry point | Lands in |
|---|---|---|
| Parade state (AI) | `src/parser/Parser.js` — `handlePost` (primary), plus installable `onEdit` and `onFormSubmit` triggers | `Parade State Responses` → `Strength Data`, `Personnel Data`, `Command Roster` |
| Report sick (FormSG) | `src/formsg/FormSgSheet.js` — `handlePost` | `Report Sick FormSG Responses` |
| WhatsApp relay | `whatsapp/src/index.js` — a long-running Bun process | POSTs to the parade-state route above |

One route reads rather than writes: `src/dashboard/DashboardFeed.js` serves the three
parade-state tabs and the FormSG tab back out to `dashboard/`. See *The dashboard is a
read-only consumer*.

**One `doPost`, routed explicitly.** Apps Script allows a single `doPost` per project,
and three callers need it. `src/WebApp.js` owns the global and dispatches on a `route`
query parameter — `?route=reportsick` to FormSG, `?route=paradestate` to the parade
state pipeline, `?route=dashboard` to the read-only feed. An unrouted or unknown
request is **rejected**, never defaulted: `ContentService` cannot set a status code, so
a body accepted by the wrong handler would write wrong rows to the wrong tab and still
answer 200.

`WebApp.js` is therefore the one file that knows all three exist. That is the whole of
the coupling, and it is deliberately confined to a file with no logic of its own.

## Three ways into the parade-state pipeline

All three converge on `Parser.processRow(rowIndex, previousId)`:

- **`handlePost`** — the WhatsApp bridge relays a message; the row is appended and
  processed in one execution. This is the primary intake. A redelivery whose row is
  still blank (a first delivery that never finished) is reprocessed in the same
  execution rather than dropped.
- **`onEditHandler`** — clearing a row's `parade_response_id` by hand forces a re-run.
  This is the manual override, and it needs no editor access. `reprocessPendingRows`
  (Sheets menu macro) is the capped batch equivalent for every still-blank row.
- **`onFormSubmitHandler`** — the Google Form, kept as a fallback. It needs its own
  trigger because a Form submission does not fire `onEdit`.

Why the bridge posts rather than writing the sheet through the Sheets API: **installable
triggers do not fire for API requests**. A direct write would land the row and trigger
nothing, which is the constraint that originally forced the Form hop.

## The row is the state

The parade-state pipeline keeps **no** status ledger, no retry budget, and no error
tab. One column carries every outcome:

| `parade_response_id` | Meaning |
|---|---|
| empty | Due for processing |
| empty, `error` = `Processing...` | A run started and did not finish; still due |
| `Archer_2026-06-22_FPS` | Processed; output rows exist under that key |
| `ERROR` | Failed; the reason is in the `error` column on the same row |

`processRow` stamps `Processing...` into `error` before extraction; every completed run
overwrites `error` again, so that marker survives only a killed run and the row stays
due. Clearing the cell by hand is the manual reprocess gesture; the
`reprocessPendingRows` menu macro is the capped batch equivalent for every still-blank
row at once (it does not retry `ERROR` rows). An AI failure and a validation
failure are the same outcome, because the operator's next move is the same either way —
which is why there is no separate "needs review" state and no `logRef` placeholder for
an error written somewhere other than the row that caused it. A script write does not
fire `onEdit`, so writing the id back does not loop.

Two consequences worth knowing before changing anything here, both learned the hard way:

- **`onEdit` passes the cleared id through** as `previousId`. A corrected message can
  process to a *different* key, and without this the old key's output rows are orphaned
  in all three tabs with nothing pointing at them. Apps Script supplies `e.oldValue`
  only for a single-cell edit, which is exactly this gesture.
- **Deleting a duplicate response row shifts the current row's index.**
  `deleteDuplicateRawResponses_` returns how many rows above it removed, and the caller
  subtracts that before writing the outcome. Without it the key lands one row too low,
  onto whatever submission happens to be there. For the same reason `reprocessPendingRows`
  walks its due rows bottom-up, so a duplicate deleted during one row's run never shifts a
  row still to be visited.

## Runtimes

Two, and the boundary between them matters more than it looks.

**Google Apps Script** (`src/`) — V8, but not Node. No modules, no `import`/`require`,
no npm, no `TextDecoder`, no build step. Every file shares **one global lexical
scope**, which is how `FormSgSheet` reaches `FORMSG_COLUMNS` and `ParserSheets` reaches
`RAW_RESPONSES_COLUMNS` with no import. Class
static methods cannot be invoked by Apps Script directly, so each editor entry point
and trigger handler is a plain top-level `function` that delegates to one.

Deployed with `bunx clasp push`. `.clasp.json` sets `rootDir: "src"`, so **`src/` is
the deployment boundary** — anything under it ships, anything outside it does not.
That is why `test/` sits at the repo root.

**Bun** (`whatsapp/`, `test/`) — ESM, npm, `bun test`. Ordinary Node-shaped code.

## The dashboard is a read-only consumer

`dashboard/` is a static site — plain ES modules, no build step — served to GitHub Pages
by `.github/workflows/pages.yml`. It is the spreadsheet's fourth party, and the only one
that never writes to it.

It has a server half, and the split is the point. `dashboard/` cannot hold a credential —
it is a public page — so it holds none: `src/dashboard/DashboardFeed.js` is the third
route on the existing web app (`?route=dashboard`), it opens the sheet as the deployment's
owner, and it checks the `DASHBOARD_PASSWORD` script property before reading a row. The
browser half knows a URL and whatever the viewer typed; the decision about whether that is
enough is made where the viewer cannot reach it.

That is why the spreadsheet can stay private with no sharing list to maintain, and it is
the reason the alternative was rejected: a password checked in the page would need the
tabs published to be reachable at all, and a published tab is readable by URL whether the
check passes or not.

The boundary stays one-way and strict: **the dashboard reads the sheet and nothing else**.
`dashboard/` does not import from `src/`, is not deployed by clasp, and holds no secret;
`src/dashboard/` writes no cell and neither intake imports it. Deleting either half leaves
the three intakes untouched.

Two consequences of that direction:

- **Columns are resolved by header name at read time**, not by fixed index. `src/` owns
  the layout and refuses a sheet whose header does not match; a read-only consumer can
  afford to tolerate a column being added or reordered, but not to read `reason` out of
  the `location` column. `test/dashboard/schema.test.js` asserts every header the
  dashboard requires still exists in the canonical `*_COLUMNS` arrays, so an upstream
  rename fails a test instead of shipping a blank chart.
- **`dashboard/` is a deployment boundary**, exactly as `src/` is for clasp: everything
  inside it is published. So its tests live in `test/dashboard/`, and its fixtures are
  built by running the real `ParserRows` over the labelled messages in
  `parade-state-example/` — the rows under test cannot drift from the rows the parser
  writes, because the parser writes them.

- **The three category views are one renderer, not three.** MC, report sick and status
  ask the same four questions — trend, company, platoon, who most often — so
  `views/category.js` answers them once and is parameterised per category. Three
  renderers would drift into three layouts panel by panel, and the whole value of the
  arrangement is that a commander learns it once and reads it three times.
- **Chart colour is validated, not chosen.** The categorical palette is capped at four
  slots because that is what clears the adjacent CVD gates on this surface; forms where
  any two series can be compared directly are capped at three. A composition chart is
  drawn only where the parts genuinely sum to the whole it names, which is why the
  employability donut has three slices and the absence breakdown is a bar chart.
- **A date crosses the boundary as text, in the spreadsheet's timezone.**
  `DashboardFeed.toJsonValue_` formats it; `JSON.stringify` would render a Date in UTC and
  slide every Singapore parade state back a day. That failure mode errors nowhere — the
  numbers simply land on the wrong date — so it is pinned at the boundary, in
  `test/dashboard.feed.test.js`.

Data never leaves the viewer's browser: it goes from the feed to the page and no further.
There is no service account, no published CSV, no committed snapshot, and nothing
sensitive in the Pages artifact — which is why this consumer can be public while the data
behind it is not. What the shared password costs is identity: it authorises without
identifying, so there is no per-viewer revocation and no record of who looked. That was
chosen knowingly over Google sign-in, which offered both but required a Cloud project, a
consent screen and a test-user list to keep in sync.

## Ownership boundaries

`src/parser/ParserSchema.js` owns the parade-state schema; `src/formsg/FormSgColumns.js`
owns the FormSG schema. Neither reads the other. The duplication (two sheet-getters, two
column arrays) is deliberate: it is what lets either module be lifted out whole.

Within the parade-state pipeline the dependency direction is strictly one-way:
`Parser` → {`ParserSheets`, `ParserAi`, `ParserRows`} → `ParserSchema`. Nothing depends
on `Parser`.

There is no migration code and no one-time code anywhere in `src/`. Schema changes to a
live spreadsheet are applied by hand — see `test/MANUAL_CHECKS.md` — because a migration
that has already run everywhere is dead weight that still has to be read and understood
by whoever comes next.

## Recurring patterns

**Static-class-as-namespace.** Every service is an ES6 class with only static methods
and `_`-suffixed private helpers. There is no per-instance state anywhere.

**`src/` holds execution code only.** No setup functions, no diagnostics, no
`verifySetup`, no `listInstalledTriggers`. What such a function used to check now
happens on the path that needs it: script-owned tabs are created with their header row
on first write (`ParserSchema.sheet_`, mirroring `FormSgSchema.sheet`), a missing API
key throws from `ParserAi` onto the row, and a missing token fails closed. Anything that
only *verifies* lives in `test/`. There is deliberately no `setup()` to paste live
secrets into — script properties are set in the editor's Project Settings.

**Column arrays are the single source of truth.** `FORMSG_COLUMNS` and
`ParserSchema.js`'s arrays define sheet layout; header rows are derived from them, never
the reverse.

**A sheet with data under a wrong header is refused, never rewritten.**
`FormSgSchema.verify` will not relabel rows from a spec that may itself be wrong, and
`ParserSheets.readText` goes further for the Form-owned `Parade State Responses`: on a
header mismatch it logs the expected and actual header and writes **nothing at all**.
With a wrong header every column index is meaningless, so writing an error into what we
believe is the `error` column could overwrite real data. The log is the only safe
channel, and it doubles as the operator's instruction.

**Every mutating sheet write holds a `LockService` lock**, spanning read-then-write so
concurrent executions cannot both decide a row is new.

**Idempotency by stable id.** Both intakes dedupe on an id column before appending,
because both can receive the same payload twice — see DeveloperGuide.md §8.3 for the
Apps Script 302 behaviour that makes this mandatory rather than defensive. FormSG keys
on `Response ID`; the WhatsApp relay keys on `wa_message_id`, the Baileys message id.
Both hold the lock across the read-then-append. A redelivery no longer drops
unconditionally: if the matched row is still blank — a first delivery whose `processRow`
was killed mid-run — `handlePost` reprocesses it, so the resend is the recovery path; a
row already holding a key or `ERROR` is skipped as before.

**Permanent vs transient failure.** `ContentService` always answers 200 and no status
code can be set, so handlers signal by control flow instead: log and return 200 for
anything a retry cannot fix; **throw** for transient failures, since that is the only
way to make Apps Script emit a 5xx and get retried. Note that a failed *extraction* is
not an endpoint failure — it is recorded on the row, and the caller is told the relay
succeeded, because resending would only fail the same way.

**Read what the message says; derive nothing.** The prompt asks only for values present
in the text, and `ParserRows` computes none. This is not fastidiousness: the labelled
examples contain entries whose stated day-count disagrees with their own date range, and
overnight duties spanning two dates that count as one day, so a derived `num_days` would
be wrong precisely where it fired. `in_camp` is likewise never inferred from a location
name. See `ParserRows`' header for the full argument.

## Testing

`bun test ./test/ ./whatsapp/test/` from the repo root runs everything, with no Google
account and no API key involved. `test/` covers the Apps Script side and, under
`test/dashboard/`, the dashboard's model layer; `whatsapp/test/` covers the bridge.

`test/harness.js` concatenates a source directory into one `node:vm` script —
reproducing Apps Script's single shared global scope — and stubs the Google globals. It
also shares the host realm's intrinsics into the context, so `value instanceof Date`
behaves as it does in Apps Script's single realm. Three loaders:

- **`loadFormSg()`** — `src/formsg/*.js` plus `src/WebApp.js`. The parade-state pipeline
  and the dashboard feed are recording stubs here, which is all that is needed to prove
  `WebApp.js` routes to them (`test/router.test.js`). Routing is worth testing precisely
  because a mistake there fails invisibly.
- **`loadParser()`** — `src/parser/*.js` with in-memory sheets. Only the network is
  faked: `ParserSheets`, `ParserRows` and `ParserSchema` all run for real, so a write to
  the wrong column shows up as a wrong cell rather than a passing mock. Tests replace
  `ParserAi.extract` per case, which works because Apps Script resolves these bindings
  through the shared global scope at call time.
- **`loadDashboard()`** — `src/dashboard/*.js` plus `src/WebApp.js`, the mirror image of
  `loadFormSg`: the real feed, with both intakes stubbed. Its `Utilities.formatDate` fake
  uses a fixed offset per zone and **throws on a zone it does not know**, rather than
  falling back to UTC — a fallback would turn a timezone bug in the code under test into
  a passing test.

The pattern to preserve: **the Apps Script sources need no test-only modification**.
No exports, no module wrapper, no bundler between the editor and the deployed script.

Two things in `test/` are not `bun test` files:

- **`parser.eval.js`** scores extraction against the labelled messages in
  `parade-state-example/` and prices it (`bun run eval`, `--sweep` for several models
  cheapest-first). It makes real API calls, which is why it is not a `*.test.js`. Its
  tiered accuracy bar is what makes a model change a measured decision rather than an
  argument; `parser.eval.test.js` tests the scorer itself, because an instrument stuck
  at 100% would bless anything.
- **`MANUAL_CHECKS.md`** is the post-deploy checklist for what cannot be automated.

`parade-state-example/*-struct.json` are hand-labelled ground truth, and
`parser.rows.test.js` runs `validate` over all five so the labels and the validator
cannot drift apart. When editing them the governing rule is the prompt's own: **never
record a value the message does not state.** An audit against that rule removed 35
inferred `in_camp` labels.

## Third-party boundaries

Decryption of FormSG submissions is **not** done in this repo. Plumber
(plumber.gov.sg) holds the form secret key, decrypts, and relays plaintext JSON to
`doPost`. Consequently `src/` contains no cryptography and no key material.

Every web-app route is gated by its own shared secret in the request body, checked
fail-closed against its own script property — `WHATSAPP_INGEST_TOKEN` for
`?route=paradestate`, `FORMSG_INGEST_TOKEN` for `?route=reportsick`,
`DASHBOARD_PASSWORD` for `?route=dashboard`. They are separate so any one route's
secret can be rotated alone. A shared secret is the ceiling of what is possible here:
Apps Script cannot read request headers, so an HMAC over the body — or verifying
FormSG's `X-FormSG-Signature` — is not an option. See DeveloperGuide.md §8.4.

The dashboard route is the one where a correct guess is worth something: the two ingest
secrets protect against junk rows and API spend, while it protects names and medical
reasons. So it alone counts failures and locks itself, and it alone is a password a
person types rather than a token a machine holds — which is why the guidance beside it
is about passphrase length. It remains a shared secret, so it authorises without
identifying: no per-viewer revocation, no record of who read what.

If you are tempted to add crypto (as opposed to a shared secret) to `src/`, read
DeveloperGuide.md §8.1 first: that is exactly what was removed, and why.

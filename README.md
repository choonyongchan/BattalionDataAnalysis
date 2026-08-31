# Strength Tracker

A Google Apps Script system that turns Google Form parade-state submissions
into structured attendance data. A company clerk fills out a Google Form
with a single question — paste the parade state text as-is — and the moment
they submit, a trigger asks OpenAI to identify which company, date, and
parade session (first/last) the message belongs to, then extract company +
per-platoon strength figures and every personnel entry (Att C/MC, Report
Sick, Status, Off/Leave, MA, Others) from the free text, and writes the
result to "Strength Data", "Personnel Data" and "Command Roster" sheets.
Anything the AI can't confidently identify or parse, and anything that fails
outright, is recorded **on the submission's own row**: `parade_response_id`
reads `ERROR` and the reason sits beside it in `error`. Nothing is ever
silently dropped, and there is no separate error tab to go looking in. A
duplicate submission for the same company+date+parade-session replaces the
earlier one everywhere. The dashboard in `dashboard/` reads from "Strength
Data"/"Personnel Data" directly.

The row is the whole of the system's state, which is worth knowing before
anything else:

| `parade_response_id` | What it means |
|---|---|
| empty | Not processed yet |
| empty, with `error` = `Processing...` | A run started and didn't finish — still not processed |
| `Archer_2026-06-22_FPS` | Processed; its rows are in the output tabs under that key |
| `ERROR` | Failed — read `error` on the same row |

**Clearing that cell by hand is how you re-run a submission.** Fix the
message text, clear the id, and it processes again within seconds. To re-run
every still-blank row at once, run **Extensions → Macros → reprocessPendingRows**.

This is the **user guide**: setup and day-to-day operation. It assumes no
prior Apps Script experience. If you're a developer looking to understand or
extend the system's architecture, see [DeveloperGuide.md](DeveloperGuide.md)
instead.

## 1. Prerequisites

- Edit access to the Google Sheet this project is bound to.
- An OpenAI API key:
  1. Go to the [OpenAI API keys page](https://platform.openai.com/api-keys).
  2. Create an API key.
  3. Copy it.
- [`clasp`](https://github.com/google/clasp) installed, if you want to sync
  code locally instead of editing directly in the Apps Script browser editor
  (see [Appendix: syncing with clasp](#appendix-syncing-with-clasp)).

## 2. Create and link the Google Form

1. Create a new Google Form with exactly one question, with this exact
   title (the bookkeeping code matches on title, not position):
   - **Drop your Parade State here** — paragraph (long answer) text.
   The clerk pastes the parade state message in as-is — no need to also
   pick a company, date, or parade session, since the AI identifies all of
   that from the message text itself (see [DeveloperGuide.md](DeveloperGuide.md)
   for why).
2. In the Form editor, go to **Responses → Link to Sheets** and create (or
   link) the Google Sheet this project is bound to. Google Forms will
   auto-create a sheet tab — rename that tab to exactly **Parade State Responses**.
3. In **Parade State Responses**, the Form owns columns A–B (Timestamp + the one
   question). Add three more header cells after those, in columns C–E, so
   the full header row reads exactly:
   `Timestamp, Drop your Parade State here, wa_message_id, parade_response_id, error`
   The first two are written by the Form; the last three are this script's
   own bookkeeping and the Form will never touch them.

   `wa_message_id` is the WhatsApp bridge's dedup key (§9). It stays blank on
   rows that arrive through the Form.

   The script will never rewrite this header for you — the tab is Form-linked,
   and relabelling populated columns from a wrong spec is worse than reporting
   the mismatch. If the header doesn't match, processing stops before writing
   anything at all and logs both the expected and the actual header under
   **Executions**. With a wrong header every column position is untrustworthy,
   so writing an error into what it *believes* is the `error` column could
   overwrite real data.

> **Upgrading an existing spreadsheet?** Delete the old `processed_status`,
> `process_attempts`, `last_error` and `processed_at` columns and add `error`,
> then delete the **Parade State Errors** and **Report Sick FormSG Errors**
> tabs — nothing writes either any more. There is no migration function to run;
> a migration that has already run everywhere is dead weight. See
> [`test/MANUAL_CHECKS.md`](test/MANUAL_CHECKS.md).

## 3. One-time script setup

1. Open the bound Google Sheet → **Extensions → Apps Script**. Confirm you see
   the project files: a `parser/` folder (`Parser.js`, `ParserAi.js`,
   `ParserRows.js`, `ParserSchema.js`, `ParserSheets.js`), a `formsg/` folder,
   `WebApp.js`, and `appsscript.json`.
2. Go to **Project Settings** (the gear icon) → **Script Properties** → *Add
   script property*, and add your OpenAI key under the name `OPENAI_API_KEY`.
   Add `WHATSAPP_INGEST_TOKEN` and `FORMSG_INGEST_TOKEN` too if you are using
   those intakes (§8, §9).

   There is deliberately no `setup()` function to paste secrets into and then
   remember to delete — that pattern's whole failure mode is forgetting the
   second half and committing a live key.
3. That's the entire setup. The **Strength Data**, **Personnel Data** and
   **Command Roster** tabs are created with their header rows the first time a
   submission is processed, so you don't need to create them or run a check
   function. Just make sure **Parade State Responses** exists with the header
   row from step 2.3 above.

   `parade_response_id` starts blank on every row — it's filled the first time
   a row is successfully processed.

## 4. Install the real-time processing triggers

1. In the script editor, select `installTriggers` in the function dropdown and
   click **Run**. Grant any permissions it asks for (this is the step that
   authorizes the script to call the OpenAI API).
2. Confirm it worked: click the **Triggers** icon (the clock) in the left
   sidebar. You should see `onFormSubmitHandler` and `onEditHandler`.
3. Re-running `installTriggers` at any time is safe — it removes any existing
   copies first, so it never creates duplicates.

What each one is for:

| Trigger | Fires when | Why |
|---|---|---|
| `onFormSubmitHandler` | The Google Form is submitted | The manual fallback path |
| `onEditHandler` | A row's `parade_response_id` is cleared by hand | Forces a re-run of that parade state, with no editor access needed |

The **primary** intake needs no trigger: the WhatsApp bridge POSTs to the web
app, which appends the row and processes it in the same execution (§9). Neither
trigger fires for that, and neither would fire for a Sheets-API write —
installable triggers do not run in response to API requests.

## 5. Verify it works end-to-end

1. Submit the real Google Form once, with any parade-state text pasted into
   the free-text box.
2. Within a few seconds, check **Parade State Responses** — the new row's
   `parade_response_id` should read something like `Archer_2026-07-18_FPS`,
   with `error` blank. That id is the AI's read of the company, date and
   session straight from the message text. If it reads `ERROR` instead, the
   reason is in `error` beside it.
3. Check **Strength Data** for a company-total row plus one row per platoon
   the AI found, **Personnel Data** for one row per person listed, and
   **Command Roster** for the message's command team (empty if it lists none).
4. Submit the Form again with the *same* message (same company, date, and
   parade session it identifies) — the earlier Parade State Responses row and
   its Strength Data/Personnel Data rows should be gone, replaced by the new
   submission's rows (no duplicates).

## 6. Day-to-day operation

- **To add a submission**: have the clerk fill out and submit the Google
  Form. Nothing else is needed — processing happens automatically within
  seconds.
- **To find failures**: filter **Parade State Responses** on
  `parade_response_id = ERROR`. The `error` column beside it says why, in one
  line, next to the exact text that caused it. Both kinds of failure land the
  same way, because your next move is the same either way:
  - *The AI couldn't identify or extract the submission* — an unrecognized
    company, an undeterminable date or parade session, non-numeric strength
    figures, a personnel entry missing a name or reason. Usually the message
    text genuinely doesn't state it clearly.
  - *An outright failure* — API error, unparseable response, expired key,
    quota exceeded.
- **To reprocess a submission**: fix the message text in the row if it needs
  fixing, then **clear the `parade_response_id` cell**. That's it — the row
  re-runs within seconds and the cell refills itself. This works on `ERROR`
  rows and on successful rows alike, and needs no editor access.

  Clearing up to 20 at once is fine; above that nothing runs and the reason is
  logged, because each row costs an API call. To drive one row from the editor
  instead, run `reprocessRow(rowIndex)` from the function dropdown. To re-run
  every row that is still blank (including one stuck showing `Processing...`
  after an interrupted run), run **Extensions → Macros → reprocessPendingRows** —
  same 20-row cap, and it leaves `ERROR` rows alone.
- **To rotate the OpenAI API key**: edit `OPENAI_API_KEY` under **Project
  Settings → Script Properties**. No code change, no redeploy.
- **Dashboard**: [`dashboard/`](dashboard/README.md) is a static site served from
  GitHub Pages that reads **Strength Data**, **Personnel Data**, **Command Roster**
  and the FormSG tab. It reads them through `?route=dashboard` on this project's own
  web app, behind one shared password in the `DASHBOARD_PASSWORD` script property —
  so the spreadsheet stays private and nothing is published. Five views: **Today** (the
  parade snapshot), then **MC**, **Report sick** and **Status** — each asking the same
  four questions, trend to company to platoon to who-most-often — then **Soldier**. It
  covers what Looker Studio cannot: rates per 100 pax-days by platoon, daily snapshots
  collapsed into episodes, and per-soldier history. See
  [`dashboard/README.md`](dashboard/README.md) for the two-step setup.
  Looker Studio can still be pointed at the same sheets alongside it.
- **To rotate the dashboard password**: edit `DASHBOARD_PASSWORD` under **Project
  Settings → Script Properties**. No code change, no redeploy.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A Form submission never gets processed | The `onFormSubmitHandler` trigger isn't installed | Check the Triggers panel (clock icon); re-run `installTriggers` |
| A WhatsApp relay returns `unknown_route` | `APPS_SCRIPT_URL` already carries a query string, or is not the `/exec` URL | The bridge appends `?route=paradestate` itself — `APPS_SCRIPT_URL` must have no query string |
| The dashboard says the password is not right, and it is | The `DASHBOARD_PASSWORD` script property is unset or disagrees, or the web app was never redeployed after the route was added | Set the property under **Project Settings → Script Properties**; redeploy the web app (`clasp push` alone does not publish a new route). Fails closed by design |
| The dashboard says the feed replied with something other than data | `FEED_URL` is missing `?route=dashboard`, or points at a deployment that no longer exists | Check `FEED_URL` in `dashboard/js/config.js` against **Deploy → Manage deployments** |
| The dashboard is locked out | Ten wrong passwords inside fifteen minutes | Wait fifteen minutes. If nobody was mistyping, treat it as someone guessing and rotate the password |
| A WhatsApp relay returns `unauthorised` | `APPS_SCRIPT_TOKEN` and the `WHATSAPP_INGEST_TOKEN` script property disagree, or the property was never set | Set the property under **Project Settings → Script Properties**, then match it in `whatsapp/.env`. The endpoint fails closed by design |
| Report-sick rows suddenly stopped arriving | Plumber's URL is missing `?route=reportsick`, **or** its body is missing the `token` field, **or** the `FORMSG_INGEST_TOKEN` script property is unset or disagrees | Apps Script always answers 200, so Plumber records these as successes — check **Executions** for the logged `unknown_route` / `unauthorised`. Add the route parameter (§8.2), add `"token"` to the body (§8.3), and set the property to match. Fails closed by design |
| Clearing `parade_response_id` doesn't reprocess the row | The `onEditHandler` trigger isn't installed, or more than 20 rows were cleared at once | Run `installTriggers`; for a bulk re-run, clear them in batches of 20 or fewer |
| Nothing processes at all, and **Executions** logs a header mismatch | Bookkeeping columns weren't added, or the Form's question title was changed | The log names the expected and the actual header — make the sheet match (see section 2.3). If the Form question title changed, either revert it or update `RAW_RESPONSES_COLUMNS` in `parser/ParserSchema.js` |
| `error` says "company/date/session could not be determined" | The message text genuinely doesn't state that field clearly enough, or uses unusual wording | Have the clerk resubmit with clearer text; if it's a recurring wording pattern, add a rule to `ParserAi.buildPrompt_()` and confirm it helped against real messages |
| `error` mentions an HTTP status or "after 2 attempts" | Invalid/expired API key, or quota exceeded | Check `OPENAI_API_KEY` in Script Properties and your usage/quota in the OpenAI dashboard, then clear the row's `parade_response_id` to retry |
| `error` names `OPENAI_API_KEY` | The script property was never set | Add it under **Project Settings → Script Properties** |
| A row keeps its blank `parade_response_id` and nothing happens | The row has no message text; `onEditHandler` isn't installed; or a run was interrupted (look for `Processing...` in `error`) | Blank rows with no text are skipped on purpose so an empty row never costs an API call; otherwise check the Triggers panel, or run **Extensions → Macros → reprocessPendingRows** to sweep every still-blank row |
| Resubmitting the Form doesn't replace the old rows | The two submissions' text doesn't resolve to the same company+date+session (e.g. different wording the AI read differently), or the earlier row never successfully processed in the first place (so it has no `parade_response_id` to match against) | Check both rows' `parade_response_id` cells in Parade State Responses — they must be identical for dedup to trigger; a blank `parade_response_id` on the old row means it never succeeded and won't be found by the dedup scan |
| Duplicate rows in Strength Data/Personnel Data for the same key | Should not happen by design | Report as a bug — likely a lock failure or a key-computation mismatch; don't manually delete rows before investigating |

## 8. FormSG intake (optional, independent of everything above)

A second, self-contained way to get data into this spreadsheet:

```
FormSG  ->  Plumber  ->  this script  ->  Report Sick FormSG Responses
            (decrypts)
```

[FormSG](https://form.gov.sg) collects each submission and encrypts it.
[Plumber](https://plumber.gov.sg), the same agency's automation tool, decrypts it and
forwards it here as plain JSON. This script's only job is to map that JSON onto a row.

**This is a separate dataset, not a second way to fill Parade State Responses.**
FormSG submissions land in the **Report Sick FormSG Responses** sheet, and the AI
parade-state pipeline never sees them. Sections 1–7 keep working exactly as before
whether or not this is set up.

Rows are written in **exactly the layout FormSG's own CSV export uses**, into the
same sheet that export is pasted into. That is the whole point of the design: a
webhook row and an imported row are indistinguishable, so the two intake paths are
interchangeable and can be mixed freely.

Because Plumber holds the form's secret key, this Apps Script project stores **no
secrets and no script properties** — there is nothing to paste in, and nothing to
rotate.

### 8.1 Create the form

Create the form on [form.gov.sg](https://form.gov.sg) in **Storage mode** — Email
mode has no webhook. FormSG shows the form's **secret key once, at creation**. Save
it somewhere safe: Plumber needs it, this script does not.

### 8.2 Deploy the web app

In the Apps Script editor: **Deploy → New deployment → Web app**, with

- **Execute as:** Me
- **Who has access:** Anyone

Copy the deployment URL — the one ending in **`/exec`**. The `/dev` URL only runs for
the signed-in owner and will hand Plumber a Google sign-in page instead.

> **The URL Plumber uses must end `/exec?route=reportsick`.** One `doPost` now serves
> two intakes, so the route is named explicitly and an unrouted request is rejected.
> A request without the parameter is answered 200 (Apps Script cannot do otherwise),
> so Plumber would record every delivery as a success while no rows arrived — the
> script logs that case by name.
>
> Adding the parameter is safe to do *before* deploying: the previously-live code
> ignores unknown query params, so it is a no-op until the deploy, and doing it in
> that order leaves no gap where report-sick intake is dead.

Anonymous access is required because Plumber cannot authenticate to Google. In front
of that, the report-sick route carries a shared token: Plumber must send a `token`
field in the body matching the `FORMSG_INGEST_TOKEN` script property, or the request
is rejected as `unauthorised`. Set that property (Project Settings → Script
Properties) to any long random string *before* deploying, and mirror it in the
Plumber body (§8.3) — the route fails closed, so a wrong order silently drops intake.
See [DeveloperGuide.md](DeveloperGuide.md) §8.4. The parade-state route (§9) carries
its own separate token.

**This URL goes into Plumber, never into FormSG's own webhook field.** FormSG posts an
encrypted payload this endpoint cannot read, and because Apps Script always answers
200, FormSG would record every delivery as successful while no rows arrived. The
script logs that case by name if it happens.

### 8.3 Wire up Plumber

Create a pipe on [plumber.gov.sg](https://plumber.gov.sg) with two steps:

1. **Trigger — FormSG › New form submission.** Select the form and paste its secret
   key. Plumber decrypts submissions from here on.
2. **Action — Webhook › Make a POST request.** Point it at the deployment URL from
   §8.2, content type JSON, and build the body below by dragging Plumber's variable
   pills into the value slots:

```json
{
  "token": "<the FORMSG_INGEST_TOKEN value>",
  "submissionId": "{{Submission ID}}",
  "submittedAt": "{{Submission Time}}",
  "answers": {
    "RANK": "{{1}}",
    "[Myinfo] Name": "{{2}}",
    "4D Number (REC Only)": "{{3}}",
    "Unit & Coy": "{{4}}",
    "Report Sick Type": "{{5}}",
    "Reason for Reporting Sick (Keep Brief)": "{{6}}",
    "I am experiencing _____________________ symptoms.": "{{7}}",
    "My symptoms are genuine and I have updated my Commander of my condition.": "{{8}}",
    "SingPass Validated NRIC": "{{NRIC/FIN (Verified)}}"
  }
}
```

`token` is a fixed literal, not a pill — paste the same string you set as the
`FORMSG_INGEST_TOKEN` script property. The remaining keys on the left are **this
sheet's column headers**; the pills on the right are Plumber's variables, numbered by
question. The two sides differ where the sheet's
header differs from the question text — question 2 is labelled `Name` in FormSG but
`[Myinfo] Name` in the sheet — and this mapping is where that translation happens.

Use Plumber's **test step** to send one submission through, then check §8.6.

### 8.4 The column layout

`FORMSG_COLUMNS` in `src/formsg/FormSgColumns.js` is the single source of truth for
the sheet's shape. Three columns come from the request envelope rather than from an
answer:

| Column | Source |
|---|---|
| `Response ID` | `submissionId` — also the dedup key, so it must stay first |
| `Timestamp` | `submittedAt`, written as a real Date |
| `Download Status` | the constant `Success`, matching the CSV export |

Every other header is looked up **verbatim** in the payload's `answers` object.

**To add a question to the form:** add its header to `FORMSG_COLUMNS` in the position
the CSV export puts it, then add the matching line to the Plumber body in §8.3. Miss
the second step and the column stays blank.

`Masked NRIC` is CSV-only: Plumber exposes just the full verified NRIC, so webhook
rows leave that cell blank. The column exists so pasted CSV rows still line up.

### 8.5 Importing a CSV export

FormSG's CSV export stays the authoritative record. To refresh from it:

1. Clear **Report Sick FormSG Responses** and paste the full export, header included.
2. Run **Extensions → Macros → formSgNormaliseTimestamps**.

Step 2 is not optional. Depending on how the paste lands, Google Sheets either
parses FormSG's `07 May 2026 19:21:00` timestamps into real dates or leaves them as
plain text — and a column that is half one and half the other will not sort, and
Looker Studio will not read it as a date. The macro converts any text timestamps it
finds, leaves real dates alone, and reports anything it could not parse. It is safe
to run at any time and safe to run twice.

Between imports the webhook simply appends new rows in the same format.

### 8.6 Day-to-day

- **After changing anything under `src/formsg/`**: `bunx clasp push`, then **deploy a
  new version**. A push alone does not change what the endpoint serves.
- **To check the sheet is still in shape**: run `formSgVerifySetup` from the editor.
  It confirms the tab exists and its header matches `FORMSG_COLUMNS`, and refuses to
  rewrite a header row that has data underneath it.
- **Duplicates**: the script deduplicates on `Response ID` under a script lock, so a
  Plumber retry cannot produce a second row.
- **Failures**: Plumber's execution history shows any step that failed. On this side,
  **Executions** in the Apps Script editor shows what `doPost` logged. There is no
  errors tab on either intake — the old **Report Sick FormSG Errors** tab was never
  written by this code and should be deleted.
- **Local tests**: `bun test ./test/ ./whatsapp/test/` runs everything with no Google
  account and no API key involved.

### 8.7 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Plumber reports the webhook step failed, but the row appears anyway | Apps Script answers POSTs with a 302 redirect, which some clients count as a failure even though the script already ran | Harmless — dedup prevents duplicate rows |
| The `Timestamp` column won't sort, or Looker Studio treats it as text | A CSV import pasted timestamps as text | Run `formSgNormaliseTimestamps` (§8.5) |
| One column is blank on every new row | That header has no matching line in the Plumber body | Add it in §8.3 — the sheet header and the Plumber key must match character for character |
| Every submission fails, and Executions shows `bad_request` | A free-text answer contained a quote or newline that broke Plumber's JSON body | Switch the Plumber action to a form-encoded body, or have it escape the field |
| `SingPass Validated NRIC` is blank | The form has no Singpass verification, or `NRIC/FIN (Verified)` is unmapped in Plumber | Check the Plumber trigger's sample data actually contains that variable |
| `Masked NRIC` is blank | Expected — it is CSV-only (§8.4) | Nothing to fix |
| `formSgVerifySetup` reports a header mismatch | The sheet's header and `FORMSG_COLUMNS` disagree | It will not rewrite a populated sheet's header on its own. Decide which side is right and fix it by hand |
| No rows arrive, and FormSG reports every delivery as successful | The web app URL was pasted into **FormSG's** webhook field instead of Plumber's. FormSG's payload is still encrypted and shaped differently, so it is rejected — but the 200 makes FormSG treat it as delivered | Check **Executions**: the log names this case explicitly. Clear the webhook field in FormSG and wire it through Plumber (§8.3) |
| Plumber gets Google's sign-in page back | The `/dev` deployment URL was used, which only runs for the signed-in owner | Use the `/exec` URL from **Deploy → Manage deployments** |
| Nothing happens at all | The web app was never deployed, or Plumber is pointed at an old URL | Deploy a **new version** (§8.6) and re-copy the URL into Plumber |
| A code change had no effect | Pushing is not deploying | Deploy a new version |

## 9. WhatsApp intake (primary, optional)

Companies post their parade state in a WhatsApp group and someone re-pastes it
into the Form. The `whatsapp/` module removes that manual step: it watches the
group, keeps only genuine first parade states, and relays them to this project's
web app.

```
WhatsApp group -> first-parade check -> POST ?route=paradestate -> append row -> processSubmission
   (Baileys)                                                  └── one Apps Script execution ──┘
```

The handler appends the *Parade State Responses* row **and** runs the pipeline in
the same execution, so an accepted message reaches *Strength Data* within seconds.

**This used to go through the Google Form, and no longer does.** The Form was a
pure relay, there only because `onFormSubmit` was the one trigger that fired
reliably: installable triggers do not fire for API requests, so writing the sheet
directly made nothing happen. Handling the POST removes the hop, the scraped
`entry.<digits>` id, and the script that discovered it. **The Form still works,
untouched, as a manual fallback** — §4 keeps its trigger installed.

### 9.1 Setup

1. Deploy the web app (§8.2) and copy the `/exec` URL into `APPS_SCRIPT_URL` in
   `whatsapp/.env`. Do not append a query string; the bridge adds
   `?route=paradestate` itself.
2. Generate a long random string. Put it in `APPS_SCRIPT_TOKEN` in
   `whatsapp/.env` **and** in the `WHATSAPP_INGEST_TOKEN` script property, under
   **Project Settings → Script Properties** (§3). The endpoint fails closed: if
   they disagree, or the property was never set, every request is rejected.
3. Add the `wa_message_id` column (§2.3) if you have not already.
4. Pair WhatsApp and find the group JID — see
   [`whatsapp/README.md`](whatsapp/README.md).

### 9.2 What gets relayed

Only **first** parade states, and only messages that clear two cheap gates: at
least 8 non-empty lines, at least 200 characters, and the phrase "parade state";
then either an explicit `FIRST PARADE` / `FPS` marker or a timing before 12:00 in
the header (the first 5 non-empty lines). `"Why is your parade state late?"`
carries the phrase but is one short line, so it is rejected. Last parade states
have neither marker nor morning timing, so they are dropped at the bridge and
never reach the sheet.

The bridge deliberately does *not* judge whether a message is really a parade
state beyond that. `ParserAi` and `ParserRows` already make that call by reading
the message, and anything that clears the gates but is not a parade state lands on
its own row as `ERROR` with the reason beside it — visible and reversible, unlike
a silent drop. (A six-signal layout score used to sit here and has been removed
for exactly that reason.)

### 9.3 Idempotency

The bridge keeps no local record of what it sent. The relay carries the Baileys
message id, the handler stores it in `wa_message_id`, and a repeat of the same id
is skipped without a second AI call.

That is where the dedup has to be: an Apps Script web app answers through a 302,
and following it re-sends the POST body, so one call can run the handler twice.
Nothing in the bridge could see that. Baileys redelivering after a reconnect is
the other cause, and one place that sees both beats two that each see one.

### 9.4 Forcing a re-run

Clear a row's `parade_response_id` cell in *Parade State Responses*. The `onEdit`
trigger (§4) picks that up and reprocesses the row. Useful after fixing a
message's text, or when a row is stuck. Clearing more than 20 at once is refused
and logged — each row costs an AI call.

WhatsApp has no official group API — Meta's Cloud API receives one-to-one
messages only — so the bridge uses the unofficial Baileys client, paired once by
QR code. If that risk becomes unacceptable, the durable alternatives are a
WhatsApp Business number on the Cloud API (companies DM the state instead of
posting it in the group) or Telegram's Bot API, which supports groups natively.

Full setup, hosting, and troubleshooting: **[`whatsapp/README.md`](whatsapp/README.md)**.

## Appendix: syncing with clasp

[`clasp`](https://github.com/google/clasp) is Google's CLI for pushing and
pulling Apps Script files, so you can edit `src/*.js` locally instead of in
the browser editor. It's already listed as a dev dependency in
`package.json` and can be run with `bunx clasp <command>` (or install it
globally with `bun add -g @google/clasp`).

1. **Log in** (one-time, opens a browser for Google OAuth):
   ```
   bunx clasp login
   ```
2. **Link this folder to a script project.** This repo doesn't ship a
   `.clasp.json` (it's environment-specific and left out of source control),
   so create it once:
   - If you already have an Apps Script project (e.g. the one bound to your
     Google Sheet), clone it. Get the script ID from the Apps Script editor
     URL: `https://script.google.com/.../projects/<SCRIPT_ID>/edit`.
     ```
     bunx clasp clone <SCRIPT_ID> --rootDir ./src
     ```
   - If you're starting from scratch, create a new standalone project
     instead:
     ```
     bunx clasp create --type standalone --title "Strength Tracker" --rootDir ./src
     ```
   Either command writes a `.clasp.json` pointing `rootDir` at `src/`.
3. **Sync files:**
   ```
   bunx clasp push          # push local src/ changes to Apps Script
   bunx clasp pull          # pull remote changes down into src/
   bunx clasp push --watch  # auto-push on every local save
   ```
4. **Other useful commands:**
   ```
   bunx clasp open   # open the script editor in your browser
   bunx clasp logs   # tail Stackdriver logs
   ```

Unlike a deployed web app, trigger-driven scripts pick up `clasp push`
changes immediately — no separate deployment step needed.

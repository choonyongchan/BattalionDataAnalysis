# Manual checks

The checks that cannot be automated, because they need the real spreadsheet, the real
deployment, or the real API. Everything else is in `bun test`; run that first.

Kept in `test/` beside the automated checks so the deploy procedure is versioned rather
than remembered. `test/` is outside the clasp deployment boundary (`.clasp.json` sets
`rootDir: "src"`), so nothing here ships.

## 0. Before deploying

```sh
bun test ./test/ ./whatsapp/test/     # must be green
bun run eval                          # scores the current model, costs money
```

`bun run eval` is excluded from `bun test` deliberately — it makes real API calls. See
[parser.eval.js](parser.eval.js) for the tiered accuracy bar and the cheapest-first
sweep (`--sweep a,b,c`).

## 1. One-time spreadsheet migration

There is no migration code — this is done by hand, once, per spreadsheet.

- [ ] On **Parade State Responses**, delete the columns `processed_status`,
      `process_attempts`, `last_error`, `processed_at`, and add a single `error` column
      after `parade_response_id`. Final layout, in order:
      `Timestamp | Drop your Parade State here | wa_message_id | parade_response_id | error`
      The first two are Form-owned and must keep their exact titles.
- [ ] Delete the **Parade State Errors** tab. Nothing writes it any more; failures are
      recorded on the response row itself.
- [ ] Delete the **Report Sick FormSG Errors** tab. Nothing has written it for some
      time.

The other three tabs need no action: `Strength Data`, `Personnel Data` and
`Command Roster` are created with their header rows on first write.

## 2. Script properties

Set in the Apps Script editor under **Project Settings → Script properties**. There is
no `setup()` function any more, deliberately — it required pasting live secrets into a
source file.

- [ ] `OPENAI_API_KEY`
- [ ] `WHATSAPP_INGEST_TOKEN` — must match `APPS_SCRIPT_TOKEN` in `whatsapp/.env`.

## 3. Deploy

- [ ] `bunx clasp push`
- [ ] **Deploy → New deployment.** A push alone does not change what `doPost` serves.
- [ ] Run `installTriggers()` once from the editor. Confirm on the **Triggers** page
      that exactly two exist: `onFormSubmitHandler` and `onEditHandler`.

## 4. The header guard

This is what replaced `verifySetup()`, so it is worth seeing fire once.

- [ ] **Before** doing step 1, run `reprocessRow(2)` from the editor. Expect: nothing
      written, and an execution log naming both the expected and the actual header.
- [ ] **After** step 1, run it again. Expect: the row processes.

## 5. The row contract

On a row holding a real parade-state message:

- [ ] **Fresh row.** Paste a message into a new row, leaving `parade_response_id` empty.
      Type anything into `parade_response_id` then delete it. Expect: the row processes,
      the key appears (e.g. `Archer_2026-06-22_FPS`), `error` is blank, and rows appear
      in all three output tabs.
- [ ] **Forced reprocess.** Clear `parade_response_id` on that row. Expect: the same key
      returns and the output rows are *replaced*, not duplicated — check the row count
      in Strength Data is unchanged.
- [ ] **Corrected message.** Edit the message text to change its date, then clear
      `parade_response_id`. Expect: the new key is written, and **no** rows remain under
      the old key in any of the three tabs. (This is the `previousId` path; it is the
      one thing that silently rotted in the old design.)
- [ ] **Failure.** Paste unreadable text into a new row and clear its
      `parade_response_id`. Expect: `parade_response_id` reads `ERROR`, `error` holds a
      readable reason, and nothing is written to the output tabs.
- [ ] **Recovery.** Fix that message, clear `ERROR` from `parade_response_id`. Expect:
      the row processes and `error` goes blank.
- [ ] **In-progress marker.** During a reprocess (a slow one, or watch closely), `error`
      briefly reads `Processing...` with `parade_response_id` still blank, then both
      settle to the outcome. A row left showing `Processing...` with a blank id is a run
      that was killed mid-flight.
- [ ] **Batch recovery.** Leave one or more rows with a blank `parade_response_id`, then
      run **Extensions → Macros → reprocessPendingRows** (or `reprocessPendingRows()` from
      the editor). Expect: every still-blank row processes; no "script function not
      found". Rows already at a key or `ERROR` are untouched.
- [ ] **Bulk-clear guard.** Select 25 `parade_response_id` cells and press Delete.
      Expect: nothing processes, and one execution-log line naming the 20-row cap.
      (Do this on rows you are willing to reprocess afterwards.)

## 6. The WhatsApp endpoint

- [ ] POST a real message body to `<web app URL>?route=paradestate` with the ingest
      token. Expect `{"ok":true,"appended":true,...}` and one new row, processed within
      the same execution.
- [ ] POST the **same** `messageId` again. Expect `{"ok":true,"appended":false,...}` and
      no second row. If the first row already processed to a key, expect no second AI
      call — this is the dedup that stops a Baileys redelivery or an Apps Script 302 from
      costing twice. If the first row is still blank (its run was killed), the redelivery
      reprocesses it instead of dropping it.
- [ ] POST with a wrong token. Expect `{"ok":false,"error":"unauthorised"}` and no row.

## 7. The FormSG route still works

Untouched by this change, but it shares the one `doPost`, so it is worth one check.

- [ ] Submit the real form, or POST a Plumber-shaped body to
      `<web app URL>?route=reportsick`. Expect one new row on
      **Report Sick FormSG Responses**.

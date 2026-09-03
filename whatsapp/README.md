# WhatsApp → Google Sheets bridge

Watches a WhatsApp group for first parade states, discards everything else, and relays the accepted messages to
the Apps Script web app that writes the spreadsheet.

```
WhatsApp group ─► first-parade check ─► POST ?route=paradestate ─► append row ─► Parser.processRow
   (Baileys)         (signature.js)      (appsScriptClient.js)     └── existing Apps Script project ──┘
```

The handler appends the *Parade State Responses* row **and** runs the pipeline in the same execution, so an
accepted message reaches *Strength Data* within seconds.

**This used to go through a Google Form.** The Form was a pure relay, there only because `onFormSubmit` was the
one trigger that fired reliably: an installable trigger does not fire for API writes, so writing the sheet
directly made nothing happen. Handling the POST removes the hop, the scraped `entry.<digits>` id, and the script
that discovered it. The Form still works, untouched, as a manual fallback.

## Why Baileys

WhatsApp has no official API for reading group messages: Meta's WhatsApp Cloud API only receives one-to-one
messages sent to a business number. Group ingestion therefore requires an unofficial client.
[Baileys](https://github.com/WhiskeySockets/Baileys) speaks the WhatsApp Web protocol directly over a
WebSocket — no Chromium, ~50 MB of memory — and is **event-driven** (`messages.upsert`), so no polling loop is
needed despite the absence of webhooks.

The account is paired once by QR code and the session is persisted to `auth/`, so restarts do not need another
scan. This is an unofficial client, so use a secondary number if you can; a ban is unlikely for read-only
traffic but not impossible.

### Sustainable alternatives

If the unofficial-client risk is unacceptable long-term, the durable options are:

| Option | Group support | Notes |
|---|---|---|
| **WhatsApp Cloud API** | ✗ | Official webhooks, but 1:1 only. Companies would DM the parade state to a business number instead of posting in the group. |
| **Telegram Bot API** | ✓ | Official, free, native group support, real webhooks. The cleanest long-term home if the unit can move channels. |
| **Google Form** | n/a | Still deployed as the manual fallback; the bridge exists to remove the copy-paste, not to replace the Form. |

## Setup

```bash
cd whatsapp
bun install
cp .env.example .env
```

**1. Point at the web app.** Deploy the Apps Script project as a web app (see the root `README.md`) and copy its
`/exec` URL into `APPS_SCRIPT_URL`. Do **not** append a query string — the bridge adds `?route=paradestate`
itself.

**2. Share the token.** Put the same long random string into `APPS_SCRIPT_TOKEN` here and into the
`WHATSAPP_INGEST_TOKEN` script property on the Apps Script side (set it under Project
Settings → Script Properties). The endpoint
rejects everything if they disagree, or if the property was never set.

**3. Pair WhatsApp and find the group.** Leave `WA_GROUP_ID` blank, set `LOG_LEVEL=debug` and `DRY_RUN=1`, then:

```bash
bun start
```

Scan the QR code with *WhatsApp → Settings → Linked devices → Link a device*. With `WA_GROUP_ID` blank the
listener accepts every chat and logs each message's `remoteJid`, so posting once in the parade-state group
reveals its JID. Copy that into `WA_GROUP_ID` and restart.

**4. Dry run.** Still with `DRY_RUN=1`, post a real parade state and some chatter in the group. You should see
exactly one `DRY_RUN` line, and the chatter logged at `debug` with a rejection reason.

**5. Go live.** Set `DRY_RUN=0`, restore `LOG_LEVEL=info`, and restart.

## Running it permanently on Windows

`bun start` launches a supervisor (`src/supervisor.js`), not the bridge directly. The supervisor spawns
`src/index.js` as a child, forwards its output, and restarts it on a crash **up to 3 consecutive times** with a
growing backoff (3s, 15s, 60s). A child that stayed up for 5 minutes before crashing is treated as a fresh
incident and the counter resets, so an occasional crash after hours of healthy running still gets the full
three attempts. After the 3rd consecutive restart the supervisor prints a fatal banner and exits non-zero.
A clean child exit (code 0), or the "session is dead" exit (code 3), is not restarted.

`bun run start:bridge` runs the bridge unsupervised — use it for debugging.

To start it at login, create a shortcut in `shell:startup` (Win+R → `shell:startup`) pointing at:

```
cmd /c "cd /d C:\Users\Administrator\Documents\Projects\BattalionDataAnalysis\whatsapp && bun start >> bridge.log 2>&1"
```

That shortcut (or Task Scheduler with "restart on failure", which also survives reboots) is the outer layer
that relaunches the supervisor itself after it gives up. It only runs while the machine is awake and logged
in. If uptime matters, move it to an always-on Linux host — nothing in the code is Windows-specific.

## Self-healing reconnect

The listener holds **exactly one** Baileys socket at a time. On a dropped connection it removes the old
socket's listeners and ends it *before* building a new one — two sockets writing `auth/` at once corrupt the
libsignal session, and every later decrypt then fails with `Bad MAC`.

Reconnect backoff is exponential: 3s, doubling each attempt, capped at 120s. After **5 consecutive failed
reconnects** the listener exits non-zero, and the supervisor starts a fresh process — a clean rebuild of
Baileys' in-memory state from `auth/` usually clears a wedged socket.

`loggedOut`, `badSession` and `connectionReplaced` are fatal: the listener prints "delete whatsapp/auth/ and
re-pair" and exits code 3, so the supervisor stops instead of looping into the same wall. Run
`bun run reset-auth` (deletes `auth/`), then `bun start`, then scan the QR.

An isolated `Bad MAC` on a single inbound message is handled inside Baileys — that one message is dropped and
the socket keeps running. Nothing in the reconnect logic reacts to it.

## What gets relayed

Chatter never reaches the spreadsheet, and neither does any session other than the **first** parade. Two gates,
both cheap:

**Structural gates** — ≥ 8 non-empty lines, ≥ 200 characters, and the anchor phrase `/parade\s*state/i`. The
thresholds were calibrated against real parade-state messages, the smallest of which runs about 32 lines /
970 characters. `"Why is your parade state late?"` carries the anchor phrase but is one short line, so it
is rejected here.

A header that carries only `FPS` or `FP` as a whole token clears the structural gate even without the literal
words "PARADE STATE" — some companies label a first parade state that tersely. A bare `PS`, or `LP` / `LPS`
(a last parade state), does not. The ≥ 8 lines / ≥ 200 characters minimums still apply, so a terse one-liner
is still rejected.

**First-parade gate** — the message must either carry an explicit `FIRST PARADE` / `FPS` / `FP` marker in its
header, or have a timing before `12:00` in its header. The header is the first 5 non-empty lines, which is
where every company puts its company / date / session / timing block; confining the search there keeps stray
four-digit numbers — and a stray `FP` — in the body out of the check. The timing pattern uses digit lookaround
so it reads `0738` out of `220626 FP 0738` without ever matching inside the `DDMMYY` date, and still matches
when glued to a suffix (`0930HRS`).

Of the five real samples, four carry an explicit marker (`FIRST PARADE STATE`, or the bare `FIRST PARADE` in
`stallion.txt`); `braves.txt` is labelled only `PARADE STATE` and qualifies on its `0738` timing. A last parade
state has neither a first-parade marker nor a morning timing, so it is rejected.

**There used to be a third stage:** a score over six layout signals, needing three matches to accept. It is
gone. Deciding whether a message is really a parade state is what `ParserAi` and `ParserRows` do, and they do it
by reading the message rather than guessing from its shape — so the score was a second, weaker copy of a
judgement already being made downstream. What it added was a way to drop a genuine parade state whose layout was
merely unusual, with the rejection recorded nowhere but a debug log. A message that clears the gates but is not a
parade state now lands on its own *Parade State Responses* row as `ERROR`, with the
reason beside it, which is visible and reversible.

To retune, edit `MIN_LINES` / `MIN_CHARS` / `FIRST_PARADE_CUTOFF_HOUR` at the top of `src/signature.js`, then
run `bun test`.

## Idempotency

The bridge keeps **no** local record of what it has sent. Dedup lives server-side, keyed on the Baileys message
id, which the relay sends and the handler stores in the `wa_message_id` column.

That is not a simplification for its own sake — it is where the dedup has to be. An Apps Script web app answers
through a 302, and following it re-sends the POST body, so one call can run the handler twice. No amount of
bookkeeping in the bridge would catch that. Baileys redelivering after a reconnect is the other cause, and one
place that sees both is better than two that each see one.

## Layout

| File | Role |
|---|---|
| `src/supervisor.js` | Spawns and restarts the bridge process (this is what `bun start` runs) |
| `src/index.js` | Wiring and the message handler |
| `src/signature.js` | First-parade-state detection |
| `src/listener.js` | Baileys socket, single-socket reconnect, envelope filtering |
| `src/appsScriptClient.js` | Relays an accepted message to the web app |
| `src/config.js` | `.env` loading and validation |
| `src/logger.js` | pino logger factory |
| `scripts/reset-auth.js` | Wipes `auth/` for a clean re-pair (`bun run reset-auth`) |
| `test/` | `bun test` — signature suite plus the non-network modules |

`auth/` and `.env` hold live credentials and are git-ignored.

## Troubleshooting

| Symptom | Cause |
|---|---|
| QR code appears on every start | `auth/` is not writable, or the device was unlinked in WhatsApp |
| `session logged out` / `session is dead` | Run `bun run reset-auth`, then `bun start`, then scan the QR again |
| Occasional `Bad MAC` in the log, bridge keeps running | One inbound message failed to decrypt; Baileys drops it. No action — if it was a parade state, ask the sender to resend |
| Repeated `Bad MAC`, a reconnect loop, or `reconnect failed 5 times` | The libsignal session is corrupted or the device was unlinked. Stop the bridge, `bun run reset-auth`, `bun start`, re-scan |
| Supervisor logs `giving up after 3 consecutive restarts` | The child crashed 3× in quick succession. Read the child's last error printed just above the banner, fix the root cause, then `bun start` |
| `Apps Script rejected the relay: unauthorised` | `APPS_SCRIPT_TOKEN` here does not match the `WHATSAPP_INGEST_TOKEN` script property, or that property was never set |
| `Apps Script rejected the relay: unknown_route` | `APPS_SCRIPT_URL` already carries a query string, or points at something other than the `/exec` URL |
| `HTTP 404` on every relay | The web app was never deployed, or was deployed as a new *project* rather than a new *version* |
| Relay succeeds but nothing appears in the Sheet | A `clasp push` is not a deploy — deploy a new version. Check **Executions** in the Apps Script editor for what the handler logged |
| Relay reports `already recorded` for a new message | Two messages share a Baileys id, or the row was appended and then had its text edited. A row that is still blank now reprocesses on the next redelivery on its own; only a row already holding a key or `ERROR` needs its `parade_response_id` cleared by hand |
| A real parade state was rejected | Run with `LOG_LEVEL=debug`; the reason names the failing gate |
| A first parade state was rejected as "not a first parade state" | Its header has no `FIRST PARADE` marker and no timing before 12:00 — check the timing is in the first 5 non-empty lines |

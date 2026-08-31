# Battalion Personnel Dashboard

## Context

The parade-state pipeline in this repo already lands clean, keyed rows in **Strength Data**,
**Personnel Data** and **Command Roster**, plus **Report Sick FormSG Responses** from the
FormSG intake. Today those tabs feed a Looker Studio dashboard (`README.md:172`,
`DeveloperGuide.md:28`), which charts the sheets but cannot do the three things S1, S3 and the
CO actually need:

1. **Attendance tracking** — how many on MC, how many reported sick.
2. **MC pattern analysis** — what type of MC, and is it localised to one company or platoon.
3. **Per-soldier history** — how many times a soldier reported sick, and each episode's duration.

Looker can't do these because all three need derivation the sheets don't carry: "localised"
needs a rate against platoon strength, and "how many times" needs daily snapshots collapsed
into episodes. This plan builds a static dashboard in `./dashboard`, served by GitHub Pages,
that does that derivation in the browser.

Findings from the sheets and from the design research that drive the whole design:

- **The sheet is private.** Probing the export endpoint returns `401`. Personnel Data holds
  names, 4D numbers and free-text medical reasons; the FormSG tab holds `SingPass Validated
  NRIC`. Nothing gets published to the web.
- **`Att C` *is* MC** — confirmed both by you and by doctrine: Attend C means excused all
  duties, and in NS that normally means resting at home on MC. All 61 `Att C` rows in the
  data reviewed during design are MC, including the three written as `HL`, `FEVER` and `FOOD POISONING`.
  So MC is a category match, not a text match. This matters: a text match on "MC" would have
  wrongly swept in 19 `AFMC` rows (Air Force Medical Centre appointments, category `Others`)
  and one `RETURNING FROM MC`.
- **Parade states are daily snapshots, not events.** A soldier on 3-day MC appears in three
  submissions. Person-day and episode are two different grains; requirement 3 needs episodes.
- **Symptom text is thin in the parade state and rich in FormSG.** Only 16 of 61 `Att C` rows
  carry a parenthetical symptom (`MC (Fever, cough, sore throat)`); the other 45 are a bare
  `MC`. FormSG asks for the reason and symptoms on every submission, so it is the *primary*
  source for "type of MC" and for the word cloud — not a phase-7 nice-to-have.

## Decisions taken

| Decision | Choice |
|---|---|
| Data access | Google Sign-In. Sheet stays private; the page reads the Sheets API with the viewer's own credentials. |
| FormSG tab | Included, minus both NRIC columns — and promoted to the analytical core, per the symptom-coverage finding. |
| v1 scope | All four views. |

## Design references

Researched rather than invented, so the metrics are defensible when the CO asks where a number
comes from.

**Doctrinal framing.** Army personnel reporting separates **accountable strength** from
**operating strength** — the soldiers you have from the soldiers you can employ today. That
distinction maps exactly onto this data and is the spine of the overview:

| Doctrine | This data | Employable today? |
|---|---|---|
| Absent | `Att C` (MC), `Off/Leave`, `MA`, `Others` (duty/course) | No |
| Present, restricted | `Status` — Att B / LD / excuse RMJ, kneeling, heavy load | **Yes, with limits** |
| Present, full | remainder of `total_present` | Yes |

Collapsing `Status` into "absent" would be the single most misleading thing this dashboard
could do, so it never does. 34 of the 235 sample personnel rows are `Status`.

**Metrics taken from HR absence practice.**

- **Bradford Factor** = S² × D (S = absence spells, D = total days lost). It weights many short
  absences far above one long one — a soldier with eight one-day MCs scores 512; one with a
  single eight-day MC scores 8. This is a much better repeat-absence signal than a raw count,
  and it is a standard HR metric rather than something I made up. The published guidance is
  emphatic that it must not be applied mechanically and must be read alongside commander
  judgement and medical input — **that caveat ships on-screen next to the score.**
- **MC man-days lost per 100 pax** — the "days lost per FTE" normalisation. Lets a 136-man
  company be compared with a 40-man one; raw counts cannot (Braves shows 40 MC rows against
  Hercules' 7 in the samples).
- **Bridge-day analysis** — Monday/Friday spikes around weekends are a recognised standard cut,
  which is what makes the weekday chart worth its space.
- **Break every metric by organisational unit** — here company, then platoon.

**Layout doctrine.** Command dashboards read top-down as headline → breakdown → trend →
exceptions, with each KPI tile carrying a delta against the previous day and the 7-day average.
Every page in this design follows that order.

**Terminology.** Labels use the unit's own words — Att C, Att B / LD, RSI, MC, parade state,
FPS/LPS — not HR-speak. `RSI` (Report Sick In-camp) appears in 14 of the 25 sample Report Sick
reasons; `RSO` never does, so the split is shown as RSI vs unspecified rather than pretending
to a clean two-way cut.

Sources:
[MOS Health Dashboard](https://www.army.mil/article/293459/new_vantage_dashboard_enhances_readiness_reporting),
[FM 12-6 Personnel Readiness Management](https://www.globalsecurity.org/military/library/policy/army/fm/12-6/Ch1.htm),
[Personnel accountability](https://ssilrc.army.mil/resources/AGS/hrpo/lessons/B_1/notes_1.html),
[Absenteeism KPIs on an executive HR dashboard](https://beebole.com/blog/absenteeism-kpis-executive-hr-dashboard),
[Bradford Factor](https://www.bernardmarr.com/default.asp?contentID=918),
[Absence metrics glossary](https://www.goodshape.com/hr-glossary/absence-metrics),
[SAF/NS lingo](https://national-service.vercel.app/lingo).

## Architecture

No build step. Plain ES modules + CSS, served as-is. The model layer is pure functions over
plain arrays — no DOM, no network — so all of it is unit-testable under `bun test` with no
Google account and no API key, matching how `test/` already works.

```
dashboard/
  index.html
  README.md              # one-time OAuth client setup, in operator-runbook voice
  css/styles.css
  js/
    config.js            # spreadsheet id, OAuth client id, tab names
    auth.js              # Google Identity Services token client
    sheets.js            # values:batchGet, header-driven column mapping
    model/               # pure; fully unit-tested
      schema.js          # required headers per tab
      normalize.js       # raw string[][] -> typed records
      classify.js        # duty class + symptom lexicon
      episodes.js        # person-days -> episodes
      metrics.js         # strength, rates, Bradford, heatmap, z-scores
    views/
      overview.js  attendance.js  patterns.js  soldier.js
    charts.js            # shared ECharts theme + helpers
  test/
    fixtures.js          # sheet-shaped rows built via the real parser
    *.test.js
.github/workflows/pages.yml
```

**Data flow:** Sheets API → `normalize` → `classify` → `episodes` → `metrics` → views.

### Auth (`js/auth.js`)

Google Identity Services token client, scope `spreadsheets.readonly`, token in memory with a
`sessionStorage` expiry mirror and a silent re-request on 401. Signed out means a sign-in
screen and zero fetches. **Access control is the sheet's existing sharing list** — no separate
user management, nothing to keep in sync.

The OAuth client ID is public by design and lives in `config.js`. Creating it is a one-time
manual step documented in `dashboard/README.md`, including the Pages origin and
`http://localhost:8000` as authorised JavaScript origins.

### Reading the sheet (`js/sheets.js`)

One `values:batchGet` for all four ranges. Columns resolve **by header name at read time**, not
fixed index — the dashboard is a read-only consumer, so it tolerates column additions and
reordering and fails loudly naming the missing header rather than silently reading the wrong
column. This is the read-side analogue of the repo's rule that a sheet with a wrong header is
refused, never rewritten.

Only these FormSG columns are read: `Timestamp`, `RANK`, `[Myinfo] Name`, `4D Number (REC
Only)`, `Unit & Coy`, `Report Sick Type`, `Reason for Reporting Sick (Keep Brief)`, and the
symptoms question. **`SingPass Validated NRIC` and `Masked NRIC` are never requested.**

### Classification (`js/model/classify.js`)

One rule table, surfaced in the UI as a "How figures are classified" panel so the CO can see
what a number means. Every rule is a category match:

| Class | Rule | Employable |
|---|---|---|
| **MC (Att C)** | `reason_category === 'Att C'` | No |
| **Report Sick** | `reason_category === 'Report Sick'`, split RSI vs unspecified | Same-day event |
| **Status (Att B / LD)** | `reason_category === 'Status'` | Yes, with limits |
| MA | `reason_category === 'MA'` | No |
| Off / Leave | `reason_category === 'Off/Leave'` | No |
| Others | `reason_category === 'Others'` — duty, course, AFMC | No |

The same module extracts symptoms via one normalising lexicon — fever, cough, flu, sore throat,
phlegm, runny/blocked nose, diarrhoea, gastric, headache, nausea, rash, knee/back/ankle pain,
sprain, dizziness — reading FormSG's reason and symptom fields first and the parade-state
parenthetical second. Charts built on it **state their coverage** ("symptoms recorded for 62%
of MC episodes"), because a symptom breakdown over a quarter of the data would otherwise read
as the whole picture.

### Episodes (`js/model/episodes.js`)

Key: `four_d`, falling back to a normalised `name`. Within one class, rows sharing a
`start_date` are one episode; when `start_date` is blank, consecutive parade dates group and a
gap greater than one day starts a new episode.

Duration reports **both** the stated `num_days` and the `start_date`→`end_date` span, and flags
disagreement rather than picking one. `ParserRows` documents that real
messages contain a stated day-count that contradicts their own date range, and that deriving the count
is wrong precisely where it fires. The dashboard honours that and turns the contradiction into
a data-quality signal for S1.

### Metrics (`js/model/metrics.js`)

- Accountable and operating strength for the selected date/session, from `unit_type ===
  'Company'` rows; `% present` from `total_present`.
- MC man-days lost per 100 pax, by company and platoon, using `total_strength` as denominator.
- Company × platoon rate matrix with a z-score against the battalion rate to flag outliers.
- Bradford Factor per soldier over a selectable window.
- Weekday distribution of MC `start_date`; episode-duration histogram.

## Views

Each follows headline → breakdown → trend → exceptions.

**Overview** — KPI tiles (accountable strength, present %, MC today, reported sick today, on
status), each with a delta against yesterday and the 7-day average. Then company breakdown,
then a 14-day trend, then exceptions. Two honesty requirements: a **"Companies reporting: N /
6"** banner naming any missing company — a headline that silently omits a company is dangerous
for a CO — and Status shown as *present, restricted*, never folded into absence. A
data-quality badge reports the share of personnel rows missing `platoon` (18% in the samples),
`four_d` (14%) and `start_date` (29%); unattributable rows go to a visible "unassigned" bucket,
never dropped.

**Attendance** — MC and Report Sick counts and rates over time, by company, FPS/LPS, with
man-days lost per 100 pax as the comparable measure.

**MC patterns** — symptom frequency with coverage stated, company × platoon rate heatmap with
outlier flags, episode-duration histogram, bridge-day weekday effect, word cloud, and top
symptoms by company. A symptom cluster concentrated in one platoon reads as an outbreak; the
same rate spread flat across the battalion does not, and the heatmap is what tells them apart.

**Soldier** — search by name or 4D, episode timeline, episode counts by class, total MC days,
average duration, last episode, Bradford Factor with its caveat inline; plus the repeat table
ranked by Bradford over a selectable window.

Global controls: date picker defaulting to the latest date with data, FPS/LPS toggle, company
filter, date range for trend views.

## Charts

ECharts 5 + `echarts-wordcloud` from a pinned CDN — one library covers bar, line, heatmap,
treemap and word cloud, where Chart.js would need three plugins. The `dataviz` skill gets
loaded before the first chart is written. If you would rather not depend on a CDN, the two
files vendor into `dashboard/vendor/` with no other change.

## Deployment

**`/dashboard` is not a selectable GitHub Pages folder** — deploy-from-a-branch offers only `/`
and `/docs`, and `docs/` is already taken by `architecture_patterns.md`. So Pages is driven by
`.github/workflows/pages.yml` using `actions/upload-pages-artifact` with `path: dashboard`. No
build step in the workflow; it uploads the directory as-is.

## Testing

`test/dashboard/fixtures.js` builds sheet-shaped rows by loading the real Apps Script parser
through the existing `loadParser()` in `test/harness.js` and taking its
`PERSONNEL_DATA_COLUMNS` / `STRENGTH_DATA_COLUMNS` arrays, so the column order under test
**cannot drift from the real sheet layout** — it is read from the code that writes it. Each
test supplies its own rows in that column order.

Unit tests cover `normalize`, `classify`, `episodes` and `metrics` — including the two cases
this plan was corrected into: `AFMC` and `RETURNING FROM MC` must **not** count as MC, and
`HL` / `FEVER` / `FOOD POISONING` under `Att C` must. Plus a schema-drift test asserting every
header the dashboard requires exists in the canonical `STRENGTH_DATA_COLUMNS` /
`PERSONNEL_DATA_COLUMNS` / `COMMAND_ROSTER_COLUMNS` / `FORMSG_COLUMNS` arrays, turning a future
column rename into a failing test rather than a blank chart.

`package.json`'s `test` script gains `./dashboard/test/`.

## Files

**New:** everything under `dashboard/`, plus `.github/workflows/pages.yml` and
`docs/superpowers/specs/2026-08-31-battalion-dashboard-design.md`.

**Modified:** `package.json` (test glob), `docs/architecture_patterns.md` (a fourth consumer of
the spreadsheet, and its ownership boundary: read-only, no writes, no `src/` dependency),
`README.md` (dashboard section replacing the Looker-only guidance).

**Read, never modified:** `src/parser/ParserSchema.js`, `src/formsg/FormSgColumns.js`,
`test/harness.js`.

## Phases

0. Spec doc, scaffold, Pages workflow, `dashboard/README.md` OAuth setup steps.
1. `auth.js` + `sheets.js` + `normalize.js` — sign in and render a raw row count. Proves the
   auth path end to end before any analysis is built on it.
2. `classify.js`, `episodes.js`, `metrics.js` with tests, **including the FormSG source** — the
   analytical core, headless.
3. App shell, controls, chart theme, **Overview**.
4. **Attendance**.
5. **MC patterns**, including the word cloud over FormSG text.
6. **Soldier lookup** + Bradford table.
7. Submitted-vs-appeared cross-check between FormSG and the parade state.
8. Deploy and verify against the live sheet.

## Verification

- `bun test ./test/ ./whatsapp/test/ ./dashboard/test/` — model layer green, no regressions.
- Serve locally (`bunx serve dashboard`), sign in, and confirm for one chosen date that
  accountable strength, % present, MC count and Report Sick count match the sheet. Reconciled
  by hand once; after that the tests hold them.
- Confirm the signed-out state fetches nothing, and that an account *without* sheet access gets
  a clean "no access" message rather than a broken page.
- Push, confirm the Pages workflow deploys, repeat the sign-in check on the live URL.

## Flags

- **OAuth consent screen.** `spreadsheets.readonly` is a sensitive scope, so until the app is
  verified viewers see a one-time "Google hasn't verified this app" screen and click through.
  In Testing mode each viewer is added as a test user (cap 100). Fine for CO/S1/S3, but worth
  knowing before you show anyone.
- **Nothing becomes public.** No tab is published to the web, no data is committed to the repo,
  and the deployed artifact is code only. A public repo exposes the dashboard's logic, not the
  battalion's data.
- **Bradford Factor is a conversation-starter, not a verdict.** It ships with its caveat
  on-screen and reports what was recorded, with no inference about intent.

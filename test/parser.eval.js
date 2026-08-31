/**
 * Scores extraction accuracy against the labelled messages in
 * `parade-state-example/`, and prices it.
 *
 * Deliberately NOT a `bun test` file — it makes real API calls and costs money. Run it
 * explicitly:
 *
 *     bun run eval                        # the model in ParserSchema
 *     bun run eval --model gpt-5-mini     # one candidate
 *     bun run eval --sweep a,b,c          # several, cheapest first, stop when one passes
 *     bun run eval --only archer          # one example, while iterating on the prompt
 *
 * It loads the prompt and schema from `src/parser` through the same `node:vm` loader
 * the tests use, so what is scored here is exactly what the deployed script sends —
 * there is no second copy of the prompt to drift.
 *
 * ## Why the bar is tiered
 *
 * A sweep needs a pass/fail line or "accurate enough" stays an opinion, and not every
 * field costs the same when it is wrong:
 *
 *   - company/date/session ARE the parade_response_id. One wrong value files a day's
 *     data under the wrong key, silently, and the duplicate cleanup may then delete
 *     the right row. No tolerance.
 *   - strength figures are integers copied straight from the message and feed the
 *     dashboards. A model that misreads "220/274" is unusable at any price.
 *   - personnel recall matters next: a dropped person is an untracked absence.
 *   - the structured personnel fields are wrong-but-visible, correctable in the sheet.
 *   - reason and location are free prose with no single right phrasing, so they are
 *     reported and never scored.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadParser } from './harness.js';

/** @type {string} Directory holding the labelled messages. */
const EXAMPLE_DIR = join(import.meta.dir, '..', 'parade-state-example');

/**
 * The accuracy bar, in the order it is reported. A model must clear tiers 1-4 to pass;
 * tier 5 is reported only.
 * @type {!Array<{tier: number, label: string, bar: ?number}>}
 */
const TIERS = [
  { tier: 1, label: 'identity (company/date/session)', bar: 1 },
  { tier: 2, label: 'strength figures', bar: 1 },
  { tier: 3, label: 'personnel recall/precision', bar: 0.98 },
  { tier: 4, label: 'personnel structured fields', bar: 0.95 },
  { tier: 5, label: 'reason/location prose', bar: null },
];

/** Personnel fields scored at tier 4. @type {string[]} */
const TIER4_FIELDS = ['reason_category', 'start_date', 'end_date', 'num_days', 'four_d', 'rank', 'platoon'];

/** Personnel fields reported at tier 5. @type {string[]} */
const TIER5_FIELDS = ['reason', 'location', 'in_camp'];

/**
 * Parses argv into options.
 * @param {string[]} argv Raw arguments after the script name.
 * @returns {{models: ?Array<string>, only: ?string}} The parsed options.
 */
function parseArgs(argv) {
  const options = { models: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const valueOf = (flag) => (arg.includes('=') ? arg.split('=').slice(1).join('=') : argv[++i]);
    if (arg === '--model' || arg.startsWith('--model=')) {
      options.models = [valueOf('--model')];
    } else if (arg === '--sweep' || arg.startsWith('--sweep=')) {
      options.models = valueOf('--sweep')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      options.only = valueOf('--only');
    }
  }
  return options;
}

/**
 * Loads the labelled messages and their expected extractions.
 * @param {?string} only Restrict to one example by name prefix, or null for all.
 * @returns {!Array<{name: string, text: string, gold: !Object}>} The examples.
 */
function loadExamples(only) {
  return readdirSync(EXAMPLE_DIR)
    .filter((file) => file.endsWith('-struct.json'))
    .map((file) => file.replace('-struct.json', ''))
    .filter((name) => !only || name.startsWith(only))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(EXAMPLE_DIR, `${name}.txt`), 'utf8'),
      gold: JSON.parse(readFileSync(join(EXAMPLE_DIR, `${name}-struct.json`), 'utf8')),
    }));
}

/**
 * Normalises a value for comparison, so '' and null and undefined are all "absent"
 * and a stringified number matches its integer.
 * @param {*} value The value to normalise.
 * @returns {*} The normalised value.
 */
function normalise(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Accumulates hit/miss counts per tier, with the misses kept for reporting.
 */
class Score {
  constructor() {
    /** @type {!Object<number, {hits: number, total: number, misses: !Array<string>}>} */
    this.tiers = {};
    TIERS.forEach(({ tier }) => {
      this.tiers[tier] = { hits: 0, total: 0, misses: [] };
    });
  }

  /**
   * Records one field comparison.
   * @param {number} tier Which tier the field belongs to.
   * @param {boolean} hit Whether it matched.
   * @param {string} detail Human-readable miss description.
   * @returns {void}
   */
  record(tier, hit, detail) {
    const bucket = this.tiers[tier];
    bucket.total += 1;
    if (hit) {
      bucket.hits += 1;
    } else {
      bucket.misses.push(detail);
    }
  }

  /**
   * Compares one field and records the outcome.
   * @param {number} tier Which tier the field belongs to.
   * @param {string} where Location prefix for the miss message.
   * @param {string} field Field name.
   * @param {*} got The extracted value.
   * @param {*} want The labelled value.
   * @returns {void}
   */
  compare(tier, where, field, got, want) {
    const a = normalise(got);
    const b = normalise(want);
    this.record(tier, a === b, `${where} ${field}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }

  /**
   * Merges another score into this one.
   * @param {!Score} other The score to absorb.
   * @returns {void}
   */
  absorb(other) {
    TIERS.forEach(({ tier }) => {
      this.tiers[tier].hits += other.tiers[tier].hits;
      this.tiers[tier].total += other.tiers[tier].total;
      this.tiers[tier].misses.push(...other.tiers[tier].misses);
    });
  }

  /**
   * @param {number} tier The tier to read.
   * @returns {?number} Accuracy in [0, 1], or null when nothing was scored — never 1,
   *     because "no data" reported as a perfect score is how a broken run gets
   *     mistaken for a passing one.
   */
  rate(tier) {
    const bucket = this.tiers[tier];
    return bucket.total === 0 ? null : bucket.hits / bucket.total;
  }
}

/**
 * Scores one extraction against its labelled counterpart.
 * @param {string} name The example name, for miss messages.
 * @param {!Object} got The model's extraction.
 * @param {!Object} gold The labelled extraction.
 * @returns {!Score} The score.
 */
function scoreExample(name, got, gold) {
  const score = new Score();

  ['company', 'date', 'session'].forEach((field) => {
    score.compare(1, name, field, got[field], gold[field]);
  });

  scorePlatoons(score, name, got.platoons || [], gold.platoons || []);
  scorePersonnel(score, name, got.personnel || [], gold.personnel || []);
  return score;
}

/**
 * Scores platoon rows, matched on their platoon label.
 * @param {!Score} score The score to record into.
 * @param {string} name The example name.
 * @param {!Array<!Object>} got Extracted platoon rows.
 * @param {!Array<!Object>} gold Labelled platoon rows.
 * @returns {void}
 */
function scorePlatoons(score, name, got, gold) {
  const byLabel = {};
  got.forEach((row) => {
    byLabel[String(row.platoon)] = row;
  });

  gold.forEach((want) => {
    const where = `${name} platoon ${want.platoon}`;
    const have = byLabel[String(want.platoon)];
    if (!have) {
      score.record(2, false, `${where}: missing entirely`);
      return;
    }
    ['total_strength', 'total_present'].forEach((field) => {
      score.compare(2, where, field, have[field], want[field]);
    });
    // unit_type and the rank tiers are structured-but-correctable, so tier 4.
    ['unit_type', 'officer_strength', 'officer_present', 'wospec_strength', 'wospec_present',
      'enlistee_strength', 'enlistee_present'].forEach((field) => {
      score.compare(4, where, field, have[field], want[field]);
    });
  });

  Object.keys(byLabel)
    .filter((label) => !gold.some((want) => String(want.platoon) === label))
    .forEach((label) => score.record(2, false, `${name} platoon ${label}: invented, not in the message`));
}

/**
 * Builds the key personnel entries are matched on.
 *
 * Name plus reason, because one person legitimately appears several times — a
 * multi-status entry is split into one row per status, and someone can hold both an MC
 * and an appointment. Name alone would collapse those.
 * @param {!Object} entry A personnel entry.
 * @returns {string} The match key.
 */
function personnelKey(entry) {
  return `${String(entry.name || '').trim().toUpperCase()}|${String(entry.reason || '').trim().toUpperCase()}`;
}

/**
 * Scores personnel entries: recall and precision at tier 3, fields at tiers 4 and 5.
 * @param {!Score} score The score to record into.
 * @param {string} name The example name.
 * @param {!Array<!Object>} got Extracted personnel entries.
 * @param {!Array<!Object>} gold Labelled personnel entries.
 * @returns {void}
 */
function scorePersonnel(score, name, got, gold) {
  const pool = got.slice();

  gold.forEach((want) => {
    const where = `${name} ${want.name}`;
    // Prefer an exact name+reason match; fall back to name alone so a paraphrased
    // reason costs a tier-5 point rather than counting as a dropped person.
    let index = pool.findIndex((entry) => personnelKey(entry) === personnelKey(want));
    if (index === -1) {
      index = pool.findIndex(
        (entry) => String(entry.name || '').trim().toUpperCase() === String(want.name).trim().toUpperCase()
      );
    }
    if (index === -1) {
      score.record(3, false, `${where}: dropped (${want.reason_category} / ${want.reason})`);
      return;
    }

    const have = pool.splice(index, 1)[0];
    score.record(3, true, '');
    TIER4_FIELDS.forEach((field) => score.compare(4, where, field, have[field], want[field]));
    TIER5_FIELDS.forEach((field) => score.compare(5, where, field, have[field], want[field]));
  });

  pool.forEach((extra) => {
    score.record(3, false, `${name} ${extra.name}: invented (${extra.reason_category} / ${extra.reason})`);
  });
}

/**
 * Calls the API directly, bypassing UrlFetchApp.
 *
 * The prompt and schema come from the loaded Apps Script sources, so this differs from
 * production only in the HTTP client.
 * @param {!Object} globals The loaded parser bindings.
 * @param {string} model The model id to call.
 * @param {string} text The raw parade-state message.
 * @returns {!Promise<{extraction: !Object, usage: !Object}>} The extraction and usage.
 */
async function callModel(globals, model, text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in the environment.');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      service_tier: 'flex',
      messages: [{ role: 'user', content: globals.ParserAi.buildPrompt_(text) }],
      response_format: { type: 'json_schema', json_schema: globals.ParserAi.buildResponseSchema_() },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  const parsed = JSON.parse(body);
  return { extraction: globals.ParserAi.parseResponse_(parsed), usage: parsed.usage || {} };
}

/**
 * Formats a rate as a fixed-width percentage.
 * @param {?number} rate A value in [0, 1], or null when nothing was scored.
 * @returns {string} e.g. " 98.4%", or "    --" for null.
 */
function pct(rate) {
  return rate === null ? '    --' : `${(rate * 100).toFixed(1).padStart(5)}%`;
}

/**
 * Runs the whole example set against one model and prints its report.
 * @param {!Object} globals The loaded parser bindings.
 * @param {string} model The model id.
 * @param {!Array<!Object>} examples The examples to score.
 * @returns {!Promise<boolean>} True if the model cleared tiers 1-4.
 */
async function evaluateModel(globals, model, examples) {
  console.log(`\n${'='.repeat(72)}\nMODEL: ${model}\n${'='.repeat(72)}`);

  const total = new Score();
  let promptTokens = 0;
  let completionTokens = 0;
  let failures = 0;

  for (const example of examples) {
    process.stdout.write(`  ${example.name.padEnd(10)} `);
    try {
      const { extraction, usage } = await callModel(globals, model, example.text);
      promptTokens += usage.prompt_tokens || 0;
      completionTokens += usage.completion_tokens || 0;

      // A model whose output the pipeline would refuse to write has not "extracted"
      // it, however well it scores, so the validator's verdict is reported too.
      const issue = globals.ParserRows.validate(extraction);
      const score = scoreExample(example.name, extraction, example.gold);
      total.absorb(score);

      console.log(
        `t1 ${pct(score.rate(1))}  t2 ${pct(score.rate(2))}  t3 ${pct(score.rate(3))}  ` +
          `t4 ${pct(score.rate(4))}  ${issue ? `REJECTED: ${issue}` : 'valid'}`
      );
    } catch (err) {
      failures += 1;
      console.log(`FAILED: ${err.message}`);
    }
  }

  console.log('\n  Tier summary');
  let passed = failures === 0;
  TIERS.forEach(({ tier, label, bar }) => {
    const rate = total.rate(tier);
    const bucket = total.tiers[tier];
    let verdict;
    if (rate === null) {
      verdict = 'NO DATA';
    } else if (bar === null) {
      verdict = 'reported';
    } else {
      verdict = rate + 1e-9 >= bar ? 'PASS' : 'FAIL';
    }
    if (bar !== null && verdict !== 'PASS') {
      passed = false;
    }
    console.log(
      `    tier ${tier}  ${pct(rate)}  (${bucket.hits}/${bucket.total})  ` +
        `bar ${bar === null ? '   -- ' : pct(bar)}  ${verdict}  ${label}`
    );
  });

  console.log('\n  Cost');
  console.log(`    prompt tokens     ${promptTokens}`);
  console.log(`    completion tokens ${completionTokens}`);
  console.log(`    per message       ${Math.round(promptTokens / Math.max(examples.length, 1))} prompt + ${Math.round(completionTokens / Math.max(examples.length, 1))} completion`);
  console.log('    $/message         multiply by this model\'s live per-token price; the');
  console.log('                      prompt prefix is identical every call, so check');
  console.log('                      whether prefix caching applies before comparing.');

  const misses = [];
  TIERS.forEach(({ tier }) => {
    total.tiers[tier].misses.filter(Boolean).forEach((miss) => misses.push(`    t${tier} ${miss}`));
  });
  if (misses.length > 0) {
    console.log(`\n  Misses (${misses.length})`);
    misses.slice(0, 60).forEach((miss) => console.log(miss));
    if (misses.length > 60) {
      console.log(`    ... and ${misses.length - 60} more`);
    }
  }

  console.log(`\n  VERDICT: ${passed ? 'PASS — clears tiers 1-4' : 'FAIL'}`);
  return passed;
}

/**
 * Entry point.
 * @returns {!Promise<void>} Resolves when every requested model has been scored.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { globals } = loadParser();
  const examples = loadExamples(options.only);

  if (examples.length === 0) {
    throw new Error(`No examples matched${options.only ? ` "${options.only}"` : ''}.`);
  }

  const models = options.models || [globals.OPENAI_MODEL];
  console.log(`Scoring ${examples.length} example(s) against ${models.length} model(s), cheapest first.`);
  console.log('Pass the candidates to --sweep in ascending price order; this stops at the first that passes.');

  for (const model of models) {
    if (await evaluateModel(globals, model, examples)) {
      console.log(`\nCheapest passing model: ${model}. Set OPENAI_MODEL in src/parser/ParserSchema.js.`);
      return;
    }
  }
  console.log('\nNo model cleared tiers 1-4. Widen the sweep, or read the misses above — a rule');
  console.log('the prompt never states will fail on every model equally, and is fixed there.');
}

// Exported so test/parser.eval.test.js can prove the scorer actually discriminates —
// a scorer that always returned 100% would silently bless any model.
export { scoreExample, loadExamples, normalise, personnelKey, TIERS };

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

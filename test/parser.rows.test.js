/**
 * Tests for ParserRows — validation and row shaping, with no fakes needed.
 *
 * The most valuable case here is the cheapest: every labelled message in
 * `parade-state-example/` must pass `validate` unchanged. Those files are the golden
 * targets the model is scored against, so if validate rejects one of them then either
 * the labels or the validator is wrong, and the eval would be measuring against
 * something the pipeline would refuse to write anyway.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadParser } from './harness.js';

/** @type {string} Directory holding the labelled messages and their expected output. */
const EXAMPLE_DIR = join(import.meta.dir, '..', 'parade-state-example');

/** @type {!Object} Bindings shared by every test here; ParserRows holds no state. */
const { globals } = loadParser();

/**
 * Loads the labelled extraction for each example message.
 * @returns {!Array<!Array<*>>} [name, extraction] pairs, for test.each.
 */
function goldenExtractions() {
  return readdirSync(EXAMPLE_DIR)
    .filter((file) => file.endsWith('-struct.json'))
    .sort()
    .map((file) => [file, JSON.parse(readFileSync(join(EXAMPLE_DIR, file), 'utf8'))]);
}

/**
 * A minimal valid extraction, for mutating into invalid ones.
 * @param {!Object=} overrides Fields to merge over the defaults.
 * @returns {!Object} The extraction.
 */
function minimal(overrides) {
  return {
    company: 'Cougar',
    date: '2026-06-22',
    session: 'FPS',
    platoons: [
      {
        platoon: 'Company',
        unit_type: 'Company',
        total_strength: 136,
        total_present: 120,
        officer_strength: null,
        officer_present: null,
        wospec_strength: null,
        wospec_present: null,
        enlistee_strength: null,
        enlistee_present: null,
      },
    ],
    command_team: [],
    personnel: [],
    ...(overrides || {}),
  };
}

/**
 * Builds a valid personnel entry.
 * @param {!Object=} overrides Fields to merge over the defaults.
 * @returns {!Object} The entry.
 */
function person(overrides) {
  return {
    name: 'TAN AH KOW',
    rank: 'REC',
    four_d: '1234',
    platoon: null,
    reason_category: 'Others',
    start_date: null,
    end_date: null,
    num_days: null,
    reason: 'GD',
    location: null,
    in_camp: null,
    ...(overrides || {}),
  };
}

describe('validate accepts every labelled example', () => {
  test.each(goldenExtractions())('%s passes validation unchanged', (_name, gold) => {
    expect(globals.ParserRows.validate(gold)).toBe('');
  });

  test('there are five of them, so none is silently skipped', () => {
    expect(goldenExtractions()).toHaveLength(5);
  });
});

describe('validate rejects', () => {
  test.each([
    ['a missing extraction', null, /missing or not an object/i],
    ['a company outside the roster', minimal({ company: 'Nonesuch' }), /company/i],
    ['an empty company', minimal({ company: '' }), /company/i],
    ['a non-ISO date', minimal({ date: '22/06/26' }), /date/i],
    ['an implausible year', minimal({ date: '0226-06-22' }), /date/i],
    ['a missing session', minimal({ session: null }), /session/i],
    ['an unknown session', minimal({ session: 'MPS' }), /session/i],
    ['a non-array platoons', minimal({ platoons: {} }), /platoons/i],
    ['no company-total row', minimal({ platoons: [] }), /company-total/i],
    ['a non-array command_team', minimal({ command_team: null }), /command_team/i],
    ['a non-array personnel', minimal({ personnel: null }), /personnel/i],
  ])('%s', (_label, extraction, expected) => {
    expect(globals.ParserRows.validate(extraction)).toMatch(expected);
  });

  test.each([
    ['an unknown unit_type', { unit_type: 'SQUAD' }],
    ['a missing platoon label', { platoon: '' }],
    ['a non-numeric strength', { total_strength: '274' }],
    ['a negative headcount', { total_present: -1 }],
    ['a negative rank tier', { officer_strength: -2 }],
    ['a non-numeric rank tier', { wospec_present: 'five' }],
  ])('a platoon row with %s', (_label, broken) => {
    const extraction = minimal();
    Object.assign(extraction.platoons[0], broken);
    expect(globals.ParserRows.validate(extraction)).toMatch(/platoon entries/i);
  });

  test.each([
    ['no name', { name: '' }],
    ['no reason', { reason: '' }],
    ['an unknown reason_category', { reason_category: 'Leave' }],
    ['a malformed start_date', { start_date: '210626' }],
    ['a malformed end_date', { end_date: '2026-6-3' }],
    ['a negative num_days', { num_days: -1 }],
  ])('a personnel entry with %s', (_label, broken) => {
    expect(globals.ParserRows.validate(minimal({ personnel: [person(broken)] }))).toMatch(/personnel entries/i);
  });

  test.each([
    ['no name', { role: 'CDO', rank: '2LT', name: '' }],
    ['an unknown role', { role: 'RSM', rank: '1WO', name: 'TAN' }],
    ['a role with a space before the number', { role: 'PDS 1', rank: '3SG', name: 'TAN' }],
  ])('a command_team entry with %s', (_label, broken) => {
    expect(globals.ParserRows.validate(minimal({ command_team: [broken] }))).toMatch(/command_team/i);
  });
});

describe('validate accepts the shapes real messages produce', () => {
  test.each([
    ['an open-ended status (start only)', { start_date: '2026-05-13', end_date: null, num_days: null }],
    ['an open-started status (end only)', { start_date: null, end_date: '2026-06-26', num_days: null }],
    ['a single-date appointment', { start_date: '2026-06-22', end_date: '2026-06-22', num_days: 1 }],
    ['an overnight duty counted as one day', { start_date: '2026-06-18', end_date: '2026-06-19', num_days: 1 }],
    ['a stated count that disagrees with its range', { start_date: '2026-06-21', end_date: '2026-06-23', num_days: 2 }],
    ['no dates at all', { start_date: null, end_date: null, num_days: null }],
  ])('%s', (_label, dates) => {
    expect(globals.ParserRows.validate(minimal({ personnel: [person(dates)] }))).toBe('');
  });

  test('a zero headcount, which is a real figure and not a missing one', () => {
    const extraction = minimal();
    extraction.platoons[0].total_present = 0;
    extraction.platoons[0].officer_strength = 0;
    expect(globals.ParserRows.validate(extraction)).toBe('');
  });

  test('every unit_type the schema allows', () => {
    Object.values(globals.UNIT_TYPES).forEach((unitType) => {
      const extraction = minimal();
      extraction.platoons.push({ ...extraction.platoons[0], platoon: 'X', unit_type: unitType });
      expect(globals.ParserRows.validate(extraction)).toBe('');
    });
  });
});

describe('row shaping', () => {
  /** @type {!Object} A labelled example with all three row kinds populated. */
  const gold = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'hercules-struct.json'), 'utf8'));
  const KEY = 'Hercules_2026-06-22_FPS';

  test.each([
    ['strength', 'buildStrengthRows', 'STRENGTH_DATA_COLUMNS', 'platoons'],
    ['personnel', 'buildPersonnelRows', 'PERSONNEL_DATA_COLUMNS', 'personnel'],
    ['command roster', 'buildCommandRosterRows', 'COMMAND_ROSTER_COLUMNS', 'command_team'],
  ])('%s rows match their column count, one per source entry', (_label, method, columnsName, sourceKey) => {
    const rows = globals.ParserRows[method](gold, KEY);
    expect(rows).toHaveLength(gold[sourceKey].length);
    rows.forEach((row) => expect(row).toHaveLength(globals[columnsName].length));
  });

  test.each([
    ['strength', 'buildStrengthRows', 'STRENGTH_DATA_COLUMNS'],
    ['personnel', 'buildPersonnelRows', 'PERSONNEL_DATA_COLUMNS'],
    ['command roster', 'buildCommandRosterRows', 'COMMAND_ROSTER_COLUMNS'],
  ])('%s rows carry the key and identity fields in their declared positions', (_label, method, columnsName) => {
    const columns = globals[columnsName];
    globals.ParserRows[method](gold, KEY).forEach((row) => {
      expect(row[columns.indexOf('parade_response_id')]).toBe(KEY);
      expect(row[columns.indexOf('date')]).toBe('2026-06-22');
      expect(row[columns.indexOf('session')]).toBe('FPS');
      expect(row[columns.indexOf('company')]).toBe('Hercules');
    });
  });

  test('blanks every unstated optional field rather than writing null', () => {
    // A null would reach the sheet as the string "null" in some paths; '' is the
    // only value that reads as "the message did not say".
    const columns = globals.PERSONNEL_DATA_COLUMNS;
    const rows = globals.ParserRows.buildPersonnelRows(minimal({ personnel: [person()] }), KEY);

    ['platoon', 'start_date', 'end_date', 'num_days', 'location', 'in_camp'].forEach((header) => {
      expect(rows[0][columns.indexOf(header)]).toBe('');
    });
  });

  test('preserves a false in_camp, which is a stated value not an absent one', () => {
    const columns = globals.PERSONNEL_DATA_COLUMNS;
    const rows = globals.ParserRows.buildPersonnelRows(minimal({ personnel: [person({ in_camp: false })] }), KEY);
    expect(rows[0][columns.indexOf('in_camp')]).toBe(false);
  });

  test('preserves a zero num_days rather than blanking it', () => {
    const columns = globals.PERSONNEL_DATA_COLUMNS;
    const rows = globals.ParserRows.buildPersonnelRows(minimal({ personnel: [person({ num_days: 0 })] }), KEY);
    expect(rows[0][columns.indexOf('num_days')]).toBe(0);
  });

  test('returns no rows for an extraction with nothing to write', () => {
    expect(globals.ParserRows.buildPersonnelRows(minimal(), KEY)).toEqual([]);
    expect(globals.ParserRows.buildCommandRosterRows(minimal(), KEY)).toEqual([]);
  });
});

describe('the key', () => {
  test('is company, date and session joined, and nothing else', () => {
    expect(globals.ParserSchema.paradeResponseId_('Archer', '2026-07-18', 'FPS')).toBe('Archer_2026-07-18_FPS');
  });

  test('can never collide with the error sentinel', () => {
    // The sentinel doubles as "this row failed", so a real key matching it would make
    // a failed row indistinguishable from a processed one.
    globals.COMPANIES.forEach((company) => {
      Object.values(globals.SESSIONS).forEach((session) => {
        expect(globals.ParserSchema.paradeResponseId_(company, '2026-07-18', session)).not.toBe(
          globals.PARADE_ERROR_SENTINEL
        );
      });
    });
  });
});

describe('isIsoDate_', () => {
  test.each([
    ['2026-06-22', true],
    ['2020-01-01', true],
    ['22/06/26', false],
    ['220626', false],
    ['2026-6-22', false],
    ['0226-06-22', false],
    ['9999-01-01', false],
    ['', false],
    [null, false],
    [undefined, false],
    [20260622, false],
  ])('%p -> %p', (value, expected) => {
    expect(globals.ParserSchema.isIsoDate_(value)).toBe(expected);
  });
});

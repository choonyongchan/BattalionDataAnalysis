/**
 * Tests that the dashboard's read requirements still match the sheet's actual layout.
 *
 * The dashboard resolves columns by header name, which tolerates reordering but not
 * renaming. `src/parser/ParserSchema.js` and `src/formsg/FormSgColumns.js` remain the
 * single source of truth for the layout; these tests assert the dashboard only asks for
 * headers those files still define. Without them, an upstream rename would ship a blank
 * chart instead of a failing build.
 */

import { describe, expect, test } from 'bun:test';
import { loadFormSg } from '../harness.js';
import { parserGlobals } from './fixtures.js';
import {
  COMPANIES,
  FORBIDDEN_HEADERS,
  FORMSG_HEADERS,
  PERSONNEL_HEADERS,
  ROSTER_HEADERS,
  SESSIONS,
  STRENGTH_HEADERS,
  UNIT_TYPE_COMPANY,
} from '../../dashboard/js/model/schema.js';

/** @type {!Object} Apps Script globals for the parade-state pipeline. */
const parser = parserGlobals();

/** @type {!Object} Apps Script globals for the FormSG pipeline. */
const { globals: formSg } = loadFormSg();

describe('dashboard header requirements', () => {
  test('every Strength Data header the dashboard reads exists upstream', () => {
    STRENGTH_HEADERS.forEach((header) => {
      expect(parser.STRENGTH_DATA_COLUMNS).toContain(header);
    });
  });

  test('every Personnel Data header the dashboard reads exists upstream', () => {
    PERSONNEL_HEADERS.forEach((header) => {
      expect(parser.PERSONNEL_DATA_COLUMNS).toContain(header);
    });
  });

  test('every Command Roster header the dashboard reads exists upstream', () => {
    ROSTER_HEADERS.forEach((header) => {
      expect(parser.COMMAND_ROSTER_COLUMNS).toContain(header);
    });
  });

  test('every FormSG header the dashboard reads exists upstream', () => {
    FORMSG_HEADERS.forEach((header) => {
      expect(formSg.FORMSG_COLUMNS).toContain(header);
    });
  });
});

describe('NRIC columns are never requested', () => {
  test('the forbidden headers are real columns, so the exclusion is meaningful', () => {
    FORBIDDEN_HEADERS.forEach((header) => {
      expect(formSg.FORMSG_COLUMNS).toContain(header);
    });
  });

  test('none of them appear in what the dashboard asks for', () => {
    FORBIDDEN_HEADERS.forEach((header) => {
      expect(FORMSG_HEADERS).not.toContain(header);
    });
  });
});

describe('enums mirror the parser', () => {
  test('the company list matches', () => {
    expect(COMPANIES).toEqual(parser.COMPANIES);
  });

  test('the session list matches', () => {
    expect(SESSIONS).toEqual(Object.values(parser.SESSIONS));
  });

  test('the company-total unit type matches', () => {
    expect(UNIT_TYPE_COMPANY).toBe(parser.UNIT_TYPES.COMPANY);
  });
});

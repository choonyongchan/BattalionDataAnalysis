/**
 * Tests for the numbers the dashboard puts on screen.
 *
 * The two that matter most are structural rather than arithmetic: a battalion total says
 * how many companies it covers, and a soldier listed at both FPS and LPS is one soldier.
 * Every case here builds its own rows, so the figures asserted are the figures those
 * rows imply.
 */

import { describe, expect, test } from 'bun:test';
import {
  ABSENCE_REASONS,
  battalionStrength,
  companyRates,
  dutyCountsOn,
  employability,
  leaderboard,
  topReasonsOn,
  unitRates,
} from '../../dashboard/js/model/metrics.js';
import { DUTY_CLASS } from '../../dashboard/js/model/classify.js';
import { buildEpisodes } from '../../dashboard/js/model/episodes.js';
import { toRecords } from '../../dashboard/js/model/normalize.js';
import { PERSONNEL_HEADERS, STRENGTH_HEADERS, TABS } from '../../dashboard/js/model/schema.js';
import { personnelValues, strengthValues } from './fixtures.js';

describe('battalion strength', () => {
  test('platoon rows are excluded, so nothing is double-counted', () => {
    const rows = toRecords(
      strengthValues([
        { date: '2026-06-22', session: 'FPS', company: 'Cougar', platoon: 'Company', unit_type: 'Company', total_strength: 136, total_present: 120 },
        { date: '2026-06-22', session: 'FPS', company: 'Cougar', platoon: '1', unit_type: 'PLATOON', total_strength: 55, total_present: 51 },
        { date: '2026-06-22', session: 'FPS', company: 'Cougar', platoon: 'COMMANDERS', unit_type: 'COMMAND_ELEMENT', total_strength: 25, total_present: 20 },
      ]),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    expect(battalionStrength(rows, '2026-06-22', 'FPS').accountable).toBe(136);
  });
});

describe('duty counts are of soldiers, not rows', () => {
  test('a soldier listed at both FPS and LPS counts once for the day', () => {
    const rows = toRecords(
      personnelValues([
        { date: '2026-06-22', session: 'FPS', four_d: 'C1110', name: 'A', reason_category: 'Att C', reason: 'MC' },
        { date: '2026-06-22', session: 'LPS', four_d: 'C1110', name: 'A', reason_category: 'Att C', reason: 'MC' },
        { date: '2026-06-22', session: 'FPS', four_d: 'C1111', name: 'B', reason_category: 'Att C', reason: 'MC' },
      ]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );
    expect(dutyCountsOn(rows, '2026-06-22').counts[DUTY_CLASS.MC]).toBe(2);
  });

  test('rows naming no soldier are reported, not dropped', () => {
    const rows = toRecords(
      personnelValues([{ date: '2026-06-22', session: 'FPS', reason_category: 'Att C', reason: 'MC' }]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );
    const result = dutyCountsOn(rows, '2026-06-22');
    expect(result.unattributable).toBe(1);
    expect(result.counts[DUTY_CLASS.MC]).toBe(0);
  });
});

describe('employability', () => {
  test('never drives full duty negative when status exceeds present', () => {
    const strengthRows = toRecords(
      strengthValues([
        { date: '2026-06-22', session: 'FPS', company: 'Braves', unit_type: 'Company', total_strength: 10, total_present: 1 },
      ]),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    const personnelRows = toRecords(
      personnelValues([
        { date: '2026-06-22', session: 'FPS', company: 'Braves', four_d: 'A', name: 'A', reason_category: 'Status', reason: 'LD' },
        { date: '2026-06-22', session: 'FPS', company: 'Braves', four_d: 'B', name: 'B', reason_category: 'Status', reason: 'LD' },
        { date: '2026-06-22', session: 'FPS', company: 'Braves', four_d: 'C', name: 'C', reason_category: 'Status', reason: 'LD' },
      ]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );

    const now = employability(strengthRows, personnelRows, '2026-06-22', 'FPS');
    expect(now.restricted).toBe(1);
    expect(now.presentFull).toBe(0);
    expect(now.presentFull + now.restricted + now.absent).toBe(now.accountable);
  });

  test('the reason breakdown excludes Report Sick, which is an event not a state', () => {
    // Including it would count a soldier twice in a breakdown that has to sum.
    const classes = ABSENCE_REASONS.map((reason) => reason.dutyClass);
    expect(classes).not.toContain(DUTY_CLASS.REPORT_SICK);
    expect(classes).not.toContain(DUTY_CLASS.STATUS);
    expect(classes).toContain(DUTY_CLASS.MC);
  });
});

describe('company rates', () => {
  test('a big company with more absence can still have the lower rate', () => {
    const strengthRows = toRecords(
      strengthValues([
        { date: '2026-06-22', session: 'FPS', company: 'Braves', platoon: '1', unit_type: 'PLATOON', total_strength: 100 },
        { date: '2026-06-22', session: 'FPS', company: 'Hercules', platoon: '1', unit_type: 'PLATOON', total_strength: 10 },
      ]),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    const personnelRows = toRecords(
      personnelValues([
        ...['A', 'B', 'C', 'D', 'E'].map((id) => ({
          date: '2026-06-22', session: 'FPS', company: 'Braves', platoon: '1',
          four_d: id, name: id, reason_category: 'Att C', reason: 'MC',
        })),
        ...['X', 'Y'].map((id) => ({
          date: '2026-06-22', session: 'FPS', company: 'Hercules', platoon: '1',
          four_d: id, name: id, reason_category: 'Att C', reason: 'MC',
        })),
      ]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );

    const rates = companyRates(personnelRows, strengthRows, DUTY_CLASS.MC);
    const braves = rates.filter((row) => row.company === 'Braves')[0];
    const hercules = rates.filter((row) => row.company === 'Hercules')[0];

    expect(braves.days).toBeGreaterThan(hercules.days);
    expect(braves.per100).toBeLessThan(hercules.per100);
    // Sorted by rate, so the worst company is first regardless of its size.
    expect(rates[0].company).toBe('Hercules');
  });
});

describe('leaderboard', () => {
  /**
   * Builds episodes for one soldier from start/end date pairs.
   * @param {string} id The soldier's 4D number.
   * @param {Array<Array<string>>} spells Start and end date pairs.
   * @param {string=} category The reason category; defaults to Att C.
   * @returns {Array<!Object>} The soldier's episodes.
   */
  function episodesFor(id, spells, category) {
    const specs = spells.map(([start, end]) => ({
      date: start,
      session: 'FPS',
      company: 'Braves',
      platoon: '1',
      four_d: id,
      name: id,
      reason_category: category || 'Att C',
      start_date: start,
      end_date: end,
      reason: 'MC',
    }));
    return buildEpisodes(toRecords(personnelValues(specs), PERSONNEL_HEADERS, TABS.PERSONNEL));
  }

  test('ranks by episode count first, then by days', () => {
    const episodes = [
      ...episodesFor('FREQ', [
        ['2026-06-01', '2026-06-01'],
        ['2026-06-08', '2026-06-08'],
        ['2026-06-15', '2026-06-15'],
      ]),
      ...episodesFor('LONG', [['2026-06-01', '2026-06-30']]),
    ];

    const ranked = leaderboard(episodes, DUTY_CLASS.MC);
    expect(ranked[0].fourD).toBe('FREQ');
    expect(ranked[0].episodes).toBe(3);
    // The long single absence loses on episodes despite far more days lost, which is the
    // ordering a "most often" question asks for.
    expect(ranked[1].fourD).toBe('LONG');
    expect(ranked[1].daysLost).toBeGreaterThan(ranked[0].daysLost);
  });

  test('counts only the requested duty class', () => {
    const episodes = buildEpisodes(
      toRecords(
        personnelValues([
          { date: '2026-06-01', four_d: 'A', name: 'A', reason_category: 'Att C', start_date: '2026-06-01', end_date: '2026-06-01', reason: 'MC' },
          { date: '2026-06-02', four_d: 'A', name: 'A', reason_category: 'Status', start_date: '2026-06-02', end_date: '2026-06-02', reason: 'LD' },
        ]),
        PERSONNEL_HEADERS,
        TABS.PERSONNEL
      )
    );
    expect(leaderboard(episodes, DUTY_CLASS.MC)).toHaveLength(1);
    expect(leaderboard(episodes, DUTY_CLASS.MC)[0].episodes).toBe(1);
    expect(leaderboard(episodes, DUTY_CLASS.STATUS)).toHaveLength(1);
  });

  test('carries the latest episode date so a stale entry is visible', () => {
    const ranked = leaderboard(
      episodesFor('A', [['2026-06-01', '2026-06-01'], ['2026-07-20', '2026-07-20']]),
      DUTY_CLASS.MC
    );
    expect(ranked[0].lastStart).toBe('2026-07-20');
  });
});

describe('top reasons for one parade', () => {
  test('reads only the requested date and class', () => {
    const rows = toRecords(
      personnelValues([
        { date: '2026-06-22', session: 'FPS', four_d: 'A', name: 'A', reason_category: 'Report Sick', reason: 'Fever and cough' },
        { date: '2026-06-19', session: 'FPS', four_d: 'B', name: 'B', reason_category: 'Report Sick', reason: 'Diarrhoea' },
        { date: '2026-06-22', session: 'FPS', four_d: 'C', name: 'C', reason_category: 'Att C', reason: 'MC (Rash)' },
      ]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );

    const labels = topReasonsOn(rows, '2026-06-22', 'FPS', DUTY_CLASS.REPORT_SICK, 5).map(
      (reason) => reason.label
    );
    expect(labels).toContain('Fever');
    expect(labels).toContain('Cough');
    expect(labels).not.toContain('Diarrhoea');
    expect(labels).not.toContain('Rash / skin');
  });
});

describe('unit rates make companies comparable', () => {
  test('a big company with more MC can have the lower rate', () => {
    const strengthRows = toRecords(
      strengthValues([
        { date: '2026-06-22', session: 'FPS', company: 'Braves', platoon: '1', unit_type: 'PLATOON', total_strength: 100 },
        { date: '2026-06-22', session: 'FPS', company: 'Hercules', platoon: '1', unit_type: 'PLATOON', total_strength: 10 },
      ]),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    const personnelRows = toRecords(
      personnelValues([
        ...['A', 'B', 'C', 'D'].map((name) => ({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon: '1', four_d: name, name, reason_category: 'Att C', reason: 'MC' })),
        { date: '2026-06-22', session: 'FPS', company: 'Hercules', platoon: '1', four_d: 'Z', name: 'Z', reason_category: 'Att C', reason: 'MC' },
        { date: '2026-06-22', session: 'FPS', company: 'Hercules', platoon: '1', four_d: 'Y', name: 'Y', reason_category: 'Att C', reason: 'MC' },
      ]),
      PERSONNEL_HEADERS,
      TABS.PERSONNEL
    );
    const rates = unitRates(personnelRows, strengthRows, DUTY_CLASS.MC);
    const braves = rates.filter((row) => row.company === 'Braves')[0];
    const hercules = rates.filter((row) => row.company === 'Hercules')[0];
    expect(braves.days).toBe(4);
    expect(hercules.days).toBe(2);
    expect(braves.per100).toBe(4);
    expect(hercules.per100).toBe(20);
    expect(hercules.per100).toBeGreaterThan(braves.per100);
  });

  test('an outlier is flagged by z-score, not by raw count', () => {
    const strengthRows = toRecords(
      strengthValues(
        ['1', '2', '3', '4'].map((platoon) => ({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon, unit_type: 'PLATOON', total_strength: 50 }))
      ),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    const specs = [];
    ['1', '2', '3'].forEach((platoon) =>
      specs.push({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon, four_d: 'P' + platoon, name: 'P' + platoon, reason_category: 'Att C', reason: 'MC' })
    );
    for (let i = 0; i < 25; i += 1) {
      specs.push({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon: '4', four_d: 'X' + i, name: 'X' + i, reason_category: 'Att C', reason: 'MC' });
    }
    const rates = unitRates(toRecords(personnelValues(specs), PERSONNEL_HEADERS, TABS.PERSONNEL), strengthRows, DUTY_CLASS.MC);
    const flagged = rates.filter((row) => row.isOutlier).map((row) => row.platoon);
    expect(flagged).toEqual(['4']);
  });

  test('a platoon with unusually LITTLE MC is not flagged as a cluster', () => {
    // One-tailed on purpose: "is the MC localised here" asks about units losing more days
    // than the battalion. A platoon losing fewer would otherwise appear in a list the
    // dashboard captions "worth asking the company about".
    const strengthRows = toRecords(
      strengthValues(
        ['1', '2', '3', '4'].map((platoon) => ({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon, unit_type: 'PLATOON', total_strength: 50 }))
      ),
      STRENGTH_HEADERS,
      TABS.STRENGTH
    );
    const specs = [];
    ['1', '2', '3'].forEach((platoon) => {
      for (let i = 0; i < 12; i += 1) {
        specs.push({ date: '2026-06-22', session: 'FPS', company: 'Braves', platoon, four_d: platoon + '-' + i, name: platoon + '-' + i, reason_category: 'Att C', reason: 'MC' });
      }
    });
    const rates = unitRates(toRecords(personnelValues(specs), PERSONNEL_HEADERS, TABS.PERSONNEL), strengthRows, DUTY_CLASS.MC);
    const quiet = rates.filter((row) => row.platoon === '4')[0];
    expect(quiet.days).toBe(0);
    expect(quiet.z).toBeLessThan(-2);
    expect(quiet.isOutlier).toBe(false);
  });
});

/**
 * Tests for the numbers the dashboard puts on screen.
 *
 * Where possible these run against the real labelled messages, so the figures asserted
 * here are figures a person could check by reading the parade states themselves. The
 * two that matter most are structural rather than arithmetic: a battalion total says how
 * many companies it covers, and a soldier listed at both FPS and LPS is one soldier.
 */

import { describe, expect, test } from 'bun:test';
import {
  ABSENCE_REASONS,
  battalionStrength,
  categoryTrend,
  companyBreakdown,
  companyRates,
  dataQuality,
  durationDistribution,
  dutyCountsOn,
  employability,
  leaderboard,
  symptomCounts,
  topReasonsOn,
  unitRates,
  weekdayDistribution,
} from '../../dashboard/js/model/metrics.js';
import { DUTY_CLASS } from '../../dashboard/js/model/classify.js';
import { buildEpisodes } from '../../dashboard/js/model/episodes.js';
import { toRecords } from '../../dashboard/js/model/normalize.js';
import { PERSONNEL_HEADERS, STRENGTH_HEADERS, TABS } from '../../dashboard/js/model/schema.js';
import { personnelValues, sheetValues, strengthValues } from './fixtures.js';

/** @type {!Object} The labelled data in sheet shape. */
const values = sheetValues();

/** @type {Array<!Object>} Every labelled strength row. */
const strength = toRecords(values.strength, STRENGTH_HEADERS, TABS.STRENGTH);

/** @type {Array<!Object>} Every labelled personnel row. */
const personnel = toRecords(values.personnel, PERSONNEL_HEADERS, TABS.PERSONNEL);

describe('battalion strength', () => {
  test('sums the company-total rows for the date and session', () => {
    const result = battalionStrength(strength, '2026-06-22', 'FPS');
    expect(result.accountable).toBe(464);
    expect(result.present).toBe(394);
    expect(result.absent).toBe(70);
    expect(result.percentPresent).toBeCloseTo(84.91, 1);
  });

  test('names the companies that have not reported', () => {
    const result = battalionStrength(strength, '2026-06-22', 'FPS');
    expect(result.companiesReporting.sort()).toEqual(['Braves', 'Cougar', 'Hercules', 'Stallion']);
    expect(result.companiesMissing.sort()).toEqual(['Archer', 'Scorpion']);
    expect(result.isComplete).toBe(false);
  });

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

  test('a date nobody filed reports zero rather than throwing', () => {
    const result = battalionStrength(strength, '2026-01-01', 'FPS');
    expect(result.accountable).toBe(0);
    expect(result.percentPresent).toBeNull();
    expect(result.companiesMissing).toHaveLength(6);
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

  test('status is counted apart from absence', () => {
    const result = dutyCountsOn(personnel, '2026-06-22');
    expect(result.restrictedTotal).toBe(result.counts[DUTY_CLASS.STATUS]);
    expect(result.absentTotal).toBeGreaterThan(0);
    expect(result.counts[DUTY_CLASS.REPORT_SICK]).toBeGreaterThan(0);
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

describe('category trend', () => {
  test('carries the count, the rate and how much of the battalion filed', () => {
    const trend = categoryTrend(personnel, strength, DUTY_CLASS.MC, 'FPS');
    const day = trend.filter((entry) => entry.date === '2026-06-22')[0];
    expect(day.accountable).toBe(464);
    expect(day.companiesReporting).toBe(4);
    expect(day.isComplete).toBe(false);
    expect(day.per100).toBeCloseTo((day.count / 464) * 100, 6);
  });

  test('reports one point per parade date, oldest first', () => {
    const trend = categoryTrend(personnel, strength, DUTY_CLASS.MC, 'FPS');
    expect(trend.map((point) => point.date)).toEqual(['2026-06-19', '2026-06-22']);
  });
});

describe('employability', () => {
  test('the three parts always sum to accountable strength', () => {
    // The property that makes this drawable as one whole. If it ever failed, the donut
    // would be showing parts of something that is not the total it names.
    const now = employability(strength, personnel, '2026-06-22', 'FPS');
    expect(now.presentFull + now.restricted + now.absent).toBe(now.accountable);
    expect(now.accountable).toBe(464);
    expect(now.present).toBe(394);
  });

  test('status sits inside present, never in absence', () => {
    const now = employability(strength, personnel, '2026-06-22', 'FPS');
    const duty = dutyCountsOn(personnel, '2026-06-22', 'FPS');
    expect(now.restricted).toBe(duty.counts[DUTY_CLASS.STATUS]);
    expect(now.presentFull).toBe(now.present - now.restricted);
    // Absence is the strength gap and nothing else.
    expect(now.absent).toBe(now.accountable - now.present);
  });

  test('reports the disagreement between the absentee list and the strength lines', () => {
    // The labelled data names 79 absentees against a strength gap of 70. Reporting that
    // as a residual is the point: silently trusting either number would hide a mistyped
    // parade state.
    const now = employability(strength, personnel, '2026-06-22', 'FPS');
    expect(now.named).toBe(79);
    expect(now.unaccounted).toBe(now.absent - now.named);
    expect(now.unaccounted).toBeLessThan(0);
  });

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

describe('company breakdown', () => {
  test('covers only the companies that filed, weakest present rate first', () => {
    const rows = companyBreakdown(strength, personnel, '2026-06-22', 'FPS');
    expect(rows.map((row) => row.company)).toEqual(['Stallion', 'Braves', 'Hercules', 'Cougar']);
    const rates = rows.map((row) => row.percentPresent);
    expect(rates).toEqual(rates.slice().sort((a, b) => a - b));
  });

  test('keeps an over-named company visible rather than clamping it to zero', () => {
    // Cougar names more absentees than its strength gap allows in the labelled data.
    const cougar = companyBreakdown(strength, personnel, '2026-06-22', 'FPS').filter(
      (row) => row.company === 'Cougar'
    )[0];
    expect(cougar.named).toBeGreaterThan(cougar.absent);
    expect(cougar.unaccounted).toBeLessThan(0);
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
  test('names what the sick parade reported, most common first', () => {
    const reasons = topReasonsOn(personnel, '2026-06-22', 'FPS', DUTY_CLASS.REPORT_SICK, 3);
    expect(reasons.length).toBeGreaterThan(0);
    const counts = reasons.map((reason) => reason.count);
    expect(counts).toEqual(counts.slice().sort((a, b) => b - a));
  });

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

  test('rows with no platoon land in a visible Unassigned bucket', () => {
    const rates = unitRates(personnel, strength, DUTY_CLASS.MC);
    expect(rates.some((row) => row.platoon === 'Unassigned')).toBe(true);
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

describe('pattern distributions', () => {
  /** @type {Array<!Object>} Episodes over the whole labelled dataset. */
  const episodes = buildEpisodes(personnel);

  test('weekday distribution covers all seven days, Monday first', () => {
    const weekdays = weekdayDistribution(episodes);
    expect(weekdays).toHaveLength(7);
    expect(weekdays[0].name).toBe('Mon');
    expect(weekdays.reduce((total, day) => total + day.count, 0)).toBeGreaterThan(0);
  });

  test('duration distribution is ordered shortest first', () => {
    const durations = durationDistribution(episodes);
    const days = durations.map((entry) => entry.days);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  test('symptom counts travel with their coverage', () => {
    const mc = episodes.filter((episode) => episode.dutyClass === DUTY_CLASS.MC);
    const result = symptomCounts(mc);
    expect(result.total).toBe(mc.length);
    expect(result.described).toBeLessThan(result.total);
    expect(result.coverage).toBeLessThan(1);
    expect(result.counts[0].count).toBeGreaterThanOrEqual(result.counts[result.counts.length - 1].count);
  });
});

describe('data quality is measured, not assumed', () => {
  test('reports the share of rows carrying each key field', () => {
    const quality = dataQuality(personnel);
    expect(quality.total).toBe(235);
    expect(quality.platoon).toBeCloseTo(192 / 235, 3);
    expect(quality.fourD).toBeCloseTo(203 / 235, 3);
    expect(quality.startDate).toBeCloseTo(168 / 235, 3);
  });
});

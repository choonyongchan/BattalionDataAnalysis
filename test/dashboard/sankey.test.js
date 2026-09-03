/**
 * Tests for the report-sick Sankey.
 *
 * The cases worth having are the ones the diagram must not paper over: an event with no
 * FormSG channel at all, an event whose outcome fanned out to several Status buckets, and
 * an outcome four days later that is deliberately too late to count.
 */

import { describe, expect, test } from 'bun:test';
import { toRecords } from '../../dashboard/src/data/records.js';
import { PERSONNEL_HEADERS } from '../../dashboard/src/data/tabs.js';
import { buildEpisodes } from '../../dashboard/src/model/episodes.js';
import { toSubmissions } from '../../dashboard/src/model/formsg.js';
import { reportSickFlow } from '../../dashboard/src/model/sankey.js';

/**
 * Builds Personnel Data records from column-keyed row specs.
 * @param {Array<!Object>} specs Partial records; unlisted headers read as ''.
 * @returns {Array<!Object>} Normalised records.
 */
function personnelRows(specs) {
  const values = [
    PERSONNEL_HEADERS.slice(),
    ...specs.map((spec) => PERSONNEL_HEADERS.map((header) => (header in spec ? spec[header] : ''))),
  ];
  return toRecords(values, PERSONNEL_HEADERS, 'Personnel Data');
}

/**
 * Builds a FormSG submission via the real normaliser, filling in defaults.
 * @param {!Object} overrides Fields to set on top of the defaults.
 * @returns {!Object} One normalised submission.
 */
function submission(overrides) {
  const row = {
    Timestamp: '2026-07-20T08:00:00',
    RANK: 'REC',
    '[Myinfo] Name': 'ZED',
    '4D Number (REC Only)': '1101',
    'Unit & Coy': '40 SAR / Archer',
    'Report Sick Type': 'Report Sick In-Camp (RSI)',
    ...overrides,
  };
  return toSubmissions([row])[0];
}

/**
 * Sums link values between two node names, 0 when there is no such link.
 * @param {Array<{source: string, target: string, value: number}>} links The flow's links.
 * @param {string} source Source node name.
 * @param {string} target Target node name.
 * @returns {number} The link's value.
 */
function linkValue(links, source, target) {
  const link = links.find((entry) => entry.source === source && entry.target === target);
  return link ? link.value : 0;
}

describe('reportSickFlow', () => {
  test('an event in both sources flows through Source: Both with its FormSG type', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
    ]);
    const episodes = buildEpisodes(personnel);
    const submissions = [submission({})];
    const flow = reportSickFlow({ personnel, episodes, submissions, from: null, to: null });

    expect(linkValue(flow.links, 'Source: Both', 'Type: RSI')).toBe(1);
    expect(flow.coverage.sourceCounts).toEqual({ paradeOnly: 0, both: 1, formsgOnly: 0 });
  });

  test('a parade-state-only event has no type', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Scorpion', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({ personnel, episodes, submissions: [], from: null, to: null });

    expect(linkValue(flow.links, 'Source: Parade state only', 'Type: Type not recorded')).toBe(1);
  });

  test('a FormSG-only submission is not dropped', () => {
    const flow = reportSickFlow({
      personnel: [],
      episodes: [],
      submissions: [submission({ '4D Number (REC Only)': '2201', '[Myinfo] Name': 'LIM' })],
      from: null,
      to: null,
    });
    expect(flow.coverage.sourceCounts.formsgOnly).toBe(1);
    expect(linkValue(flow.links, 'Source: FormSG only', 'Type: RSI')).toBe(1);
  });

  test('an MC starting the next day is the outcome', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-21', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Att C', start_date: '2026-07-21', end_date: '2026-07-23', num_days: 3 },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({ personnel, episodes, submissions: [], from: null, to: null });
    expect(linkValue(flow.links, 'Type: Type not recorded', 'Outcome: MC')).toBe(1);
  });

  test('a Status starting two days later still counts; four days later does not', () => {
    const inWindow = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-22', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Status', reason: 'Excuse RMJ', start_date: '2026-07-22' },
    ]);
    const withinFlow = reportSickFlow({
      personnel: inWindow,
      episodes: buildEpisodes(inWindow),
      submissions: [],
      from: null,
      to: null,
    });
    expect(linkValue(withinFlow.links, 'Type: Type not recorded', 'Outcome: Status')).toBe(1);

    const tooLate = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1102', name: 'ADA', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-24', session: 'FPS', company: 'Archer', four_d: '1102', name: 'ADA', reason_category: 'Status', reason: 'Excuse RMJ', start_date: '2026-07-24' },
    ]);
    const lateFlow = reportSickFlow({
      personnel: tooLate,
      episodes: buildEpisodes(tooLate),
      submissions: [],
      from: null,
      to: null,
    });
    expect(linkValue(lateFlow.links, 'Type: Type not recorded', 'Outcome: Status')).toBe(0);
    expect(linkValue(lateFlow.links, 'Type: Type not recorded', 'Outcome: None recorded')).toBe(1);
  });

  test('MC wins when a soldier has both an MC and a Status in the window', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-21', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Att C', start_date: '2026-07-21', end_date: '2026-07-22', num_days: 2 },
      { date: '2026-07-21', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Status', reason: 'Excuse RMJ', start_date: '2026-07-21' },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({ personnel, episodes, submissions: [], from: null, to: null });
    expect(linkValue(flow.links, 'Type: Type not recorded', 'Outcome: MC')).toBe(1);
    expect(linkValue(flow.links, 'Type: Type not recorded', 'Outcome: Status')).toBe(0);
  });

  test('a multi-restriction Status outcome fans out to several buckets, flagged as such', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-21', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Status', reason: 'Excuse RMJ, Heavy Load, Kneeling', start_date: '2026-07-21' },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({ personnel, episodes, submissions: [], from: null, to: null });
    expect(linkValue(flow.links, 'Outcome: Status', 'Status: Excuse RMJ')).toBe(1);
    expect(linkValue(flow.links, 'Outcome: Status', 'Status: Excuse Heavy Load')).toBe(1);
    expect(linkValue(flow.links, 'Outcome: Status', 'Status: Excuse Kneeling/Squatting')).toBe(1);
    expect(flow.coverage.statusMultiLabelled).toBe(true);
  });

  test('a company with no FormSG rows at all is named in coverage', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Scorpion', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({ personnel, episodes, submissions: [], from: null, to: null });
    expect(flow.coverage.companiesWithNoFormSg).toContain('Scorpion');
  });

  test('links sum correctly per stage: Source outflow equals total events', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1102', name: 'ADA', reason_category: 'Report Sick', start_date: '2026-07-20' },
    ]);
    const episodes = buildEpisodes(personnel);
    const submissions = [submission({ '4D Number (REC Only)': '1101' })];
    const flow = reportSickFlow({ personnel, episodes, submissions, from: null, to: null });
    const sourceOutflow = flow.links
      .filter((link) => link.source.startsWith('Source:'))
      .reduce((sum, link) => sum + link.value, 0);
    expect(sourceOutflow).toBe(flow.coverage.totalEvents);
    expect(flow.coverage.totalEvents).toBe(2);
  });

  test('an empty range produces empty nodes and links rather than throwing', () => {
    const flow = reportSickFlow({ personnel: [], episodes: [], submissions: [], from: null, to: null });
    expect(flow.nodes).toEqual([]);
    expect(flow.links).toEqual([]);
    expect(flow.coverage.totalEvents).toBe(0);
  });

  test('a date range excludes events outside it', () => {
    const personnel = personnelRows([
      { date: '2026-07-20', session: 'FPS', company: 'Archer', four_d: '1101', name: 'ZED', reason_category: 'Report Sick', start_date: '2026-07-20' },
      { date: '2026-08-20', session: 'FPS', company: 'Archer', four_d: '1102', name: 'ADA', reason_category: 'Report Sick', start_date: '2026-08-20' },
    ]);
    const episodes = buildEpisodes(personnel);
    const flow = reportSickFlow({
      personnel,
      episodes,
      submissions: [],
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(flow.coverage.totalEvents).toBe(1);
  });
});

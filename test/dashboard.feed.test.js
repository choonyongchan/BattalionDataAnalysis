/**
 * Tests for src/dashboard/DashboardFeed.js — the password-guarded read the dashboard
 * makes.
 *
 * Two things here are worth more than the rest of the file.
 *
 * **The guard must fail closed.** This route is the only thing between a static page
 * on the public internet and the battalion's names and medical reasons. A wrong
 * password, a missing password, an unset script property and a body that is not JSON
 * must all return no rows — and the tests assert the absence of data, not merely the
 * presence of an error, because an endpoint that returns `{ok: false}` *and* the tabs
 * would pass a laxer check.
 *
 * **Dates must survive the trip.** `JSON.stringify` renders a Date in UTC, so a
 * parade state dated the 22nd in Singapore leaves as `2026-06-21T16:00:00Z` and every
 * date in the dashboard slides back one day. That is a wrong dashboard rather than a
 * broken one — nothing errors, the numbers just land on the wrong day — so it is
 * pinned here at the boundary where the conversion happens.
 */

import { describe, expect, test } from 'bun:test';
import { DASHBOARD_TEST_PASSWORD, loadDashboard, postEvent } from './harness.js';

/** A minimal Strength Data tab. @type {!Array<!Array<*>>} */
const STRENGTH_TAB = [
  ['parade_response_id', 'date', 'session', 'company', 'unit_type', 'total_strength'],
  ['r1', new Date('2026-06-22T00:00:00+08:00'), 'FPS', 'Archer', 'Company', 136],
];

/**
 * A parade-state intake tab whose message body holds exactly what must never travel.
 * @type {!Array<!Array<*>>}
 */
const RAW_RESPONSES_TAB = [
  ['Timestamp', 'Drop your Parade State here', 'wa_message_id', 'parade_response_id', 'error'],
  [
    new Date('2026-06-22T07:12:00+08:00'),
    'REPORT SICK: 01\nREC LEE YIKZH (4405)\nNRIC: T0573638I\nDIAGNOSIS: COUGH',
    'wamid.1',
    'Archer_2026-06-22_FPS',
    '',
  ],
];

/**
 * Seeds every tab the dashboard asks for.
 * @returns {!Object<string, !Array<!Array<*>>>} Tab name to values.
 */
function allTabs() {
  return {
    'Strength Data': STRENGTH_TAB,
    'Personnel Data': [['name', 'reason_category'], ['TAN AH KOW', 'Att C']],
    'Command Roster': [['date', 'role', 'name'], ['2026-06-22', 'CDO', '2LT RYAN']],
    'Report Sick FormSG Responses': [['Timestamp'], [new Date('2026-08-31T14:47:26+08:00')]],
    'Parade State Responses': RAW_RESPONSES_TAB,
    'Public Holidays': [['date', 'name'], ['2026-08-09', 'National Day']],
    Rotations: [['name', 'start_date', 'end_date'], ['Rot 1', '2026-07-01', '2026-09-30']],
  };
}

/**
 * Posts a body to the dashboard route and parses the reply.
 * @param {!Object} env A loadDashboard environment.
 * @param {*} body The request body.
 * @returns {!Object} The parsed reply.
 */
function ask(env, body) {
  return JSON.parse(env.globals.doPost(postEvent(body, 'dashboard')).getContent());
}

describe('the password guard', () => {
  test('returns the tabs when the password is right', () => {
    const env = loadDashboard({ tabs: allTabs() });
    const reply = ask(env, { password: DASHBOARD_TEST_PASSWORD });

    expect(reply.ok).toBe(true);
    expect(Object.keys(reply.tabs).sort()).toEqual([
      'Command Roster',
      'Parade State Responses',
      'Personnel Data',
      'Public Holidays',
      'Report Sick FormSG Responses',
      'Rotations',
      'Strength Data',
    ]);
  });

  test.each([
    ['a wrong password', { password: 'wrong' }],
    ['no password field', {}],
    ['an empty password', { password: '' }],
    ['a null password', { password: null }],
  ])('returns no data for %s', (_label, body) => {
    const env = loadDashboard({ tabs: allTabs() });
    const reply = ask(env, body);

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('unauthorised');
    // The absence of data is the point, not the presence of the error.
    expect(reply.tabs).toBeUndefined();
  });

  test('fails closed when DASHBOARD_PASSWORD was never set', () => {
    // The dangerous default: an unconfigured property must lock the route, never
    // open it. A deployment that has not been given a password yet is not a
    // deployment that serves the battalion's data to anyone who asks.
    const env = loadDashboard({ password: null, tabs: allTabs() });

    expect(ask(env, { password: '' }).error).toBe('unauthorised');
    expect(ask(env, { password: 'anything' }).error).toBe('unauthorised');
    expect(ask(env, { password: 'undefined' }).tabs).toBeUndefined();
  });

  test('rejects an empty-string property rather than matching an empty password', () => {
    const env = loadDashboard({ password: '', tabs: allTabs() });
    expect(ask(env, { password: '' }).error).toBe('unauthorised');
  });

  test('rejects a body that is not JSON, and one that is not an object', () => {
    const env = loadDashboard({ tabs: allTabs() });

    expect(ask(env, 'not json at all').error).toBe('bad_request');
    expect(ask(env, '"a bare string"').error).toBe('bad_request');
    expect(ask(env, 'null').error).toBe('bad_request');
  });

  test('survives a request with no body and no event object', () => {
    const env = loadDashboard({ tabs: allTabs() });

    expect(JSON.parse(env.globals.DashboardFeed.handlePost(undefined).getContent()).error).toBe(
      'bad_request'
    );
    expect(JSON.parse(env.globals.DashboardFeed.handlePost({}).getContent()).error).toBe(
      'bad_request'
    );
  });

  test('is case-sensitive, and does not accept a prefix of the password', () => {
    const env = loadDashboard({ tabs: allTabs() });

    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD.toUpperCase() }).ok).toBe(false);
    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD.slice(0, -1) }).ok).toBe(false);
    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD + 'x' }).ok).toBe(false);
  });
});

describe('the lockout', () => {
  test('stops answering after the failure limit, even with the right password', () => {
    const env = loadDashboard({ tabs: allTabs() });
    const limit = env.globals.FAILURE_LIMIT;

    for (let attempt = 0; attempt < limit; attempt++) {
      expect(ask(env, { password: 'wrong' }).error).toBe('unauthorised');
    }

    // The whole point: past the limit the correct password is refused too, so a
    // guesser cannot keep going and the owner learns something is wrong.
    const reply = ask(env, { password: DASHBOARD_TEST_PASSWORD });
    expect(reply.error).toBe('locked_out');
    expect(reply.tabs).toBeUndefined();
  });

  test('does not lock out one attempt short of the limit', () => {
    const env = loadDashboard({ tabs: allTabs(), failures: 9 });
    expect(env.globals.FAILURE_LIMIT).toBe(10);
    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD }).ok).toBe(true);
  });

  test('forgets failures once the right password arrives', () => {
    const env = loadDashboard({ tabs: allTabs(), failures: 5 });
    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD }).ok).toBe(true);
    expect(env.cache.dashboard_failed_attempts).toBeUndefined();
  });

  test('re-arms the lockout window on every failure', () => {
    // A fixed deadline could be waited out; re-setting the expiry means sustained
    // guessing keeps itself locked out.
    const env = loadDashboard({ tabs: allTabs() });
    ask(env, { password: 'wrong' });
    ask(env, { password: 'wrong' });

    expect(env.cachePuts).toHaveLength(2);
    env.cachePuts.forEach((put) => expect(put.seconds).toBe(env.globals.LOCKOUT_SECONDS));
    expect(env.cache.dashboard_failed_attempts).toBe('2');
  });

  test('treats an unreadable counter as no failures rather than a lockout', () => {
    // Script cache entries can be evicted or arrive as junk. Neither should lock the
    // CO out of the dashboard.
    const env = loadDashboard({ tabs: allTabs() });
    env.cache.dashboard_failed_attempts = 'not a number';

    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD }).ok).toBe(true);
  });
});

describe('what comes back', () => {
  test('renders a date-only cell as its calendar date in the spreadsheet timezone', () => {
    // The bug this pins: JSON.stringify would render this Date as
    // "2026-06-21T16:00:00.000Z" and every date in the dashboard would slide back a
    // day. Nothing would error; the numbers would land on the wrong date.
    const env = loadDashboard({ tabs: allTabs() });
    const rows = ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Strength Data'];

    expect(rows[1][1]).toBe('2026-06-22');
  });

  test('keeps the time of day on a cell that has one', () => {
    const env = loadDashboard({ tabs: allTabs() });
    const rows = ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs[
      'Report Sick FormSG Responses'
    ];

    expect(rows[1][0]).toBe('2026-08-31T14:47:26');
  });

  test('holds the date at midnight regardless of the host machine timezone', () => {
    // The suite must not pass only in Singapore. This asserts the boundary the feed
    // is actually asked to hold: the date is decided by the spreadsheet's timezone.
    const env = loadDashboard({ tabs: allTabs(), timeZone: 'UTC' });
    const rows = ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Strength Data'];

    // Midnight on the 22nd in Singapore is 16:00 on the 21st in UTC, and a
    // spreadsheet set to UTC is entitled to say so.
    expect(rows[1][1]).toBe('2026-06-21T16:00:00');
  });

  test('includes the header row, so columns resolve by name', () => {
    const env = loadDashboard({ tabs: allTabs() });
    const rows = ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Strength Data'];

    expect(rows[0]).toEqual([
      'parade_response_id',
      'date',
      'session',
      'company',
      'unit_type',
      'total_strength',
    ]);
  });

  test('passes numbers through as numbers', () => {
    const env = loadDashboard({ tabs: allTabs() });
    const rows = ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Strength Data'];

    expect(rows[1][5]).toBe(136);
  });

  test('omits a tab that does not exist instead of failing the request', () => {
    // The FormSG intake is optional. A battalion that has not set it up should get a
    // working dashboard, not an error naming a tab they have never heard of.
    const tabs = allTabs();
    delete tabs['Report Sick FormSG Responses'];
    const env = loadDashboard({ tabs });
    const reply = ask(env, { password: DASHBOARD_TEST_PASSWORD });

    expect(reply.ok).toBe(true);
    expect(reply.tabs['Report Sick FormSG Responses']).toBeUndefined();
    expect(reply.tabs['Strength Data']).toBeDefined();
    expect(env.logs.join('\n')).toContain('Report Sick FormSG Responses');
  });

  test('returns an empty array for a tab that exists but holds nothing', () => {
    const tabs = allTabs();
    tabs['Personnel Data'] = [];
    const env = loadDashboard({ tabs });

    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Personnel Data']).toEqual([]);
  });

  test('asks for exactly the tabs the dashboard reads', () => {
    const env = loadDashboard({ tabs: allTabs() });
    expect(env.globals.DASHBOARD_TABS).toEqual([
      'Strength Data',
      'Personnel Data',
      'Command Roster',
      'Report Sick FormSG Responses',
      'Public Holidays',
      'Rotations',
    ]);
  });

  test('reads the parade-state tab as a projection of two columns', () => {
    const env = loadDashboard({ tabs: allTabs() });
    expect(env.globals.DASHBOARD_TAB_PROJECTIONS['Parade State Responses']).toEqual([
      'Timestamp',
      'parade_response_id',
    ]);
  });

  test('the parade-state message body never crosses the boundary', () => {
    // This is the assertion the projection exists for. The body is free text a duty
    // commander typed, and real messages carry NRICs, full names and diagnoses in one
    // blob. Asserting on the whole reply, rather than on that one tab, is deliberate:
    // it catches the body arriving anywhere at all.
    const env = loadDashboard({ tabs: allTabs() });
    const reply = ask(env, { password: DASHBOARD_TEST_PASSWORD });

    expect(JSON.stringify(reply)).not.toContain('T0573638I');
    expect(JSON.stringify(reply)).not.toContain('Drop your Parade State here');
    expect(reply.tabs['Parade State Responses']).toEqual([
      ['Timestamp', 'parade_response_id'],
      ['2026-06-22T07:12:00', 'Archer_2026-06-22_FPS'],
    ]);
  });

  test('a projected tab missing a column returns the ones it has, not blanks', () => {
    // The dashboard resolves columns by name and reports a missing one loudly. Padding
    // the row here would hand it a column of empty strings under the right header, which
    // reads as "every parade state was filed at no time in particular".
    const tabs = allTabs();
    tabs['Parade State Responses'] = [
      ['Drop your Parade State here', 'parade_response_id'],
      ['some text', 'Archer_2026-06-22_FPS'],
    ];
    const env = loadDashboard({ tabs });

    expect(ask(env, { password: DASHBOARD_TEST_PASSWORD }).tabs['Parade State Responses']).toEqual([
      ['parade_response_id'],
      ['Archer_2026-06-22_FPS'],
    ]);
  });

  test('never writes to the spreadsheet', () => {
    // The feed's whole contract is read-only, and this is the assertion that holds it:
    // FakeSheet records every write it receives, so an accidental setValue or
    // appendRow anywhere in the read path changes this snapshot.
    const env = loadDashboard({ tabs: allTabs() });
    const snapshot = () =>
      JSON.stringify(
        Object.keys(env.sheets)
          .sort()
          .map((name) => [name, env.sheets[name].rows, env.sheets[name].numberFormats])
      );

    const before = snapshot();
    ask(env, { password: DASHBOARD_TEST_PASSWORD });
    ask(env, { password: 'wrong' });
    ask(env, 'not json');

    expect(snapshot()).toBe(before);
    Object.keys(env.sheets).forEach((name) =>
      expect(env.sheets[name].numberFormats).toEqual([])
    );
  });
});

/**
 * Tests for src/WebApp.js — the single doPost that fronts all three routes.
 *
 * Worth its own file because a routing mistake here is the failure mode that hurts
 * most: ContentService cannot set a status code, so a misrouted Plumber POST is
 * answered 200, recorded as delivered, and never retried. Rows stop arriving with
 * nothing to say why.
 *
 * The parade-state and dashboard branches are recording stubs (see harness.js) — this
 * asserts which branch a request took, not what the handler then did with it. The
 * dashboard feed's own behaviour is covered by dashboard.feed.test.js.
 */

import { describe, expect, test } from 'bun:test';
import { loadFormSg, postEvent, samplePayload } from './harness.js';

describe('doPost routing', () => {
  test('route=reportsick reaches the FormSG intake and writes a row', () => {
    const env = loadFormSg();
    const reply = JSON.parse(env.globals.doPost(postEvent(samplePayload(), 'reportsick')).getContent());

    expect(reply.ok).toBe(true);
    expect(reply.appended).toBe(true);
    // Row 1 is the header the sheet was created with; row 2 is the submission.
    const rows = env.sheetOf(env.globals.FORMSG_SHEET_NAME).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('90fb87fbc8ad7733e37726a5');
    expect(env.triggerCalls).toHaveLength(0);
  });

  test('route=paradestate reaches the parade-state intake and writes no FormSG row', () => {
    const env = loadFormSg();
    const event = postEvent({ token: 't', messageId: 'm1', text: 'PARADE STATE' }, 'paradestate');
    const reply = JSON.parse(env.globals.doPost(event).getContent());

    expect(reply.routedTo).toBe('paradestate');
    expect(env.triggerCalls).toHaveLength(1);
    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME)).toBeNull();
  });

  test.each([
    ['no route parameter', null],
    ['an empty route', ''],
    ['an unknown route', 'reportsick2'],
    ['a route differing only in case', 'ReportSick'],
    ['a dashboard route differing only in case', 'Dashboard'],
  ])('rejects %s without reaching either intake', (_label, route) => {
    const env = loadFormSg();
    const reply = JSON.parse(env.globals.doPost(postEvent(samplePayload(), route)).getContent());

    expect(reply).toEqual({ ok: false, error: 'unknown_route' });
    expect(env.triggerCalls).toHaveLength(0);
    expect(env.dashboardCalls).toHaveLength(0);
    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME)).toBeNull();
  });

  test('names the likely cause when a request arrives unrouted', () => {
    // The one misconfiguration that fails invisibly: a Plumber URL that was never
    // updated to carry ?route=reportsick. The log line is the whole diagnosis.
    const env = loadFormSg();
    env.globals.doPost(postEvent(samplePayload(), null));

    expect(env.logs.join('\n')).toContain('reportsick');
  });

  test('survives a request with no event object at all', () => {
    const env = loadFormSg();
    const reply = JSON.parse(env.globals.doPost(undefined).getContent());

    expect(reply.error).toBe('unknown_route');
  });

  test('route=dashboard reaches the feed and writes nothing', () => {
    const env = loadFormSg();
    const event = postEvent({ password: 'whatever' }, 'dashboard');
    const reply = JSON.parse(env.globals.doPost(event).getContent());

    expect(reply.routedTo).toBe('dashboard');
    expect(env.dashboardCalls).toHaveLength(1);
    // The read-only route must not touch either intake's tab.
    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME)).toBeNull();
    expect(env.triggerCalls).toHaveLength(0);
  });

  test('exposes the three route names it accepts', () => {
    const env = loadFormSg();
    expect(env.globals.WEB_APP_ROUTES).toEqual({
      PARADE_STATE: 'paradestate',
      REPORT_SICK: 'reportsick',
      DASHBOARD: 'dashboard',
    });
  });
});

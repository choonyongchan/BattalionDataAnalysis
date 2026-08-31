/**
 * Tests for the webhook path: Plumber's relayed submission to a sheet row.
 */

import { describe, expect, test } from 'bun:test';
import { loadFormSg, postEvent, samplePayload } from './harness.js';

/**
 * Posts a body through doPost and returns the parsed JSON reply alongside the
 * environment it ran in.
 * @param {*} body The request body.
 * @param {!Object=} options Passed through to loadFormSg.
 * @returns {{reply: !Object, env: !Object, rows: !Array<!Array<*>>}} The reply, the
 *     loaded environment, and the responses tab's rows.
 */
function post(body, options) {
  const env = loadFormSg(options);
  const reply = JSON.parse(env.globals.doPost(postEvent(body)).getContent());
  const sheet = env.sheetOf(env.globals.FORMSG_SHEET_NAME);
  return { reply, env, rows: sheet ? sheet.rows : [] };
}

describe('doPost', () => {
  test('maps a Plumber payload onto the full column layout', () => {
    const { reply, rows, env } = post(samplePayload());

    expect(reply.ok).toBe(true);
    expect(reply.appended).toBe(true);
    expect(reply.submissionId).toBe('90fb87fbc8ad7733e37726a5');

    // Row 1 is the header the sheet was created with; row 2 is the submission.
    expect(rows[0]).toEqual(env.globals.FORMSG_COLUMNS);

    const row = rows[1];
    expect(row).toHaveLength(13);
    expect(row[0]).toBe('90fb87fbc8ad7733e37726a5');
    expect(row[1]).toBeInstanceOf(Date);
    expect(row[1].toISOString()).toBe('2026-08-31T06:47:26.417Z');
    expect(row[2]).toBe('Success');
    expect(row[3]).toBe('LTA');
    expect(row[4]).toBe('PHUA CHU KANG');
    expect(row[6]).toBe('8 SAB');
    expect(row[11]).toBe('S1234568B');
  });

  test('leaves Masked NRIC blank, since Plumber never supplies it', () => {
    const { rows, env } = post(samplePayload());
    expect(rows[1][env.globals.FORMSG_COLUMNS.indexOf('Masked NRIC')]).toBe('');
  });

  test('writes missing, null and absent answers as empty cells', () => {
    const payload = samplePayload();
    payload.answers['Unit & Coy'] = null;
    delete payload.answers.RANK;

    const { rows } = post(payload);
    expect(rows[1][3]).toBe('');
    expect(rows[1][6]).toBe('');
  });

  test('writes an unparseable submittedAt as its raw string, never Invalid Date', () => {
    const { rows } = post(samplePayload({ submittedAt: 'sometime last Tuesday' }));
    expect(rows[1][1]).toBe('sometime last Tuesday');
  });

  test('accepts a free-text answer containing quotes and newlines', () => {
    const reason = 'He said "ouch".\nThen he said it again — it\'s sore.';
    const payload = samplePayload();
    payload.answers['Reason for Reporting Sick (Keep Brief)'] = reason;

    const { reply, rows } = post(payload);
    expect(reply.ok).toBe(true);
    expect(rows[1][8]).toBe(reason);
  });
});

describe('doPost rejections', () => {
  test.each([
    ['a body with no submissionId', { submittedAt: '2026-08-31T14:47:26.417+08:00', answers: {} }],
    ['an empty object', {}],
    ['malformed JSON', '{"submissionId": "abc"'],
  ])('rejects %s as a permanent bad_request without writing a row', (_label, body) => {
    const { reply, rows } = post(body);
    expect(reply).toEqual({ ok: false, error: 'bad_request' });
    expect(rows).toHaveLength(0);
  });

  test('rejects a request with no body at all', () => {
    const env = loadFormSg();
    const reply = JSON.parse(env.globals.doPost({ parameter: { route: 'reportsick' } }).getContent());
    expect(reply.error).toBe('bad_request');
  });

  test("names FormSG's own webhook envelope, which fails invisibly otherwise", () => {
    // The misconfiguration this guards: pasting the web app URL into FormSG's webhook
    // field instead of Plumber's. The id is nested under `data`, so the request is
    // rejected — but the 200 makes FormSG record it as delivered and never retry.
    const { reply, rows, env } = post({
      data: {
        submissionId: '90fb87fbc8ad7733e37726a5',
        created: '2026-08-31T14:47:26.417+08:00',
        encryptedContent: 'Ryy4hc0wQIs9bPand0gzRvZLCQzEGzkAKr6f30jhwjI=;mzTXHNMF2K7j:JrWJ3rrv66Ex',
      },
    });

    expect(reply).toEqual({ ok: false, error: 'bad_request' });
    expect(rows).toHaveLength(0);
    expect(env.logs.join('\n')).toContain('point the form\'s webhook at Plumber, not here');
  });

  test('does not mistake a legitimate answer named "data" for a FormSG envelope', () => {
    const payload = samplePayload();
    payload.answers.data = 'some answer';

    const { reply } = post(payload);
    expect(reply.ok).toBe(true);
  });
});

describe('authorisation', () => {
  test('appends the row when the request carries the right token', () => {
    const { reply, rows } = post(samplePayload());
    expect(reply.ok).toBe(true);
    expect(reply.appended).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test('rejects a wrong token as unauthorised without writing a row', () => {
    const { reply, rows } = post(samplePayload({ token: 'wrong' }));
    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
    expect(rows).toHaveLength(0);
  });

  test('rejects a submission that carries no token at all', () => {
    const payload = samplePayload();
    delete payload.token;
    const { reply, rows } = post(payload);
    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
    expect(rows).toHaveLength(0);
  });

  test('fails closed when FORMSG_INGEST_TOKEN was never set', () => {
    // An unset property must reject everything, not wave everything through.
    const { reply, rows } = post(samplePayload(), { token: null });
    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
    expect(rows).toHaveLength(0);
  });

  test('rejects an empty token even when the property is somehow empty', () => {
    const { reply } = post(samplePayload({ token: '' }), { token: '' });
    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
  });

  test('checks body shape before the token, so garbage stays bad_request', () => {
    const { reply } = post('{"submissionId": "abc"', { token: null });
    expect(reply).toEqual({ ok: false, error: 'bad_request' });
  });
});

describe('deduplication', () => {
  test('a replayed submissionId appends nothing', () => {
    const env = loadFormSg();
    const event = postEvent(samplePayload());

    const first = JSON.parse(env.globals.doPost(event).getContent());
    const second = JSON.parse(env.globals.doPost(event).getContent());

    expect(first.appended).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.appended).toBe(false);
    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME).rows).toHaveLength(2);
  });

  test('a different submissionId still appends', () => {
    const env = loadFormSg();
    env.globals.doPost(postEvent(samplePayload()));
    env.globals.doPost(postEvent(samplePayload({ submissionId: 'a-second-submission' })));

    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME).rows).toHaveLength(3);
  });
});

describe('transient failures', () => {
  test('throws when the script lock cannot be acquired, so Plumber retries', () => {
    const env = loadFormSg({ lockAcquired: false });
    expect(() => env.globals.doPost(postEvent(samplePayload()))).toThrow(
      'Could not acquire script lock within 30s'
    );
    expect(env.sheetOf(env.globals.FORMSG_SHEET_NAME)).toBeNull();
  });
});

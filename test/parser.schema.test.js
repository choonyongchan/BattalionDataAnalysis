/**
 * Tests for the response schema and the response parsing around it.
 *
 * Two failure modes this guards, both of which fail late and confusingly otherwise:
 *
 * 1. **Strict-mode violations.** Structured Outputs with `strict: true` rejects a
 *    schema where a property is missing from `required`, or where nullability is
 *    expressed as a `nullable` flag instead of `type: [t, 'null']`. The API rejects
 *    the whole request, so every extraction fails at once, and the only clue is an
 *    HTTP 400 on a row.
 * 2. **Enum drift.** The schema's enums and ParserSchema's constants are two
 *    statements of the same fact. When they disagree the model returns a value the
 *    validator then rejects, so a row fails for a reason no message caused — which is
 *    exactly how `unit_type: "COMMANDERS"` sat in a golden label file unnoticed.
 */

import { describe, expect, test } from 'bun:test';
import { loadParser } from './harness.js';

/** @type {!Object} Bindings shared by every test here; the schema is a pure value. */
const { globals } = loadParser();

/** @type {!Object} The schema as sent to the API. */
const wrapper = globals.ParserAi.buildResponseSchema_();

/**
 * Walks every object schema in the tree, so an invariant is checked everywhere and
 * not just at the top level.
 * @param {!Object} node A JSON Schema node.
 * @param {string} path Human-readable location, for assertion messages.
 * @returns {!Array<!Array<*>>} [path, node] pairs for every type-object node.
 */
function objectNodes(node, path) {
  const found = [];
  if (!node || typeof node !== 'object') {
    return found;
  }
  if (node.type === 'object') {
    found.push([path, node]);
    Object.keys(node.properties || {}).forEach((key) => {
      found.push(...objectNodes(node.properties[key], `${path}.${key}`));
    });
  }
  if (node.type === 'array') {
    found.push(...objectNodes(node.items, `${path}[]`));
  }
  return found;
}

/** @type {!Array<!Array<*>>} Every object schema in the tree. */
const NODES = objectNodes(wrapper.schema, 'root');

describe('the schema envelope', () => {
  test('asks for strict mode, which is what makes the shape guaranteed', () => {
    expect(wrapper.strict).toBe(true);
    expect(wrapper.name).toBe('parade_state_extraction');
  });

  test('describes four object levels: root, platoon, command team, personnel', () => {
    expect(NODES.map(([path]) => path)).toEqual([
      'root',
      'root.platoons[]',
      'root.command_team[]',
      'root.personnel[]',
    ]);
  });
});

describe('strict-mode invariants hold at every level', () => {
  test.each(NODES)('%s lists every property in required', (path, node) => {
    expect(Object.keys(node.properties).sort()).toEqual([...node.required].sort());
  });

  test.each(NODES)('%s forbids additional properties', (_path, node) => {
    expect(node.additionalProperties).toBe(false);
  });

  test.each(NODES)('%s expresses nullability as a type union, never a nullable flag', (path, node) => {
    Object.entries(node.properties).forEach(([key, property]) => {
      expect(property).not.toHaveProperty('nullable', `${path}.${key} uses a nullable flag`);
      if (Array.isArray(property.type)) {
        expect(property.type).toContain('null');
      }
    });
  });
});

describe('the schema enums match their constants', () => {
  test('unit_type covers exactly UNIT_TYPES', () => {
    const property = wrapper.schema.properties.platoons.items.properties.unit_type;
    expect([...property.enum].sort()).toEqual(Object.values(globals.UNIT_TYPES).sort());
  });

  test('reason_category covers exactly REASON_CATEGORIES', () => {
    const property = wrapper.schema.properties.personnel.items.properties.reason_category;
    expect(property.enum).toEqual(globals.REASON_CATEGORIES);
  });

  test('role covers exactly COMMAND_ROLES', () => {
    const property = wrapper.schema.properties.command_team.items.properties.role;
    expect(property.enum).toEqual(globals.COMMAND_ROLES);
  });

  test('session covers both sessions plus null', () => {
    // Nullable because a message that names no session must fail validation with a
    // readable reason, rather than being forced into an arbitrary one.
    const property = wrapper.schema.properties.session;
    expect([...property.enum].sort()).toEqual([null, 'FPS', 'LPS'].sort());
  });
});

describe('the schema and the sheet columns stay in step', () => {
  test('every strength column is either an identity field or a platoon property', () => {
    const identity = ['parade_response_id', 'date', 'session', 'company'];
    const properties = Object.keys(wrapper.schema.properties.platoons.items.properties);
    globals.STRENGTH_DATA_COLUMNS.forEach((column) => {
      expect(identity.includes(column) || properties.includes(column)).toBe(true);
    });
  });

  test('every personnel column is either an identity field or a personnel property', () => {
    const identity = ['parade_response_id', 'date', 'session', 'company'];
    const properties = Object.keys(wrapper.schema.properties.personnel.items.properties);
    globals.PERSONNEL_DATA_COLUMNS.forEach((column) => {
      expect(identity.includes(column) || properties.includes(column)).toBe(true);
    });
  });

  test('every command-roster column is either an identity field or a command property', () => {
    const identity = ['parade_response_id', 'date', 'session', 'company'];
    const properties = Object.keys(wrapper.schema.properties.command_team.items.properties);
    globals.COMMAND_ROSTER_COLUMNS.forEach((column) => {
      expect(identity.includes(column) || properties.includes(column)).toBe(true);
    });
  });
});

describe('the prompt', () => {
  /** @type {string} The prompt for a placeholder message. */
  const prompt = globals.ParserAi.buildPrompt_('THE RAW MESSAGE');

  test('carries the message it was built for', () => {
    expect(prompt).toContain('THE RAW MESSAGE');
  });

  test('names every company, so none can be silently unrecognizable', () => {
    globals.COMPANIES.forEach((company) => expect(prompt).toContain(company));
  });

  test('names every reason category the schema will accept', () => {
    globals.REASON_CATEGORIES.forEach((category) => expect(prompt).toContain(category));
  });

  test.each([
    ['open-started ranges', 'until 260626'],
    ['overnight duties counted as one day', '190626 0800'],
    ['locations named in prose', 'Pulau Tekong Medical Centre'],
    ['header counts that under-report', 'LEAVE/MA/OFF/COURSE: 00'],
    ['never inferring in_camp', 'Never infer it from a location name'],
  ])('states the rule for %s', (_label, needle) => {
    // Each of these was a real disagreement between the prompt and the labelled
    // examples. Asserting the rule is present keeps it from being edited away.
    expect(prompt).toContain(needle);
  });
});

describe('parseResponse_', () => {
  /**
   * Wraps extraction JSON in the response envelope the API returns.
   * @param {string} content The message content.
   * @returns {!Object} A response body.
   */
  function body(content) {
    return { choices: [{ message: { content } }] };
  }

  /** @type {string} A minimal well-formed extraction. */
  const VALID = JSON.stringify({ platoons: [], command_team: [], personnel: [] });

  test('returns the parsed extraction', () => {
    expect(globals.ParserAi.parseResponse_(body(VALID))).toEqual({
      platoons: [],
      command_team: [],
      personnel: [],
    });
  });

  test.each([
    ['an empty body', {}],
    ['no choices', { choices: [] }],
    ['an empty message', { choices: [{ message: {} }] }],
    ['null', null],
  ])('rejects %s as having no content', (_label, response) => {
    expect(() => globals.ParserAi.parseResponse_(response)).toThrow(/no message content/i);
  });

  test('rejects malformed JSON and quotes where it broke', () => {
    // The snippet is the whole diagnosis when a response is truncated mid-array.
    expect(() => globals.ParserAi.parseResponse_(body('{"platoons": [{"platoon": "1"'))).toThrow(/not valid JSON/i);
  });

  test.each([
    ['platoons', JSON.stringify({ command_team: [], personnel: [] })],
    ['command_team', JSON.stringify({ platoons: [], personnel: [] })],
    ['personnel', JSON.stringify({ platoons: [], command_team: [] })],
  ])('rejects a response missing %s, even though strict mode should prevent it', (_label, content) => {
    expect(() => globals.ParserAi.parseResponse_(body(content))).toThrow(/expected platoons/i);
  });
});

describe('the API request', () => {
  test('sends the model, the flex tier, the key and the schema', () => {
    const env = loadParser({ apiKey: 'sk-test', fetchResponse: { body: JSON.stringify({}) } });
    try {
      env.globals.ParserAi.extract('SOME MESSAGE');
    } catch (err) {
      // Both attempts fail on the empty body; the request itself is what matters.
    }

    expect(env.fetches).toHaveLength(2);
    const { url, params } = env.fetches[0];
    expect(url).toContain('/chat/completions');
    expect(params.headers.Authorization).toBe('Bearer sk-test');
    expect(params.muteHttpExceptions).toBe(true);

    const payload = JSON.parse(params.payload);
    expect(payload.model).toBe(env.globals.OPENAI_MODEL);
    expect(payload.service_tier).toBe('flex');
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.messages[0].content).toContain('SOME MESSAGE');
  });

  test('retries once, then reports the failure for the row', () => {
    const env = loadParser({ fetchResponse: { code: 500, body: 'upstream exploded' } });

    expect(() => env.globals.ParserAi.extract('SOME MESSAGE')).toThrow(/after 2 attempts/i);
    expect(env.fetches).toHaveLength(2);
  });

  test('names the missing property when no API key is set, and makes no request', () => {
    const env = loadParser({ apiKey: '' });

    expect(() => env.globals.ParserAi.extract('SOME MESSAGE')).toThrow(/OPENAI_API_KEY/);
    expect(env.fetches).toHaveLength(0);
  });
});

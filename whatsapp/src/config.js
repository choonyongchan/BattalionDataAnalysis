/**
 * Environment-backed configuration for the WhatsApp bridge.
 *
 * Every secret and deployment-specific value lives in whatsapp/.env, mirroring
 * the convention the FormSG module uses for its own credentials. Nothing here
 * is ever hard-coded into source.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** @type {string} Absolute path to the whatsapp/ module root. */
export const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {string} Directory holding the persisted Baileys auth session. */
export const AUTH_DIR = join(MODULE_ROOT, 'auth');

/**
 * Loads whatsapp/.env into process.env if it has not been loaded already.
 *
 * @returns {void}
 */
function loadDotEnv() {
  const envPath = join(MODULE_ROOT, '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }
}

/**
 * Reads a required environment variable.
 *
 * @param {!Object<string, string>} env The environment to read from.
 * @param {string} key Name of the variable.
 * @returns {string} The trimmed value.
 * @throws {Error} If the variable is missing or blank.
 */
function requireEnv(env, key) {
  const value = (env[key] || '').trim();
  if (value.length === 0) {
    throw new Error(`Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * Reads an optional environment variable.
 *
 * @param {!Object<string, string>} env The environment to read from.
 * @param {string} key Name of the variable.
 * @param {string} fallback Value to use when the variable is absent or blank.
 * @returns {string} The trimmed value, or the fallback.
 */
function optionalEnv(env, key, fallback) {
  const value = (env[key] || '').trim();
  return value.length === 0 ? fallback : value;
}

/**
 * Builds the whole configuration, validating it up front.
 *
 * Loading fails fast at start-up rather than at the moment the first parade
 * state arrives.
 *
 * `env` is injectable because .env is loaded into `process.env` as a side
 * effect, which a test cannot undo — without it, a populated .env on the
 * developer's machine silently overrides whatever the test set.
 *
 * @param {{env?: !Object<string, string>}} [options] `env` defaults to
 *   process.env after whatsapp/.env has been loaded into it.
 * @returns {{groupId: string, appsScriptUrl: string, appsScriptToken: string,
 *   logLevel: string, dryRun: boolean, authDir: string}} The resolved
 *   configuration.
 * @throws {Error} If a required variable is missing.
 */
export function loadConfig(options = {}) {
  if (options.env === undefined) {
    loadDotEnv();
  }
  const env = options.env || process.env;

  return {
    groupId: requireEnv(env, 'WA_GROUP_ID'),
    appsScriptUrl: requireEnv(env, 'APPS_SCRIPT_URL'),
    appsScriptToken: requireEnv(env, 'APPS_SCRIPT_TOKEN'),
    logLevel: optionalEnv(env, 'LOG_LEVEL', 'info'),
    dryRun: optionalEnv(env, 'DRY_RUN', '0') === '1',
    authDir: AUTH_DIR,
  };
}

/**
 * Entry point for the WhatsApp -> Google Sheets parade-state bridge.
 *
 * Pipeline: WhatsApp group message -> first-parade check -> POST to the Apps
 * Script web app. The handler appends the Parade State Responses row and runs
 * the extraction and validation pipeline in the same execution, so an accepted
 * message reaches Strength Data within seconds.
 */

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { relayParadeState } from './appsScriptClient.js';
import { isParadeState } from './signature.js';
import { startListener } from './listener.js';

/**
 * Builds the handler invoked for every message in the watched group.
 *
 * There is no local record of what has already been sent. Dedup lives
 * server-side, keyed on the Baileys message id, because it has to: the Apps
 * Script 302 can turn one POST into two, which no amount of bookkeeping here
 * would catch. One place to dedupe is better than two, and the sheet is the one
 * that can see both causes.
 *
 * @param {Object} deps Handler dependencies.
 * @param {Object} deps.config Resolved configuration from loadConfig().
 * @param {import('pino').Logger} deps.logger Logger for status output.
 * @returns {function(string, Object): Promise<void>} The message handler.
 */
export function createMessageHandler({ config, logger }) {
  return async function handleMessage(text, envelope) {
    const messageId = envelope.key?.id || '';
    const { accepted, rejectReason } = isParadeState(text);

    if (!accepted) {
      logger.debug({ messageId, reason: rejectReason }, 'ignored non-parade-state message');
      return;
    }

    const summary = { messageId, chars: text.length };

    if (config.dryRun) {
      logger.info(summary, 'DRY_RUN: parade state accepted but not relayed');
      return;
    }

    try {
      const { appended, rowIndex } = await relayParadeState(text, messageId, config);
      logger.info(
        { ...summary, rowIndex },
        appended ? 'relayed parade state to Google Sheets' : 'already recorded, server skipped it'
      );
    } catch (err) {
      logger.error({ ...summary, err: err.message }, 'relay failed; will retry if the message is resent');
    }
  };
}

/**
 * Starts the bridge.
 *
 * @returns {Promise<void>} Rejects when the WhatsApp session is unrecoverable.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info({ groupId: config.groupId, dryRun: config.dryRun }, 'starting WhatsApp parade-state bridge');

  await startListener({
    authDir: config.authDir,
    groupId: config.groupId,
    logger,
    onMessage: createMessageHandler({ config, logger }),
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

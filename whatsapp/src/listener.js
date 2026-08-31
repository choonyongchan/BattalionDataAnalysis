/**
 * Baileys-backed WhatsApp group listener.
 *
 * WhatsApp offers no official API for reading group messages - Meta's Cloud API
 * only receives one-to-one messages sent to a business number - so the bridge
 * uses Baileys, which speaks the WhatsApp Web protocol directly over a
 * WebSocket. That makes ingestion event-driven rather than polled: new messages
 * arrive on the "messages.upsert" event.
 *
 * The session is QR-paired once and persisted under whatsapp/auth/, so ordinary
 * restarts do not require another scan.
 */

import { existsSync, mkdirSync } from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

/** @type {number} Milliseconds to wait before reconnecting after a drop. */
const RECONNECT_DELAY_MS = 3000;

/**
 * Extracts plain text from a Baileys message envelope.
 *
 * Parade states arrive either as a plain conversation message or, when they are
 * long or quote another message, as an extendedTextMessage. Captions on media
 * are read too, since a screenshot with the state pasted in the caption is
 * still usable text.
 *
 * @param {Object} message The `message` field of a Baileys message envelope.
 * @returns {?string} The message text, or null when the message carries none.
 */
export function extractText(message) {
  if (!message) {
    return null;
  }
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

/**
 * Reports whether an envelope is an inbound text message from the target group.
 *
 * Filters out the bridge's own messages, protocol/system events, and traffic
 * from any other chat.
 *
 * @param {Object} envelope A Baileys message envelope.
 * @param {string} groupId JID of the group to watch.
 * @returns {boolean} True when the envelope should be classified.
 */
export function isWatchedGroupMessage(envelope, groupId) {
  if (!envelope?.key || envelope.key.fromMe) {
    return false;
  }
  if (envelope.key.remoteJid !== groupId) {
    return false;
  }
  return extractText(envelope.message) !== null;
}

/**
 * Connects to WhatsApp and streams messages from the watched group.
 *
 * The returned promise never resolves under normal operation; the function
 * reconnects itself on transient drops and only rejects when the session has
 * been logged out and a fresh QR scan is required.
 *
 * @param {Object} options Listener options.
 * @param {string} options.authDir Directory holding the persisted session.
 * @param {string} options.groupId JID of the group to watch, or an empty string
 *   to accept messages from every chat.
 * @param {import('pino').Logger} options.logger Logger for status output.
 * @param {function(string, Object): Promise<void>} options.onMessage Called with
 *   the message text and its Baileys envelope for each watched message.
 * @param {function(Object): Promise<void>} [options.onReady] Called with the
 *   live socket once the connection opens.
 * @returns {Promise<void>} Rejects when the session is logged out.
 */
export async function startListener(options) {
  const { authDir, groupId, logger, onMessage, onReady } = options;

  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ component: 'baileys' }, { level: 'silent' }),
    browser: ['BattalionDataAnalysis', 'Chrome', '1.0.0'],
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      return;
    }
    for (const envelope of messages) {
      if (!isWatchedGroupMessage(envelope, groupId || envelope.key?.remoteJid)) {
        continue;
      }
      try {
        await onMessage(extractText(envelope.message), envelope);
      } catch (err) {
        logger.error({ err: err.message, messageId: envelope.key?.id }, 'message handler failed');
      }
    }
  });

  return new Promise((resolve, reject) => {
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('scan this QR code in WhatsApp > Linked devices');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('connected to WhatsApp');
        if (onReady) {
          await onReady(socket);
        }
        return;
      }

      if (connection !== 'close') {
        return;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error('session logged out - delete whatsapp/auth/ and re-scan the QR code');
        reject(new Error('WhatsApp session logged out; re-pairing required.'));
        return;
      }

      logger.warn({ statusCode }, `connection closed, reconnecting in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(() => {
        startListener(options).then(resolve, reject);
      }, RECONNECT_DELAY_MS);
    });
  });
}

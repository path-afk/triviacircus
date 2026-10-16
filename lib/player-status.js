'use strict';

const PLAYER_STATUSES = Object.freeze([
  '🎯 Ready',
  '🔥 On Fire',
  '🤔 Thinking',
  '😎 Confident',
  '🍀 Feeling Lucky',
  '🎪 Here to Play',
]);

const ALLOWED_STATUSES = new Set(PLAYER_STATUSES);
const MAX_STATUS_LENGTH = Math.max(...PLAYER_STATUSES.map(status => status.length));

/**
 * Validate an untrusted status event payload.
 * Returns a new, minimal payload when valid; otherwise returns null.
 */
function validatePlayerStatus(payload) {
  try {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const descriptor = Object.getOwnPropertyDescriptor(payload, 'status');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;

    const { value: status } = descriptor;
    if (typeof status !== 'string' || status.length > MAX_STATUS_LENGTH) return null;
    if (!ALLOWED_STATUSES.has(status)) return null;

    return { status };
  } catch (_) {
    return null;
  }
}

module.exports = { PLAYER_STATUSES, validatePlayerStatus };

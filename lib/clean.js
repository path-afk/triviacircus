'use strict';
/**
 * Profanity filter and name sanitizer for Trivia Circus.
 * Standalone — no dependencies on server.js globals.
 * Mirrors the clean() logic in server.js so both can be tested independently.
 */

const MAX_NAME_LEN = 24;

const BLOCKED = new Set([
  'fuck','shit','bitch','cunt','dick','cock','pussy','nigger','faggot'
]);

/**
 * Sanitize a player-supplied string.
 * - Returns empty string on non-string input, null, or profanity match.
 * - Trims whitespace and truncates to MAX_NAME_LEN.
 * - Does NOT strip HTML tags by design (the output is set via textContent, not innerHTML).
 * @param {*} str
 * @returns {string}
 */
function clean(str) {
  if (!str || typeof str !== 'string') return '';
  const s     = str.trim().slice(0, MAX_NAME_LEN);
  const lower = s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  for (const w of BLOCKED) if (lower.includes(w)) return '';
  return s;
}

module.exports = { clean, BLOCKED, MAX_NAME_LEN };

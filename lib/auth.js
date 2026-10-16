'use strict';
const crypto = require('crypto');

const COOKIE_NAME    = 'tc_guest';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // seconds → 1 year
const TOKEN_BYTES    = 32;
const TOKEN_REGEX    = /^[0-9a-f]{64}$/;

/** Generate a 32-byte opaque token as a 64-char hex string. */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** Validate a candidate token string (format check only). */
function isValidToken(t) {
  return typeof t === 'string' && TOKEN_REGEX.test(t);
}

/** SHA-256 hash of the raw token (what we store server-side). */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Set the HttpOnly, SameSite=Lax guest cookie on a response.
 * Secure flag is set in production.
 */
function setCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly:  true,
    sameSite:  'lax',
    path:      '/',
    maxAge:    COOKIE_MAX_AGE * 1000,   // express uses milliseconds
    secure:    process.env.NODE_ENV === 'production',
  });
}

/** Extract the raw token from a parsed-cookie object (or null). */
function getToken(parsedCookies) {
  const t = parsedCookies && parsedCookies[COOKIE_NAME];
  return isValidToken(t) ? t : null;
}

/**
 * Parse a raw Cookie: header string and return the tc_guest value,
 * or null if absent/invalid.  Used by Socket.IO middleware.
 */
function tokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE_NAME && v && isValidToken(v.trim())) return v.trim();
  }
  return null;
}

module.exports = { COOKIE_NAME, generateToken, isValidToken, hashToken, setCookie, getToken, tokenFromCookieHeader };

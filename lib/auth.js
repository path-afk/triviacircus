'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const COOKIE_NAME    = 'tc_guest';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // seconds → 1 year
const SESSION_COOKIE_NAME = 'tc_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds → 30 days
const TOKEN_BYTES    = 32;
const TOKEN_REGEX    = /^[0-9a-f]{64}$/;
const USERNAME_REGEX = /^[A-Za-z0-9_]{3,24}$/;
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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

function clearGuestCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    maxAge: SESSION_MAX_AGE * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}

/** Extract the raw token from a parsed-cookie object (or null). */
function getToken(parsedCookies) {
  const t = parsedCookies && parsedCookies[COOKIE_NAME];
  return isValidToken(t) ? t : null;
}

function getSessionToken(parsedCookies) {
  const t = parsedCookies && parsedCookies[SESSION_COOKIE_NAME];
  return isValidToken(t) ? t : null;
}

/**
 * Parse a raw Cookie: header string and return the tc_guest value,
 * or null if absent/invalid.  Used by Socket.IO middleware.
 */
function tokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === COOKIE_NAME && isValidToken(v)) return v;
  }
  return null;
}

function sessionTokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === SESSION_COOKIE_NAME && isValidToken(v)) return v;
  }
  return null;
}

function validateUsername(username) {
  const value = typeof username === 'string' ? username.trim() : '';
  return USERNAME_REGEX.test(value) ? value : null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return null;
  if (password.length < 8 || password.length > 128) return null;
  if (Buffer.byteLength(password, 'utf8') > 256) return null;
  return password;
}

async function hashPassword(password) {
  const valid = validatePassword(password);
  if (!valid) throw new Error('Invalid password');
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(valid, salt, 64, SCRYPT_OPTIONS);
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHash) {
  const candidate = typeof password === 'string' ? password : '';
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt || '');
  const expected = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(expectedHash || '');
  const actual = await scryptAsync(candidate, saltBuffer, 64, SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  COOKIE_NAME, COOKIE_MAX_AGE, SESSION_COOKIE_NAME, SESSION_MAX_AGE,
  generateToken, isValidToken, hashToken,
  setCookie, clearGuestCookie, getToken, tokenFromCookieHeader,
  setSessionCookie, clearSessionCookie, getSessionToken, sessionTokenFromCookieHeader,
  validateUsername, validatePassword, hashPassword, verifyPassword,
};

'use strict';

const crypto = require('crypto');

const HUMAN_COOKIE = 'tc_human';
const HUMAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function getHumanGateConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = String(env.TURNSTILE_SECRET_KEY || '').trim();
  const signingSecret = String(env.HUMAN_GATE_SECRET || '').trim();
  const supplied = [siteKey, secretKey, signingSecret].filter(Boolean).length;
  if (supplied > 0 && supplied < 3) {
    throw new Error('TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, and HUMAN_GATE_SECRET must be configured together');
  }
  return {
    enabled: supplied === 3,
    siteKey,
    secretKey,
    signingSecret,
    hostname: String(env.TURNSTILE_HOSTNAME || 'triviacircus.com').trim().toLowerCase(),
    action: 'trivia-join',
  };
}

function signature(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createHumanToken(secret, nowMs = Date.now(), maxAgeMs = HUMAN_MAX_AGE_MS) {
  const expiresAt = Math.floor((nowMs + maxAgeMs) / 1000);
  const payload = 'v1.' + expiresAt;
  return payload + '.' + signature(secret, payload);
}

function verifyHumanToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1])) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  const expected = signature(secret, parts[0] + '.' + parts[1]);
  const actualBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function cookieValueFromHeader(header, name = HUMAN_COOKIE) {
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}

async function verifyTurnstile({ response, remoteip, config, fetchImpl = global.fetch }) {
  if (!config || !config.enabled || typeof fetchImpl !== 'function') return false;
  if (typeof response !== 'string' || response.length < 1 || response.length > 2048) return false;
  const body = new URLSearchParams({ secret: config.secretKey, response });
  if (remoteip) body.set('remoteip', remoteip);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!result.ok) return false;
    const data = await result.json();
    if (!data || data.success !== true) return false;
    if (config.hostname && String(data.hostname || '').toLowerCase() !== config.hostname) return false;
    if (config.action && data.action !== config.action) return false;
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  HUMAN_COOKIE,
  HUMAN_MAX_AGE_MS,
  TURNSTILE_VERIFY_URL,
  getHumanGateConfig,
  createHumanToken,
  verifyHumanToken,
  cookieValueFromHeader,
  verifyTurnstile,
};

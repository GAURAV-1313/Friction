const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const { getDbPool } = require('../db/pool');
const { randomUUID } = require('crypto');

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function getGoogleClientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}

function getGoogleCallbackUrl(req) {
  if (process.env.GOOGLE_CALLBACK_URL) {
    return process.env.GOOGLE_CALLBACK_URL;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const host = req.headers['x-forwarded-host'] || req.get('host');

  if (!host) {
    return '';
  }

  const normalizedHost = host.split(',')[0].trim();
  const isLocalHost = normalizedHost.startsWith('localhost') || normalizedHost.startsWith('127.0.0.1');
  const inferredProto = (forwardedProto && forwardedProto.split(',')[0].trim()) || req.protocol;
  const protocol = isLocalHost ? (inferredProto || 'http') : 'https';

  return new URL('/auth/google/callback', `${protocol}://${normalizedHost}`).toString();
}

function getOAuthClient() {
  const clientId = getGoogleClientId();
  if (!clientId) return null;
  return new OAuth2Client(clientId);
}

function buildGoogleAuthUrl(state, callbackUrl, clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, callbackUrl, clientId) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code'
  });

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      });
      return response.data;
    } catch (err) {
      const isRetryable = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code);
      if (isRetryable && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function verifyIdToken(idToken) {
  const client = getOAuthClient();
  if (!client) {
    throw new Error('google_oauth_not_configured');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID
  });
  return ticket.getPayload();
}

async function upsertUserFromGoogle(payload) {
  const pool = getDbPool();
  const { sub, email, name } = payload;

  // Lookup existing user by google_sub (immutable Google user ID)
  const [existingRows] = await pool.query(
    'SELECT user_id FROM users WHERE google_sub = ? LIMIT 1',
    [sub]
  );

  if (existingRows.length > 0) {
    // User exists, update name/email if changed
    await pool.query(
      'UPDATE users SET email = ?, name = ? WHERE google_sub = ?',
      [email || '', name || '', sub]
    );
    return existingRows[0].user_id;
  }

  // New user — also check if email already exists
  const [emailRows] = await pool.query(
    'SELECT user_id FROM users WHERE email = ? LIMIT 1',
    [email]
  );

  if (emailRows.length > 0) {
    // Email exists but google_sub doesn't — link the accounts
    await pool.query(
      'UPDATE users SET google_sub = ?, email = ?, name = ? WHERE user_id = ?',
      [sub, email || '', name || '', emailRows[0].user_id]
    );
    return emailRows[0].user_id;
  }

  // Completely new user
  const userId = randomUUID();
  await pool.query(
    'INSERT INTO users (user_id, email, name, google_sub) VALUES (?, ?, ?, ?)',
    [userId, email || '', name || '', sub]
  );

  await pool.query(
    'INSERT INTO user_settings (user_id, output_language) VALUES (?, ?)',
    [userId, 'hinglish']
  );

  return userId;
}

function validateJwtConfig() {
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.JWT_ISSUER) missing.push('JWT_ISSUER');
  if (!process.env.JWT_AUDIENCE) missing.push('JWT_AUDIENCE');
  if (missing.length > 0) {
    const err = new Error(`jwt_config_missing:${missing.join(',')}`);
    err.code = 'JWT_CONFIG_MISSING';
    throw err;
  }
}

module.exports = {
  getGoogleClientId,
  getGoogleCallbackUrl,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  upsertUserFromGoogle,
  validateJwtConfig
};

const express = require('express');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const { randomUUID } = require('crypto');
const { getDbPool } = require('../db/pool');
const { signAccessToken } = require('../utils/jwt');

const router = express.Router();

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function isOAuthDebugEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.OAUTH_DEBUG || '').toLowerCase());
}

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

  if (!clientId) {
    return null;
  }

  return new OAuth2Client(clientId);
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
        // eslint-disable-next-line no-console
        console.warn(`Token exchange attempt ${attempt} failed (${err.code}), retrying...`);
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

async function upsertUserFromGoogle(payload, retries = 3) {
  const pool = getDbPool();
  const { sub, email, name } = payload;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const [rows] = await pool.query('SELECT user_id FROM users WHERE google_sub = ? LIMIT 1', [sub]);
      if (rows.length > 0) {
        return rows[0].user_id;
      }

      const userId = randomUUID();
      await pool.query(
        'INSERT INTO users (user_id, email, name, google_sub) VALUES (?, ?, ?, ?)',
        [userId, email || '', name || '', sub]
      );

      await pool.query(
        'INSERT INTO user_settings (user_id, output_language) VALUES (?, ?) ON DUPLICATE KEY UPDATE output_language = output_language',
        [userId, 'hinglish']
      );

      return userId;
    } catch (err) {
      const isRetryable = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST'].includes(err.code);
      if (isRetryable && attempt < retries) {
        // eslint-disable-next-line no-console
        console.warn(`DB upsert attempt ${attempt} failed (${err.code}), retrying...`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

router.get('/debug', async (req, res) => {
  if (!isOAuthDebugEnabled()) {
    return res.status(404).json({ error: 'not_found' });
  }

  const result = {
    oauth_debug: true,
    callback_url: getGoogleCallbackUrl(req),
    web_app_url: process.env.WEB_APP_URL || '',
    checks: {
      google_client_id: Boolean(process.env.GOOGLE_CLIENT_ID),
      google_client_secret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
      google_callback_url: Boolean(process.env.GOOGLE_CALLBACK_URL),
      jwt_secret: Boolean(process.env.JWT_SECRET),
      jwt_issuer: Boolean(process.env.JWT_ISSUER),
      jwt_audience: Boolean(process.env.JWT_AUDIENCE)
    },
    db: {
      ok: false,
      code: null,
      message: null
    }
  };

  try {
    const pool = getDbPool();
    await pool.query('SELECT 1');
    result.db.ok = true;
  } catch (err) {
    result.db.code = err.code || null;
    result.db.message = err.message || null;
  }

  return res.json(result);
});

router.get('/google', (req, res) => {
  const state = req.query.state || 'friction';

  const clientId = getGoogleClientId();
  const callbackUrl = getGoogleCallbackUrl(req);

  if (!clientId || !callbackUrl) {
    return res.status(500).json({ error: 'google_oauth_not_configured' });
  }

  return res.redirect(buildGoogleAuthUrl(state, callbackUrl, clientId));
});

router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'missing_code' });
  }

  const traceId = randomUUID();
  let stage = 'init';

  try {
    stage = 'load_config';
    const clientId = getGoogleClientId();
    const callbackUrl = getGoogleCallbackUrl(req);

    if (!clientId || !callbackUrl) {
      return res.status(500).json({ error: 'google_oauth_not_configured' });
    }

    stage = 'exchange_code';
    const tokens = await exchangeCodeForTokens(code, callbackUrl, clientId);
    stage = 'verify_id_token';
    const payload = await verifyIdToken(tokens.id_token);
    stage = 'upsert_user';
    const userId = await upsertUserFromGoogle(payload);
    stage = 'validate_jwt_config';
    validateJwtConfig();

    stage = 'sign_access_token';
    const jwtToken = signAccessToken({
      user_id: userId,
      email: payload.email,
      name: payload.name
    });

    stage = 'redirect';
    const webAppUrl = process.env.WEB_APP_URL;
    if (webAppUrl) {
      const redirectUrl = `${webAppUrl}/reports#token=${encodeURIComponent(jwtToken)}`;
      return res.redirect(redirectUrl);
    }

    return res.json({ token: jwtToken });
  } catch (err) {
    // Log provider/DB details to diagnose callback failures in local/dev.
    // eslint-disable-next-line no-console
    console.error('google_oauth_callback_failed', {
      traceId,
      stage,
      message: err.message,
      stack: err.stack,
      status: err.response?.status,
      data: err.response?.data,
      code: err.code
    });

    if (isOAuthDebugEnabled()) {
      return res.status(500).json({
        error: 'google_oauth_failed',
        trace_id: traceId,
        stage,
        code: err.code || null,
        status: err.response?.status || null,
        message: err.message
      });
    }

    return res.status(500).json({ error: 'google_oauth_failed' });
  }
});

router.post('/token', async (req, res) => {
  const { id_token } = req.body || {};
  if (!id_token) {
    return res.status(400).json({ error: 'missing_id_token' });
  }

  try {
    if (!getGoogleClientId()) {
      return res.status(500).json({ error: 'google_oauth_not_configured' });
    }

    const payload = await verifyIdToken(id_token);
    const userId = await upsertUserFromGoogle(payload);

    const jwtToken = signAccessToken({
      user_id: userId,
      email: payload.email,
      name: payload.name
    });

    return res.json({ token: jwtToken });
  } catch (err) {
    return res.status(401).json({ error: 'invalid_id_token' });
  }
});

module.exports = router;

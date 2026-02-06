const express = require('express');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const { randomUUID } = require('crypto');
const { getDbPool } = require('../db/pool');
const { signAccessToken } = require('../utils/jwt');

const router = express.Router();

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function getOAuthClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
}

function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: process.env.GOOGLE_CALLBACK_URL || '',
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: process.env.GOOGLE_CALLBACK_URL || '',
    grant_type: 'authorization_code'
  });

  const response = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return response.data;
}

async function verifyIdToken(idToken) {
  const client = getOAuthClient();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID
  });
  return ticket.getPayload();
}

async function upsertUserFromGoogle(payload) {
  const pool = getDbPool();
  const { sub, email, name } = payload;

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
}

router.get('/google', (req, res) => {
  const state = req.query.state || 'friction';
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CALLBACK_URL) {
    return res.status(500).json({ error: 'google_oauth_not_configured' });
  }

  return res.redirect(buildGoogleAuthUrl(state));
});

router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'missing_code' });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const payload = await verifyIdToken(tokens.id_token);
    const userId = await upsertUserFromGoogle(payload);

    const jwtToken = signAccessToken({
      user_id: userId,
      email: payload.email,
      name: payload.name
    });

    const webAppUrl = process.env.WEB_APP_URL;
    if (webAppUrl) {
      const redirectUrl = `${webAppUrl}/reports#token=${encodeURIComponent(jwtToken)}`;
      return res.redirect(redirectUrl);
    }

    return res.json({ token: jwtToken });
  } catch (err) {
    return res.status(500).json({ error: 'google_oauth_failed' });
  }
});

router.post('/token', async (req, res) => {
  const { id_token } = req.body || {};
  if (!id_token) {
    return res.status(400).json({ error: 'missing_id_token' });
  }

  try {
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

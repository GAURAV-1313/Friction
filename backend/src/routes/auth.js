const express = require('express');
const { randomUUID } = require('crypto');
const { getDbPool } = require('../db/pool');
const { signAccessToken } = require('../utils/jwt');
const {
  getGoogleClientId,
  getGoogleCallbackUrl,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  upsertUserFromGoogle,
  validateJwtConfig
} = require('../services/oauth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/google', authLimiter, (req, res) => {
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
    console.error('google_oauth_callback_failed', {
      traceId,
      stage,
      message: err.message,
      code: err.code
    });

    return res.status(500).json({ error: 'google_oauth_failed' });
  }
});

router.post('/token', authLimiter, async (req, res) => {
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

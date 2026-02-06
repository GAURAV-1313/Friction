const jwt = require('jsonwebtoken');

function signAccessToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }

  return jwt.sign(payload, secret, {
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn: '7d'
  });
}

function verifyAccessToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }

  return jwt.verify(token, secret, {
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE
  });
}

module.exports = { signAccessToken, verifyAccessToken };

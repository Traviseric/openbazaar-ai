'use strict';

const crypto = require('crypto');

function parseAllowedKeys() {
  return String(process.env.TENEO_SERVICE_KEYS || process.env.SERVICE_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireServiceKey(req, res, next) {
  const allowedKeys = parseAllowedKeys();
  const provided = req.headers['x-service-key'];

  if (allowedKeys.length === 0) {
    return res.status(503).json({
      success: false,
      error: 'Service key authentication is not configured',
    });
  }

  if (!provided || !allowedKeys.some((key) => constantTimeEquals(provided, key))) {
    return res.status(401).json({
      success: false,
      error: 'Invalid service key',
    });
  }

  req.serviceKeyAuthenticated = true;
  next();
}

module.exports = { requireServiceKey };

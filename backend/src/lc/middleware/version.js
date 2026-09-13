'use strict';
/**
 * versionGate(config): 426 update_required when the extension announces (X-Anchor-Version) a version
 * lower than config.minExtensionVersion. Requests without the header (or with an unparseable one) pass:
 * the client-side gate on /health.min_extension_version still applies.
 */
const HEADER = 'x-anchor-version';

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function versionGate(config) {
  const min = config && config.minExtensionVersion;
  return function (req, res, next) {
    const sent = req.headers[HEADER];
    if (!min || typeof sent !== 'string' || !parseVersion(sent)) return next();
    if (compareVersions(sent, min) < 0) return res.status(426).json({ error: 'update_required', min_extension_version: min });
    return next();
  };
}

module.exports = { versionGate, compareVersions, parseVersion, HEADER };

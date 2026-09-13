'use strict';
// Closed pilot: only allow-listed Friction users may use /api/lc/*. Empty list = open.
function pilotAllowlist(cfg) {
  return function (req, res, next) {
    if (!cfg.pilotUserIds.length) return next();
    if (req.auth && cfg.pilotUserIds.includes(req.auth.user_id)) return next();
    return res.status(403).json({ error: 'pilot_closed' });
  };
}
module.exports = { pilotAllowlist };

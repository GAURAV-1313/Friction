'use strict';
const { requireAuth } = require('../../middleware/auth');
const { pilotAllowlist } = require('../middleware/pilot');
const { versionGate } = require('../middleware/version');
const { makeHealthRouter } = require('./health');

// deps: { pool, llm, config, seed, limiters }
function mountLcRoutes(app, deps) {
  app.use(makeHealthRouter({ pool: deps.pool, config: deps.config, llmProvider: deps.llm && deps.llm.provider }));
  const guard = [requireAuth, pilotAllowlist(deps.config), versionGate(deps.config)];
  const mount = (name) => app.use('/api/lc', guard, require(`./${name}`).makeRouter(deps));
  for (const name of ['me', 'profile', 'sync', 'problems', 'anchors', 'attempts', 'chat', 'habits', 'events']) mount(name);
}

module.exports = { mountLcRoutes };

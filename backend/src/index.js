require('dotenv').config();
const { createApp } = require('./app');
const { waitForDb } = require('./db/pool');

const port = process.env.PORT || 4000;

const app = createApp();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Friction backend listening on ${port}`);
});

// Warm up DB connectivity without blocking service startup.
waitForDb().catch((err) => {
  // eslint-disable-next-line no-console
  console.warn('DB warmup failed', err?.code || err?.message || err);
});

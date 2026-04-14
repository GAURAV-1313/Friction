require('dotenv').config();
const { createApp } = require('./app');
const { waitForDb } = require('./db/pool');

const port = process.env.PORT || 4000;

(async () => {
  await waitForDb();
  const app = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Friction backend listening on ${port}`);
  });
})();

const cron = require('node-cron');
const { getDbPool } = require('../db/pool');
const { runSnapshotsForUser } = require('./snapshotRunner');

function startWeeklySnapshotScheduler() {
  // Every Monday at 09:00 server time.
  // Adjust later based on user timezone preferences.
  cron.schedule('0 9 * * 1', async () => {
    const pool = getDbPool();
    try {
      const [users] = await pool.query('SELECT user_id FROM users');
      for (const user of users) {
        await runSnapshotsForUser({ pool, userId: user.user_id, triggerType: 'scheduled' });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('weekly_snapshot_scheduler_failed', err);
    }
  });
}

module.exports = { startWeeklySnapshotScheduler };

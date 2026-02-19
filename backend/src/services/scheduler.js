const cron = require('node-cron');
const { getDbPool } = require('../db/pool');
const { runSnapshotsForUser } = require('./snapshotRunner');

function startDailySnapshotScheduler() {
  // Every day at 23:30 server time.
  // Adjust later based on user timezone preferences.
  cron.schedule('30 23 * * *', async () => {
    const pool = getDbPool();
    try {
      const [users] = await pool.query('SELECT user_id FROM users');
      for (const user of users) {
        const [rows] = await pool.query(
          'SELECT COUNT(*) AS pending_count FROM buffer_moments WHERE user_id = ? AND status = ?',
          [user.user_id, 'pending']
        );
        const pending = rows?.[0]?.pending_count || 0;
        if (!pending) continue;
        await runSnapshotsForUser({ pool, userId: user.user_id, triggerType: 'scheduled' });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('daily_snapshot_scheduler_failed', err);
    }
  });
}

module.exports = { startDailySnapshotScheduler };

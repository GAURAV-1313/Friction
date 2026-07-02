const cron = require('node-cron');
const { getDbPool } = require('../db/pool');
const { runSnapshotsForUser } = require('./snapshotRunner');

function startDailySnapshotScheduler() {
  cron.schedule('30 23 * * *', async () => {
    const pool = getDbPool();
    try {
      const [usersWithPending] = await pool.query(
        `SELECT DISTINCT bm.user_id
         FROM buffer_moments bm
         WHERE bm.status = 'pending'`
      );
      const tasks = usersWithPending.map((user) => runSnapshotsForUser({
        pool, userId: user.user_id, triggerType: 'scheduled'
      }));
      await Promise.allSettled(tasks);
    } catch (err) {
      console.error('daily_snapshot_scheduler_failed', err);
    }
  });
}

module.exports = { startDailySnapshotScheduler };

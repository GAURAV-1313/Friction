const { getDbPool } = require('../db/pool');

async function getUserLearningRecords(userId) {
  const pool = getDbPool();
  const [rows] = await pool.query(
    `SELECT lr.*
     FROM learning_records lr
     WHERE lr.user_id = ?
     ORDER BY lr.last_admitted_at DESC`,
    [userId]
  );
  return rows;
}

module.exports = { getUserLearningRecords };

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { initDbPool } = require('./db/pool');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const momentRoutes = require('./routes/moments');
const snapshotRoutes = require('./routes/snapshots');
const findingsRoutes = require('./routes/findings');
const learningRecordRoutes = require('./routes/learningRecords');
const reportRoutes = require('./routes/reports');
const promptRoutes = require('./routes/prompts');
const { startWeeklySnapshotScheduler } = require('./services/scheduler');

function createApp() {
  initDbPool();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'friction-backend' });
  });

  app.use('/health', healthRoutes);
  app.use('/auth', authRoutes);
  app.use('/api/moments', momentRoutes);
  app.use('/api/snapshots', snapshotRoutes);
  app.use('/api/findings', findingsRoutes);
  app.use('/api/learning-records', learningRecordRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/prompts', promptRoutes);

  startWeeklySnapshotScheduler();

  return app;
}

module.exports = { createApp };

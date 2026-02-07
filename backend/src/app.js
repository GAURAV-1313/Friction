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
const meRoutes = require('./routes/me');
const { startWeeklySnapshotScheduler } = require('./services/scheduler');

function createApp() {
  initDbPool();

  const app = express();
  const allowlist = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowlist.includes(origin)) return callback(null, true);
        if (origin.startsWith('chrome-extension://')) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );
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
  app.use('/api/me', meRoutes);

  startWeeklySnapshotScheduler();

  return app;
}

module.exports = { createApp };

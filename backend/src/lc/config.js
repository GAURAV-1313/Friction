'use strict';
/**
 * Anchor backend configuration (all env-driven; nothing here is read by Friction).
 *   LC_LLM_PROVIDER           gemini | anthropic          (default gemini)
 *   GEMINI_API_KEY, LC_GEMINI_MODEL (default gemini-2.5-flash)
 *   ANTHROPIC_API_KEY, LC_ANTHROPIC_MODEL (default claude-opus-5)
 *   LC_LLM_TIMEOUT_MS (15000), LC_DAILY_HINT_CAP (60), LC_KILL_LLM (0), LC_KILL_SYNC (0)
 *   LC_MIN_EXTENSION_VERSION (1.0.0), LC_PILOT_USER_IDS (comma list; empty = open)
 *   LC_MAX_RUNG (4), LC_DETAILS_CAP (300)
 *   CORS_ORIGINS, WEB_APP_URL, PORT (4100), plus Friction's DB_* and JWT_* (read by the reused modules)
 */
function bool(v, d = false) { if (v === undefined || v === null || v === '') return d; return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== undefined ? n : d; }

function loadConfig(env = process.env) {
  return Object.freeze({
    port: num(env.PORT, 4100),
    nodeEnv: env.NODE_ENV || 'development',
    provider: (env.LC_LLM_PROVIDER || 'gemini').toLowerCase(),
    geminiApiKey: env.GEMINI_API_KEY || env.LC_GEMINI_API_KEY || '',
    geminiModel: env.LC_GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.LC_ANTHROPIC_MODEL || 'claude-opus-5',
    llmTimeoutMs: num(env.LC_LLM_TIMEOUT_MS, 15000),
    dailyHintCap: num(env.LC_DAILY_HINT_CAP, 60),
    killLlm: bool(env.LC_KILL_LLM),
    killSync: bool(env.LC_KILL_SYNC),
    minExtensionVersion: env.LC_MIN_EXTENSION_VERSION || '1.0.0',
    pilotUserIds: String(env.LC_PILOT_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxRung: num(env.LC_MAX_RUNG, 4),
    detailsCap: num(env.LC_DETAILS_CAP, 300),
    corsOrigins: String(env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    webAppUrl: env.WEB_APP_URL || '',
    commitSha: (env.RAILWAY_GIT_COMMIT_SHA || env.GIT_SHA || '').slice(0, 7),
    consentVersion: env.LC_CONSENT_VERSION || '1'
  });
}

module.exports = { loadConfig };

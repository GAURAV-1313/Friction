'use strict';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isSlug = (s) => typeof s === 'string' && s.length <= 191 && SLUG_RE.test(s);
const clampStr = (s, n) => (s === undefined || s === null ? null : String(s).slice(0, n));
function toInt(v, { min = -Infinity, max = Infinity, def = null } = {}) { const n = Number(v); if (!Number.isInteger(n)) return def; return Math.min(max, Math.max(min, n)); }
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (obj, keys) => { const out = {}; for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k]; return out; };
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const parseJson = (v, d = null) => { if (v === null || v === undefined) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return d; } };
module.exports = { isSlug, clampStr, toInt, isPlainObject, pick, stripHtml, parseJson };

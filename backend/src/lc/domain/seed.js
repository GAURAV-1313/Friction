'use strict';
const path = require('path');
const { DP_TAGS, GRAPH_TAGS } = require('./constants');

let cached = null;

function familiesOf(tags) {
  const f = [];
  const t = tags || [];
  if (t.some((x) => DP_TAGS.has(x))) f.push('dp');
  if (t.some((x) => GRAPH_TAGS.has(x))) f.push('graph');
  return f;
}

function normDiff(d) {
  const s = String(d || '').toLowerCase();
  return s === 'easy' || s === 'medium' || s === 'hard' ? s : null;
}

function loadSeed({ subpatternsPath, catalogPath } = {}) {
  if (cached && !subpatternsPath && !catalogPath) return cached;
  const sp = require(subpatternsPath || path.join(__dirname, '..', 'data', 'subpatterns.json'));
  const cat = require(catalogPath || path.join(__dirname, '..', 'data', 'catalog.json'));
  const membership = new Map();
  const subLabel = new Map();
  const subFamily = new Map();
  const canonical = new Map();
  for (const s of sp.subpatterns || []) {
    subLabel.set(s.id, s.label || s.id);
    subFamily.set(s.id, s.family || (s.id.startsWith('dp.') ? 'dp' : 'graph'));
    canonical.set(s.id, s.canonical || []);
    for (const p of s.problems || []) {
      if (p.verified === false) continue;
      if (!membership.has(p.slug)) membership.set(p.slug, []);
      membership.get(p.slug).push({ id: s.id, primary: !!p.primary, family: subFamily.get(s.id), confidence: p.confidence || 'medium' });
    }
  }
  const catalogBySlug = new Map();
  for (const p of cat.problems || []) catalogBySlug.set(p.slug, { slug: p.slug, title: p.title, frontendId: p.frontendId, difficulty: normDiff(p.difficulty), paid: !!p.paid, tags: p.tags || [] });
  const seed = {
    version: sp.version || 'v0',
    membership,
    subLabel,
    subFamily,
    canonical,
    catalogBySlug,
    subpatternsOf(slug) { return membership.get(slug) || []; },
    primarySub(slug) { const m = membership.get(slug) || []; return m.find((x) => x.primary) || m[0] || null; },
    problemFromCatalog(slug) { return catalogBySlug.get(slug) || null; },
    familiesOf
  };
  if (!subpatternsPath && !catalogPath) cached = seed;
  return seed;
}

module.exports = { loadSeed, familiesOf, normDiff };

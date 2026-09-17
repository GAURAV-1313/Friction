'use strict';
/**
 * Tests for the two side-panel surfaces that make CLAIMS ABOUT THE STUDENT'S OWN
 * HISTORY: memoryBlockNode() and buildProgressLines(). Both name problems the
 * student has solved, so a wrong line here is the product lying to them about
 * themselves -- the worst failure this system has.
 *
 * WHY THE HARNESS. The panel is extension code, not backend code, and there is no
 * DOM in this test runner. Adding jsdom would mean changing backend/package.json,
 * which Recall deliberately does not touch, so instead this file loads the real
 * sidepanel.js source into a vm with a minimal DOM stub and stubs for its only two
 * imports. Nothing is copy-pasted: if the panel changes, this runs the changed code.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', '..', 'extension-leetcode', 'sidepanel.js');

// ---- the smallest DOM that sidepanel.js will run against -------------------
// textContent on a parent aggregates its descendants, which is what lets the tests
// assert on what a student would actually read.
function makeDom() {
  const mkNode = (tag) => {
    const node = {
      tagName: String(tag || '').toUpperCase(),
      className: '',
      children: [],
      _text: '',
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); }
      },
      appendChild(c) { node.children.push(c); return c; },
      removeChild(c) { node.children = node.children.filter((x) => x !== c); return c; },
      remove() {},
      setAttribute() {},
      getAttribute() { return null; },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      get firstChild() { return node.children[0] || null; },
      get firstElementChild() { return node.children[0] || null; },
      get lastElementChild() { return node.children[node.children.length - 1] || null; },
      get isConnected() { return true; },
      get offsetHeight() { return 0; },
      get textContent() { return node._text + node.children.map((c) => c.textContent).join(''); },
      set textContent(v) { node._text = v == null ? '' : String(v); node.children = []; }
    };
    return node;
  };
  // Every id resolves to a stub node (memoised, so els.x === $('x') across calls).
  // Returning null instead would leave the panel's els map full of nulls and it
  // wires listeners onto those at load.
  const byId = new Map();
  const document = {
    createElement: (t) => mkNode(t),
    createTextNode: (t) => { const n = mkNode('#text'); n._text = String(t); return n; },
    createDocumentFragment: () => mkNode('#fragment'),
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, mkNode('div')); return byId.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: mkNode('html'),
    body: mkNode('body'),
    visibilityState: 'visible',
    hidden: false
  };
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {},
    location: { href: 'chrome-extension://x/sidepanel.html' }
  };
  return { document, window };
}

function loadPanel() {
  let src = fs.readFileSync(SRC, 'utf8');
  // Strip the two ES imports; they are injected into the sandbox below instead.
  src = src.replace(/^import .*$/gm, '');
  // Do not start the panel. init() kicks off storage reads and a render loop whose
  // pending promises outlive the test run and leave jest with an open handle.
  src = src.replace(/^init\(\)[\s\S]*?\}\);\s*$/m, '');
  // Expose what we test. The panel keeps these at module scope.
  src += `\n;globalThis.__panel = { memoryBlockNode, buildProgressLines, omittedCopy, problem, state };\n`;

  const { document, window } = makeDom();
  const sandbox = {
    document,
    window,
    globalThis: null,
    console: { log() {}, warn() {}, error() {} },
    // Timers are inert. Loading the panel runs its init() and arms a recompute
    // interval; the three functions under test need no timers, and real ones make
    // the suite hang on an open handle.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    crypto: { randomUUID: () => 'test-uuid' },
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} }
      },
      runtime: { sendMessage: async () => ({}), connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }), onMessage: { addListener() {} }, getManifest: () => ({ version: '1.0.0' }) },
      tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      alarms: { onAlarm: { addListener() {} } }
    },
    // the panel's two imports
    api: new Proxy({}, { get: () => async () => ({ ok: true, data: {} }) }),
    renderModelText: (t) => { const n = document.createElement('span'); n.textContent = t; return n; },
    renderInline: (t) => { const n = document.createElement('span'); n.textContent = t; return n; },
    RECALL_CONFIG: { API_BASE: 'http://localhost:4100', ENV: 'local' },
    RecallExt: { getConsent: async () => false, getLanguage: async () => 'english', getTheme: async () => 'dark' }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.matchMedia = window.matchMedia;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sidepanel.js' });
  return sandbox.__panel;
}

let panel;
beforeAll(() => { panel = loadPanel(); });

const anchor = (slug, title) => ({ slug, title, difficulty: 'medium', why: 'same idea: X', solved_on: '2026-05-01', attempts_to_ac: 2, tier: 'subpattern' });

describe('memoryBlockNode never claims a problem that was not offered', () => {
  test('only offered anchor titles appear in the rendered text', () => {
    const node = panel.memoryBlockNode({
      data: { anchors: [anchor('coin-change', 'Coin Change'), anchor('house-robber', 'House Robber')], family: 'dp', solved_here: false },
      solved: 84, language: 'english'
    });
    const text = node.textContent;
    expect(text).toContain('Coin Change');
    expect(text).toContain('House Robber');
    // a solved problem that was NOT offered must never surface here
    expect(text).not.toContain('Burst Balloons');
  });

  test('with no anchors it names no problem at all', () => {
    const node = panel.memoryBlockNode({
      data: { anchors: [], omitted_reason: 'no_eligible', solved_here: false },
      solved: 84, language: 'english'
    });
    const text = node.textContent;
    expect(text).toContain('New ground for you.');
    expect(text).not.toMatch(/Coin Change|House Robber|Two Sum/);
  });
});

describe('memoryBlockNode does not contradict itself', () => {
  // The reported bug: "You solved this one already." rendered directly above
  // "New ground for you." Both lines were true of different things and the pair
  // read as nonsense.
  test('a solved problem with no anchors is never called new ground', () => {
    const node = panel.memoryBlockNode({
      data: { anchors: [], omitted_reason: 'no_eligible', solved_here: true, solved_here_on: '2026-04-02' },
      solved: 84, language: 'english'
    });
    const text = node.textContent;
    expect(text).toContain('You solved this one already');
    expect(text).not.toContain('New ground for you.');
  });

  test('an unsolved problem with no anchors still says new ground', () => {
    const node = panel.memoryBlockNode({
      data: { anchors: [], omitted_reason: 'no_eligible', solved_here: false },
      solved: 84, language: 'english'
    });
    expect(node.textContent).toContain('New ground for you.');
  });
});

describe('omittedCopy never overstates what was compared', () => {
  test('no_eligible does not claim every tag was checked', () => {
    const copy = panel.omittedCopy('no_eligible', 84);
    expect(copy).toMatch(/overlaps with this one yet/);
    expect(copy).not.toMatch(/shares a sub-pattern or tag/);
  });

  test('the retired DP/graph-only line is gone', () => {
    // Anchors now cover every family, so this sentence would be false.
    for (const reason of ['no_dp_or_graph_family', 'no_family', 'no_eligible', 'below_threshold', undefined]) {
      expect(panel.omittedCopy(reason, 84)).not.toMatch(/Anchors cover DP and graph problems/);
    }
  });
});

describe('buildProgressLines never names an unoffered problem', () => {
  const withAnchors = (anchors) => {
    panel.problem.slug = 'burst-balloons';
    panel.problem.anchors = anchors === null ? null : { anchors };
    panel.problem.history = { messages: [] };
    panel.problem.lastVerdict = null;
    panel.problem.ctx = null;
  };

  test('offered anchor titles appear; others never do', () => {
    withAnchors([anchor('coin-change', 'Coin Change'), anchor('house-robber', 'House Robber')]);
    const text = panel.buildProgressLines({ consent: false, code: null, codeLang: null }).map((l) => l.text).join(' | ');
    expect(text).toContain('Coin Change');
    expect(text).not.toContain('Burst Balloons');
    expect(text).not.toContain('Two Sum');
  });

  test('no anchors offered -> no problem title anywhere', () => {
    withAnchors([]);
    const text = panel.buildProgressLines({ consent: false, code: null, codeLang: null }).map((l) => l.text).join(' | ');
    expect(text).toMatch(/No solved problem of yours is close enough/);
    expect(text).not.toMatch(/Coin Change|House Robber/);
  });

  test('anchors still loading -> makes no claim about the history', () => {
    withAnchors(null);
    const text = panel.buildProgressLines({ consent: false, code: null, codeLang: null }).map((l) => l.text).join(' | ');
    expect(text).toContain('Working from this problem.');
    expect(text).not.toMatch(/Coin Change|House Robber/);
  });

  test('stays within the line budget and always ends on the writing line', () => {
    withAnchors([anchor('a', 'Alpha'), anchor('b', 'Beta')]);
    panel.problem.history = { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] };
    const lines = panel.buildProgressLines({ consent: true, code: 'int main(){}\nreturn 0;', codeLang: 'cpp' });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[lines.length - 1].final).toBe(true);
    expect(lines[lines.length - 1].text).toBe('Writing.');
    expect(lines.filter((l) => l.final).length).toBe(1);
  });

  test('reports the attached code honestly', () => {
    withAnchors([]);
    const withCode = panel.buildProgressLines({ consent: true, code: 'a\nb\nc', codeLang: 'cpp' }).map((l) => l.text).join(' | ');
    expect(withCode).toContain('3 lines of C++');
    const noConsent = panel.buildProgressLines({ consent: false, code: null, codeLang: null }).map((l) => l.text).join(' | ');
    expect(noConsent).toContain('not shared');
    const unreadable = panel.buildProgressLines({ consent: true, code: null, codeLang: null }).map((l) => l.text).join(' | ');
    expect(unreadable).toContain('Could not read your editor');
  });
});

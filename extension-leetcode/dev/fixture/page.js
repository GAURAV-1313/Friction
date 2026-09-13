// page.js: behaviour of the fake problem page served by dev/serve-fixture.js (classic script, no modules).
// Mimics what the extension observes on leetcode.com: submit -> v2/check polling (fetch or XHR), Run Code noise,
// Monaco / Focus-mode editors, the language button + localStorage.global_lang, pushState navigation, contest URLs,
// and the cookie fault switches. Nothing here talks to the Anchor backend.
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var LANG_LABEL = { cpp: 'C++', python3: 'Python3', java: 'Java' };
  var POLL_MS = 400;
  var POLL_MAX = 60;

  var state = { slug: null, questionId: null, lang: 'cpp', focus: false, xhr: false, lastId: null, editor: null, cm: null, contest: false, problems: {}, targets: [], busy: false };

  // ---------- logging ----------
  function stamp() { return new Date().toISOString().slice(11, 23); }
  function logTo(sel, line) {
    var el = $(sel);
    if (!el) return;
    el.textContent = stamp() + ' ' + line + '\n' + el.textContent;
    if (el.textContent.length > 20000) el.textContent = el.textContent.slice(0, 20000);
  }
  function log(line) { logTo('#log', line); }

  // ---------- cookies ----------
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value) { document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; SameSite=Lax'; }
  function delCookie(name) { document.cookie = name + '=; path=/; Max-Age=0; SameSite=Lax'; }
  function renderSwitches() {
    var on = [];
    document.querySelectorAll('button[data-switch]').forEach(function (b) {
      var name = b.getAttribute('data-switch');
      var active = getCookie(name) === '1';
      b.textContent = name + ': ' + (active ? 'ON' : 'off');
      b.classList.toggle('on', active);
      if (active) on.push(name);
    });
    $('#cookie-status').textContent = 'document.cookie: ' + (document.cookie || '(empty)') + (on.length ? '  · active faults: ' + on.join(', ') : '');
  }

  // ---------- url helpers ----------
  function slugFromPath() { var m = /^\/problems\/([^/]+)/.exec(location.pathname); return m ? m[1] : null; }
  function isContestUrl() { try { return new URLSearchParams(location.search).get('envType') === 'contest'; } catch (_) { return false; } }
  function problemUrl(slug) { return '/problems/' + slug + '/description/' + (state.contest ? '?envType=contest' : ''); }

  // ---------- transport (fetch or XHR, chosen by the toggle) ----------
  function request(method, url, body) {
    if (!state.xhr) {
      var init = { method: method, headers: { 'x-csrftoken': getCookie('csrftoken') || '', 'x-requested-with': 'XMLHttpRequest' } };
      if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
      return fetch(url, init).then(function (res) {
        return res.text().then(function (text) { var json = null; try { json = JSON.parse(text); } catch (_) { /* html or empty */ } return { ok: res.ok, status: res.status, json: json, text: text }; });
      });
    }
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader('x-csrftoken', getCookie('csrftoken') || '');
      xhr.setRequestHeader('x-requested-with', 'XMLHttpRequest');
      if (body !== undefined) xhr.setRequestHeader('content-type', 'application/json');
      xhr.onload = function () { var json = null; try { json = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ } resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json: json, text: xhr.responseText }); };
      xhr.onerror = function () { reject(new Error('xhr network error')); };
      xhr.send(body === undefined ? null : JSON.stringify(body));
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- editor ----------
  function starter(slug) {
    var p = state.problems[slug];
    var title = p ? p.title : slug;
    if (state.lang === 'python3') return '# slug: ' + slug + '\n# verdict: AC\nclass Solution:\n    def solve(self, nums):\n        # ' + title + ' (fixture starter)\n        return 0\n';
    if (state.lang === 'java') return '// slug: ' + slug + '\n// verdict: AC\nclass Solution {\n    public int solve(int[] nums) {\n        // ' + title + ' (fixture starter)\n        return 0;\n    }\n}\n';
    return '// slug: ' + slug + '\n// verdict: AC\nclass Solution {\npublic:\n    int solve(vector<int>& nums) {\n        // ' + title + ' (fixture starter)\n        int best = 0;\n        return best;\n    }\n};\n';
  }
  function currentCode() {
    if (state.focus && state.cm) return state.cm.getValue();
    if (state.editor) return state.editor.getValue();
    return '';
  }
  function setCode(v) {
    if (state.focus && state.cm) state.cm.setValue(v);
    else if (state.editor) state.editor.setValue(v);
  }
  function disposeEditors() {
    if (state.editor) { state.editor.dispose(); state.editor = null; }
    if (state.cm) { state.cm.dispose(); state.cm = null; }
  }
  // A new editor instance (and model) on every navigation, like the real page.
  function mountEditor(code) {
    disposeEditors();
    var host = $('#editor');
    if (state.focus) state.cm = window.__fixtureEditors.createCm(host, code);
    else state.editor = window.monaco.editor.create(host, code, state.lang);
  }
  function applyVerdictMarker(verdict) {
    var code = currentCode();
    var re = /^(\/\/|#)\s*verdict:\s*\w+\s*$/m;
    var prefix = state.lang === 'python3' ? '# ' : '// ';
    if (re.test(code)) code = code.replace(re, prefix + 'verdict: ' + verdict);
    else code = prefix + 'verdict: ' + verdict + '\n' + code;
    setCode(code);
  }

  // ---------- language ----------
  function applyLanguage(lang, fromUser) {
    state.lang = lang;
    $('#lang-button').textContent = LANG_LABEL[lang] || lang;
    $('#lang-select').value = lang;
    if ($('#write-global-lang').checked) { try { localStorage.setItem('global_lang', JSON.stringify(lang)); } catch (_) { /* ignore */ } }
    else { try { localStorage.removeItem('global_lang'); } catch (_) { /* ignore */ } }
    if (state.editor) state.editor.getModel().setLanguageId(lang);
    if (fromUser) { mountEditor(starter(state.slug)); log('language -> ' + lang + ' (button "' + (LANG_LABEL[lang] || lang) + '", global_lang ' + ($('#write-global-lang').checked ? 'written' : 'cleared') + '); editor re-created'); }
  }

  // ---------- rendering ----------
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function renderStatement(html) {
    var box = $('#description');
    clear(box);
    var doc = new DOMParser().parseFromString(html || '<p>(no statement)</p>', 'text/html');
    while (doc.body.firstChild) box.appendChild(document.adoptNode(doc.body.firstChild));
  }
  function renderProblem(slug) {
    state.slug = slug;
    var p = state.problems[slug];
    $('#nonproblem').classList.add('hidden');
    $('#problem-card').classList.remove('hidden');
    $('#editor-card').classList.remove('hidden');
    $('#problem-title').textContent = p ? p.questionFrontendId + '. ' + p.title : slug + ' (not in fixture data)';
    var diff = p ? String(p.difficulty).toLowerCase() : 'medium';
    var pill = $('#problem-difficulty'); pill.textContent = diff; pill.className = 'pill ' + diff;
    var tags = $('#problem-tags'); clear(tags);
    (p ? p.topicTags : []).forEach(function (t) { tags.appendChild(el('span', t.name)); });
    renderStatement(p ? p.content : '<p>Unknown slug: the fixture has no metadata for it. questionDetail will answer null.</p>');
    var hints = $('#hints'); clear(hints);
    (p ? p.hints : []).forEach(function (h) { hints.appendChild(el('li', h)); });
    state.questionId = p ? p.questionId : null;
    document.title = (p ? p.title : slug) + ' - Fixture LeetCode';
    $('#verdict-select').value = 'AC';
    $('#result').textContent = 'no submission yet on ' + slug;
    $('#result').className = '';
    mountEditor(starter(slug));
  }
  function renderNonProblem() {
    state.slug = null;
    $('#nonproblem').classList.remove('hidden');
    $('#problem-card').classList.add('hidden');
    $('#editor-card').classList.add('hidden');
    $('#problem-title').textContent = 'Fixture LeetCode';
    $('#problem-difficulty').textContent = 'non-problem';
    $('#problem-difficulty').className = 'pill';
    $('#nonproblem-path').textContent = location.pathname + location.search;
    var links = $('#nonproblem-links'); clear(links);
    state.targets.forEach(function (s) { var a = el('a', s); a.href = problemUrl(s); links.appendChild(a); links.appendChild(document.createTextNode('  ')); });
    document.title = 'Problem set - Fixture LeetCode';
    disposeEditors();
  }
  function render() {
    state.contest = isContestUrl();
    $('#contest-toggle').textContent = 'Contest mode: ' + (state.contest ? 'ON' : 'off');
    $('#contest-toggle').classList.toggle('on', state.contest);
    var slug = slugFromPath();
    if (slug) renderProblem(slug); else renderNonProblem();
    log('render ' + location.pathname + location.search);
  }
  function navigate(slug) {
    history.pushState({ slug: slug }, '', problemUrl(slug));
    log('pushState -> ' + location.pathname + location.search);
    render();
  }

  // ---------- submit / run / polls ----------
  function describe(json) {
    if (!json) return '(non-JSON)';
    var parts = ['state=' + json.state];
    if (json.status_code !== undefined) parts.push('status_code=' + json.status_code + ' (' + json.status_msg + ')');
    if (json.total_correct != null) parts.push(json.total_correct + '/' + json.total_testcases);
    if (json.runtime_error) parts.push('runtime_error=' + json.runtime_error);
    if (json.compile_error) parts.push('compile_error=' + json.compile_error);
    if (json.last_testcase) parts.push('last_testcase=' + JSON.stringify(json.last_testcase).slice(0, 80));
    return parts.join('  ');
  }
  function pollCheck(url, label) {
    var i = 0;
    function step() {
      i++;
      return request('GET', url).then(function (r) {
        var s = r.json && r.json.state;
        if (s === 'SUCCESS' || s === 'FAILURE') { log(label + ' poll ' + i + ': ' + describe(r.json)); return r.json; }
        if (i >= POLL_MAX) { log(label + ' gave up after ' + i + ' polls'); return null; }
        log(label + ' poll ' + i + ': ' + (s || 'HTTP ' + r.status));
        return sleep(POLL_MS).then(step);
      });
    }
    return step();
  }
  function submit() {
    if (state.busy || !state.slug) return;
    state.busy = true;
    $('#submit-btn').disabled = true;
    var body = { lang: state.lang, question_id: state.questionId, typed_code: currentCode() };
    var result = $('#result');
    result.textContent = 'submitting via ' + (state.xhr ? 'XHR' : 'fetch') + '…';
    result.className = '';
    request('POST', '/problems/' + state.slug + '/submit/', body).then(function (r) {
      if (!r.ok || !r.json || r.json.submission_id === undefined) { result.textContent = 'submit failed: HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120); result.className = 'bad'; throw new Error('submit failed'); }
      state.lastId = r.json.submission_id;
      $('#repoll-btn').disabled = false;
      log('submit -> submission_id ' + state.lastId + ' (' + (state.xhr ? 'XHR' : 'fetch') + ')');
      result.textContent = 'submission_id ' + state.lastId + ' · judging…';
      return pollCheck('/submissions/detail/' + state.lastId + '/v2/check/', 'v2/check #' + state.lastId);
    }).then(function (json) {
      if (json) { result.textContent = '#' + state.lastId + '  ' + describe(json); result.className = json.status_code === 10 ? 'ok' : 'bad'; }
    }).catch(function (err) { log('submit error: ' + err.message); })
      .then(function () { state.busy = false; $('#submit-btn').disabled = false; });
  }
  function run() {
    if (!state.slug) return;
    var result = $('#result');
    result.textContent = 'running…'; result.className = '';
    request('POST', '/problems/' + state.slug + '/interpret_solution/', { lang: state.lang, question_id: state.questionId, typed_code: currentCode(), data_input: '[3,1,5,8]' }).then(function (r) {
      if (!r.ok || !r.json) { result.textContent = 'run failed: HTTP ' + r.status; result.className = 'bad'; return null; }
      log('run -> ' + r.json.interpret_id + ' (must not be captured)');
      return pollCheck('/submissions/detail/' + r.json.interpret_id + '/check/', 'runcode check');
    }).then(function (json) { if (json) { result.textContent = 'Run Code: ' + describe(json) + '  (no submission event expected)'; result.className = 'ok'; } })
      .catch(function (err) { log('run error: ' + err.message); });
  }
  function repoll() {
    if (!state.lastId) return;
    request('GET', '/submissions/detail/' + state.lastId + '/v2/check/').then(function (r) { log('re-poll #' + state.lastId + ': ' + describe(r.json) + '  (expect NO new submission event)'); });
  }
  function orphan() {
    var id = 90000000 + Math.floor(Math.random() * 999999);
    request('GET', '/submissions/detail/' + id + '/v2/check/').then(function (r) { log('orphan check #' + id + ': ' + describe(r.json) + '  (expect a submission event with orphan:true and this page\'s slug)'); });
  }

  // ---------- bridge observation (dev only: the page can see its own postMessage traffic) ----------
  function bridgeSummary(d) {
    var p = d.payload || {};
    var bits = [d.from + ' -> ' + d.type];
    if (p.submission_id !== undefined) bits.push('#' + p.submission_id);
    if (p.verdict && p.verdict.status_msg) bits.push(p.verdict.status_msg + (p.verdict.status_code !== undefined ? ' (' + p.verdict.status_code + ')' : ''));
    if (p.orphan) bits.push('orphan');
    if (d.type === 'submission') bits.push('typed_code:' + (p.typed_code !== undefined ? 'yes' : 'no'));
    if (d.type === 'code') bits.push(p.code != null ? 'code:' + p.code.length + 'ch lang=' + p.lang + ' src=' + p.source : 'no code (' + p.reason + ')');
    if (d.type === 'ready') bits.push('capture=' + p.capture + ' v' + p.version);
    if (d.type === 'hello' || d.type === 'config') bits.push('consent=' + !!p.consent_code);
    if (d.type === 'capture_disabled') bits.push('reason=' + p.reason);
    if (d.reqId) bits.push('req=' + String(d.reqId).slice(0, 8));
    return bits.join('  ');
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__anchor !== true || ev.source !== window) return;
    logTo('#bridge-log', bridgeSummary(d));
  });
  function refreshPending() {
    var n = 0;
    try { var raw = localStorage.getItem('anchor_pending_events'); var arr = raw ? JSON.parse(raw) : []; n = Array.isArray(arr) ? arr.length : 0; } catch (_) { n = 0; }
    $('#pending-count').textContent = String(n);
    var main = !!window.__anchorMain;
    var iso = !!(document.documentElement.dataset && document.documentElement.dataset.anchorNonce);
    $('#ext-status').textContent = 'extension: MAIN ' + (main ? 'yes' : 'no') + ' · ISOLATED ' + (iso ? 'yes' : 'no');
    $('#ext-status').style.color = main && iso ? '#16a34a' : (main || iso ? '#d97706' : '#dc2626');
  }

  // ---------- wiring ----------
  function wire() {
    $('#next-problem').addEventListener('click', function (e) {
      e.preventDefault();
      var list = state.targets;
      var i = list.indexOf(state.slug);
      navigate(list[(i + 1) % list.length]);
    });
    $('#contest-toggle').addEventListener('click', function () {
      state.contest = !state.contest;
      var slug = slugFromPath();
      history.pushState({}, '', slug ? problemUrl(slug) : (location.pathname + (state.contest ? '?envType=contest' : '')));
      log('contest mode ' + (state.contest ? 'ON' : 'off') + ' -> ' + location.pathname + location.search);
      render();
    });
    $('#reload-btn').addEventListener('click', function () { location.reload(); });
    $('#lang-select').addEventListener('change', function () { applyLanguage(this.value, true); });
    $('#write-global-lang').addEventListener('change', function () { applyLanguage(state.lang, false); log('global_lang ' + (this.checked ? 'written' : 'cleared')); });
    $('#focus-toggle').addEventListener('click', function () {
      var code = currentCode();
      state.focus = !state.focus;
      this.textContent = 'Focus mode: ' + (state.focus ? 'ON' : 'off');
      this.classList.toggle('on', state.focus);
      mountEditor(code);
      log('focus mode ' + (state.focus ? 'ON (.cm-content, monaco.editor.getEditors() is empty)' : 'off (Monaco textarea inside #editor)'));
    });
    $('#xhr-toggle').addEventListener('click', function () {
      state.xhr = !state.xhr;
      this.textContent = 'Transport: ' + (state.xhr ? 'XHR' : 'fetch');
      this.classList.toggle('on', state.xhr);
    });
    $('#verdict-select').addEventListener('change', function () { applyVerdictMarker(this.value); log('verdict marker -> ' + this.value); });
    $('#run-btn').addEventListener('click', run);
    $('#submit-btn').addEventListener('click', submit);
    $('#repoll-btn').addEventListener('click', repoll);
    $('#orphan-btn').addEventListener('click', orphan);
    document.querySelectorAll('button[data-switch]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-switch');
        if (getCookie(name) === '1') delCookie(name); else setCookie(name, '1');
        renderSwitches();
        log('switch ' + name + ' -> ' + (getCookie(name) === '1' ? 'ON' : 'off'));
      });
    });
    $('#clear-pending').addEventListener('click', function () { try { localStorage.removeItem('anchor_pending_events'); } catch (_) { /* ignore */ } refreshPending(); log('cleared anchor_pending_events'); });
    window.addEventListener('popstate', function () { log('popstate'); render(); });
  }

  function boot() {
    if (!getCookie('csrftoken')) setCookie('csrftoken', 'fixture-csrf-token');
    wire();
    renderSwitches();
    try { var stored = localStorage.getItem('global_lang'); if (stored) { var v = JSON.parse(stored); if (LANG_LABEL[v]) state.lang = v; } } catch (_) { /* ignore */ }
    Promise.all([
      fetch('/data/problems.json').then(function (r) { return r.json(); }),
      fetch('/__fixture/meta').then(function (r) { return r.json(); })
    ]).then(function (res) {
      state.problems = res[0];
      state.targets = (res[1].targets || []).concat(res[1].solved || []);
      applyLanguage(state.lang, false);
      render();
    }).catch(function (err) {
      log('fixture data failed to load: ' + err.message);
      state.problems = {}; state.targets = [];
      render();
    });
    refreshPending();
    setInterval(refreshPending, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

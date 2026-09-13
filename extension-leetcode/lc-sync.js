// Anchor: first-run/incremental sync engine over a chrome.runtime Port named 'anchor-sync' (ISOLATED world).
// Receives from the panel: start{sync_id, resume, consent_code, detailsCap, since_id?}, ack{phase, seq?, cursor?}, pause, stop.
// Sends to the panel: status{phase,state,counts,until?}, header{seq,username,solved,tagCounts,progress,warning?},
//   page{phase:'subs'|'details', seq, cursor, items}, paused{reason,message?}, error{code,message}, done{recentAc,subsCount,detailsDone,backlogCount}.
// Durable cursor in chrome.storage.local.syncState advances only on ack; owner heartbeat every 10 s refuses a second tab.

(function () {
  'use strict';

  if (globalThis.AnchorSync) return;

  const STORAGE_KEY = 'syncState';
  const HEARTBEAT_MS = 10000;
  const OWNER_STALE_MS = 30000;
  const AC = 10;
  const OWNER_ID = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();

  function cfg() { return globalThis.ANCHOR_CONFIG || {}; }
  function num(v, def) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }
  function lookaheadPages() { return num(cfg().SYNC_LOOKAHEAD_PAGES, 10); }
  function detailsPageSize() { return num(cfg().SYNC_DETAILS_PAGE, 20); }
  function detailsCapDefault() { return num(cfg().DETAILS_CAP_DEFAULT, 300); }
  function recentAcCap() { return num(cfg().SYNC_RECENT_AC, 100); }

  function LC() { return globalThis.AnchorLC; }

  // ---------- pure helpers ----------
  function freshState(sync_id, opts, nowMs) {
    return {
      version: 1,
      sync_id: sync_id || String(nowMs),
      owner: { id: OWNER_ID, at: nowMs },
      phase: 'whoami',
      state: 'idle',
      reason: null,
      consent_code: !!opts.consent_code,
      detailsCap: num(opts.detailsCap, detailsCapDefault()),
      since_id: opts.since_id == null ? null : Number(opts.since_id),
      username: null,
      header: { acked: false, solvedCount: 0, warning: null },
      sweep: { cursor: { offset: 0, lastKey: '', done: false }, count: 0, pages: 0 },
      details: { planned: [], index: 0, done: 0, missing: 0, pages: 0 },
      backlog: [],
      recentAc: [],
      started_at: nowMs,
      updated_at: nowMs,
      finished_at: null
    };
  }

  // Splits failed-submission candidates (already newest-first) into the planned list and the backlog.
  function planDetails(candidateIds, cap) {
    const ids = candidateIds.slice();
    const planned = ids.slice(0, cap);
    const backlog = ids.slice(cap);
    return { planned, backlog };
  }

  function stripCode(items, consent) {
    if (consent) return items;
    return items.map((it) => { const o = Object.assign({}, it); delete o.code; return o; });
  }

  function sameCursor(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function ownedElsewhere(stored, nowMs) {
    return !!(stored && stored.state === 'running' && stored.owner && stored.owner.id !== OWNER_ID && nowMs - Number(stored.owner.at || 0) < OWNER_STALE_MS);
  }

  // Applies the meta of an acked page to the durable state.
  function applyAck(st, entry) {
    const m = entry.meta || {};
    if (entry.phase === 'header') {
      st.header.acked = true;
      st.header.solvedCount = m.solvedCount || 0;
      st.header.warning = m.warning || null;
    } else if (entry.phase === 'subs') {
      st.sweep.cursor = entry.cursor;
      st.sweep.count += m.count || 0;
      st.sweep.pages += 1;
      if (m.failedIds && m.failedIds.length) {
        const have = new Set(st.details.planned);
        for (const id of m.failedIds) if (!have.has(id)) { have.add(id); st.details.planned.push(id); }
      }
      if (m.acRows && m.acRows.length) {
        const cap = recentAcCap();
        const have = new Set(st.recentAc.map((r) => r.id));
        for (const r of m.acRows) {
          if (st.recentAc.length >= cap) break;
          if (!have.has(r.id)) { have.add(r.id); st.recentAc.push(r); }
        }
      }
    } else if (entry.phase === 'details') {
      st.details.index = entry.cursor.index;
      st.details.done += m.done || 0;
      st.details.missing += m.missing || 0;
      st.details.pages += 1;
    }
  }

  // ---------- storage ----------
  function contextGone(err) {
    return !(globalThis.chrome && chrome.runtime && chrome.runtime.id) || /context invalidated/i.test(String(err && err.message || err));
  }
  async function loadState() {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return got && got[STORAGE_KEY] ? got[STORAGE_KEY] : null;
  }
  async function saveState(st) {
    st.updated_at = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: st });
  }

  // ---------- run controller ----------
  let current = null;   // the latest run in this page; kept after it stops so late acks still advance the cursor
  let nextSeq = 0;      // page seqs are unique across runs, so a stale ack can never match a newer run's page

  function makeRun(port, st) {
    const run = {
      port, state: st,
      running: false,
      unacked: [],
      interrupted: null,      // 'pause' | 'stop' | 'disconnect'
      abort: new AbortController(),
      ackWaiters: [],
      heartbeat: null
    };
    return run;
  }

  function post(run, msg) {
    try { run.port.postMessage(msg); return true; }
    catch (_) { interrupt(run, 'disconnect'); return false; }
  }

  function liveCounts(run) {
    const st = run.state;
    let subsInFlight = 0, detailsInFlight = 0;
    for (const e of run.unacked) {
      if (e.phase === 'subs') subsInFlight += (e.meta && e.meta.count) || 0;
      if (e.phase === 'details') detailsInFlight += (e.meta && e.meta.done) || 0;
    }
    const lc = LC();
    return {
      solved: st.header.solvedCount,
      subs: st.sweep.count + subsInFlight,
      subsAcked: st.sweep.count,
      details: st.details.done + detailsInFlight,
      detailsAcked: st.details.done,
      detailsPlanned: Math.min(st.details.planned.length, st.detailsCap),
      detailsMissing: st.details.missing,
      backlog: st.backlog.length,
      recentAc: st.recentAc.length,
      unacked: run.unacked.length,
      requests: lc && lc.stats ? lc.stats().requests : 0
    };
  }

  function sendStatus(run, extra) {
    const st = run.state;
    post(run, Object.assign({
      type: 'status', sync_id: st.sync_id, phase: st.phase, state: st.state, username: st.username,
      since_id: st.since_id, counts: liveCounts(run)
    }, extra || {}));
  }

  function persist(run) {
    return saveState(run.state).catch((err) => { if (contextGone(err)) interrupt(run, 'disconnect'); });
  }

  function setPhase(run, phase) {
    run.state.phase = phase;
    sendStatus(run);
    return persist(run);
  }

  function interrupt(run, reason) {
    if (run.interrupted) return;
    run.interrupted = reason;
    try { run.abort.abort(); } catch (_) { /* ignore */ }
    wakeAckWaiters(run);
  }

  function wakeAckWaiters(run) {
    const ws = run.ackWaiters.splice(0);
    for (const w of ws) w();
  }
  function waitForAck(run) {
    return new Promise((resolve) => run.ackWaiters.push(resolve));
  }
  function aborted() { const e = new Error('aborted'); e.code = 'aborted'; e.name = 'LcError'; return e; }

  // Blocks while more than `max` pages are unacked (or until interrupted).
  async function drainAcks(run, max) {
    while (run.unacked.length > max) {
      if (run.interrupted) throw aborted();
      if (run.unacked.length > max) sendStatus(run, { waiting: 'ack' });
      await waitForAck(run);
    }
    if (run.interrupted) throw aborted();
  }

  function enqueue(run, phase, cursor, meta) {
    nextSeq += 1;
    const entry = { seq: nextSeq, phase, cursor, meta };
    run.unacked.push(entry);
    return entry;
  }

  function handleAck(run, msg) {
    const st = run.state;
    let upto = -1;
    if (msg.seq != null) {
      upto = Number(msg.seq);
    } else if (msg.cursor != null) {
      const e = run.unacked.find((x) => x.phase === msg.phase && sameCursor(x.cursor, msg.cursor));
      if (e) upto = e.seq;
    } else if (msg.phase === 'header') {
      const e = run.unacked.find((x) => x.phase === 'header');
      if (e) upto = e.seq;
    }
    if (upto < 0) return;
    let applied = 0;
    while (run.unacked.length && run.unacked[0].seq <= upto) {
      applyAck(st, run.unacked.shift());
      applied++;
    }
    if (applied) {
      persist(run);
      wakeAckWaiters(run);
      if (run.running) sendStatus(run);
    }
  }

  function reqOpts(run) {
    return {
      signal: run.abort.signal,
      onBackoff: (info) => sendStatus(run, { state: 'backoff', until: Date.now() + info.waitMs, http_status: info.status, attempt: info.attempt }),
      onHidden: () => sendStatus(run, { state: 'waiting_visible' })
    };
  }

  // ---------- phases ----------
  async function phaseWhoami(run) {
    const st = run.state;
    await setPhase(run, 'whoami');
    const me = await LC().whoami(reqOpts(run));
    if (!me.isSignedIn || !me.username) { const e = new Error('Sign in to LeetCode first'); e.code = 'lc_logged_out'; e.name = 'LcError'; throw e; }
    st.username = me.username;
  }

  async function phaseHeader(run) {
    const st = run.state;
    if (st.header.acked) return;
    await setPhase(run, 'solved');
    const opts = reqOpts(run);
    const { rows } = await LC().listSolved(async (acc) => {
      st.header.solvedCount = acc.length;
      sendStatus(run);
      return !run.interrupted;
    }, opts);
    if (run.interrupted) throw aborted();
    st.header.solvedCount = rows.length;
    await setPhase(run, 'skills');
    let tagCounts = {};
    let progress = null;
    let warning = null;
    try { tagCounts = (await LC().skillStats(st.username, opts)).tagCounts; } catch (err) { if (err && err.code === 'aborted') throw err; warning = 'skillStats unavailable'; }
    try { progress = await LC().progress(st.username, opts); } catch (err) { if (err && err.code === 'aborted') throw err; warning = (warning ? warning + '; ' : '') + 'progress unavailable'; }
    if (progress && progress.accepted && progress.accepted.total) {
      const accepted = progress.accepted.total;
      if (Math.abs(accepted - rows.length) > Math.max(5, accepted * 0.05)) {
        warning = (warning ? warning + '; ' : '') + `list has ${rows.length} solved but profile says ${accepted}`;
      }
    }
    const entry = enqueue(run, 'header', null, { solvedCount: rows.length, warning });
    post(run, { type: 'header', seq: entry.seq, sync_id: st.sync_id, username: st.username, solved: rows, tagCounts, progress, warning });
    await drainAcks(run, 0); // the backend needs the solved rows before any submission page
  }

  async function phaseSweep(run) {
    const st = run.state;
    if (st.sweep.cursor.done) return;
    await setPhase(run, 'sweep');
    const opts = Object.assign(reqOpts(run), { stopAtId: st.since_id });
    const ahead = lookaheadPages();
    await LC().sweepSubmissions(st.sweep.cursor, async (items, next) => {
      if (run.interrupted) return false;
      const failedIds = items.filter((s) => s.status_code !== AC).map((s) => s.id);
      const acRows = items.filter((s) => s.status_code === AC).map((s) => ({ id: s.id, slug: s.slug, timestamp: s.timestamp }));
      const entry = enqueue(run, 'subs', next, { count: items.length, failedIds, acRows });
      if (!post(run, { type: 'page', phase: 'subs', seq: entry.seq, sync_id: st.sync_id, cursor: next, items: stripCode(items, st.consent_code) })) return false;
      sendStatus(run);
      await drainAcks(run, ahead - 1);
      return !run.interrupted;
    }, opts);
    if (run.interrupted) throw aborted();
    await drainAcks(run, 0);
  }

  async function phaseDetails(run) {
    const st = run.state;
    await setPhase(run, 'details');
    const plan = planDetails(st.details.planned, st.detailsCap);
    st.backlog = plan.backlog;
    const ids = plan.planned;
    const size = detailsPageSize();
    const ahead = lookaheadPages();
    const opts = reqOpts(run);
    let i = st.details.index;
    while (i < ids.length) {
      const chunk = ids.slice(i, i + size);
      const out = [];
      let missing = 0;
      for (const id of chunk) {
        if (run.interrupted) throw aborted();
        const d = await LC().submissionDetails(id, opts);
        if (d) out.push(d); else missing++;
        sendStatus(run, { details_in_page: out.length });
      }
      i += chunk.length;
      const entry = enqueue(run, 'details', { index: i }, { done: out.length, missing });
      if (!post(run, { type: 'page', phase: 'details', seq: entry.seq, sync_id: st.sync_id, cursor: { index: i }, items: stripCode(out, st.consent_code) })) throw aborted();
      await drainAcks(run, ahead - 1);
    }
    await drainAcks(run, 0);
  }

  function sendDone(run) {
    const st = run.state;
    post(run, {
      type: 'done', sync_id: st.sync_id, username: st.username,
      recentAc: st.recentAc, solvedCount: st.header.solvedCount, subsCount: st.sweep.count,
      detailsDone: st.details.done, detailsMissing: st.details.missing, backlogCount: st.backlog.length,
      counts: liveCounts(run)
    });
  }

  async function execute(run) {
    const st = run.state;
    try {
      await phaseWhoami(run);
      await phaseHeader(run);
      await phaseSweep(run);
      await phaseDetails(run);
      await setPhase(run, 'final');
      st.state = 'done';
      st.phase = 'done';
      st.reason = null;
      st.finished_at = Date.now();
      await persist(run);
      sendStatus(run);
      sendDone(run);
    } catch (err) {
      const code = (err && err.code) || 'sync_failed';
      if (code === 'aborted' || run.interrupted) {
        st.state = 'paused';
        st.reason = run.interrupted === 'stop' ? 'stopped' : (run.interrupted === 'disconnect' ? 'disconnected' : 'user');
        await persist(run);
        if (run.interrupted === 'pause') { sendStatus(run); post(run, { type: 'paused', reason: 'user' }); }
        else if (run.interrupted === 'stop') sendStatus(run, { state: 'stopped' });
      } else if (code === 'rate_limited' || code === 'challenge' || code === 'lc_logged_out') {
        st.state = 'paused';
        st.reason = code;
        await persist(run);
        sendStatus(run);
        post(run, { type: 'paused', reason: code, message: String(err.message || code), retryAfterMs: err.retryAfterMs || null });
      } else {
        st.state = 'error';
        st.reason = code;
        await persist(run);
        sendStatus(run);
        post(run, { type: 'error', code, message: String((err && err.message) || code) });
      }
    } finally {
      if (run.heartbeat) clearInterval(run.heartbeat);
      run.heartbeat = null;
      run.running = false;
    }
  }

  // ---------- port protocol ----------
  async function handleStart(port, msg) {
    const now = Date.now();
    if (current && current.running && !current.interrupted) {
      if (current.port === port) { sendStatus(current); return; }
      try { port.postMessage({ type: 'error', code: 'sync_busy', message: 'A sync is already running in this tab' }); } catch (_) { /* ignore */ }
      return;
    }
    let stored = null;
    try { stored = await loadState(); }
    catch (err) { try { port.postMessage({ type: 'error', code: 'storage_unavailable', message: String(err && err.message || err) }); } catch (_) { /* ignore */ } return; }
    if (ownedElsewhere(stored, now)) {
      try { port.postMessage({ type: 'error', code: 'sync_owned_elsewhere', message: 'Another LeetCode tab is already syncing' }); } catch (_) { /* ignore */ }
      return;
    }
    let st;
    if (msg.resume && stored && stored.version === 1) {
      st = stored;
      if (msg.consent_code != null) st.consent_code = !!msg.consent_code;
      if (msg.detailsCap != null) st.detailsCap = num(msg.detailsCap, st.detailsCap);
      if (msg.since_id != null) st.since_id = Number(msg.since_id);
      if (st.state === 'done') {
        const r = makeRun(port, st);
        sendStatus(r);
        sendDone(r);
        return;
      }
      // details plan can shrink/grow with a new cap; keep the acked index bounded
      st.details.index = Math.min(st.details.index, st.detailsCap);
    } else {
      st = freshState(msg.sync_id, msg, now);
    }
    st.owner = { id: OWNER_ID, at: now };
    st.state = 'running';
    st.reason = null;
    const run = makeRun(port, st);
    if (current) current.unacked = []; // a superseded run must never persist over the new one
    current = run;
    run.running = true;
    run.heartbeat = setInterval(() => { st.owner = { id: OWNER_ID, at: Date.now() }; persist(run); }, HEARTBEAT_MS);
    await persist(run);
    sendStatus(run);
    execute(run);
  }

  function handleMessage(port, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'start': handleStart(port, msg); break;
      case 'ack': if (current && current.port === port) handleAck(current, msg); break;
      case 'pause': if (current && current.running && current.port === port) interrupt(current, 'pause'); break;
      case 'stop': if (current && current.running && current.port === port) interrupt(current, 'stop'); break;
      case 'status': {
        if (current && current.running && current.port === port) { sendStatus(current); break; }
        loadState().then((stored) => {
          try { port.postMessage({ type: 'status', phase: stored ? stored.phase : null, state: stored ? stored.state : 'idle', reason: stored ? stored.reason : null, sync_id: stored ? stored.sync_id : null, username: stored ? stored.username : null, counts: stored ? { solved: stored.header.solvedCount, subs: stored.sweep.count, details: stored.details.done, backlog: stored.backlog.length } : null, resumable: !!(stored && stored.state !== 'done') }); } catch (_) { /* ignore */ }
        }).catch(() => {});
        break;
      }
      default: break;
    }
  }

  function attachPort(port) {
    if (!port || port.name !== 'anchor-sync') return false;
    port.onMessage.addListener((msg) => { try { handleMessage(port, msg); } catch (_) { /* never throw into the port */ } });
    port.onDisconnect.addListener(() => { if (current && current.running && current.port === port) interrupt(current, 'disconnect'); });
    handleMessage(port, { type: 'status' });
    return true;
  }

  globalThis.AnchorSync = {
    attachPort,
    ownerId: OWNER_ID,
    _pure: { freshState, planDetails, stripCode, sameCursor, ownedElsewhere, applyAck }
  };
})();

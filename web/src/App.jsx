import { useEffect, useMemo, useState } from 'react';

const API_BASE = 'http://localhost:4000';

const STATUS_LABELS = {
  unreviewed: 'Active',
  confirmed: 'Accepted',
  deferred: 'Ignored',
  rejected: 'Rejected'
};

export default function App() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('unreviewed');
  const [view, setView] = useState('findings');
  const [findings, setFindings] = useState([]);
  const [records, setRecords] = useState([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const isLoggedIn = Boolean(token);
  const [tokenValid, setTokenValid] = useState(null);
  const groupedFindings = useMemo(() => groupBySnapshot(findings), [findings]);
  const maskedToken = token ? `${token.slice(0, 8)}••••••••` : '';

  useEffect(() => {
    const stored = localStorage.getItem('friction_token');
    if (stored) setToken(stored);
    const hash = window.location.hash || '';
    if (hash.startsWith('#token=')) {
      const incoming = decodeURIComponent(hash.replace('#token=', ''));
      if (incoming) {
        localStorage.setItem('friction_token', incoming);
        setToken(incoming);
        setMessage('Token saved.');
        window.history.replaceState({}, document.title, '/reports');
        loadFindings('unreviewed');
      }
    }
  }, []);

  const activeCount = useMemo(
    () => findings.filter((item) => item.state === 'unreviewed').length,
    [findings]
  );

  const loadFindings = async (nextStatus = status) => {
    if (!token) {
      setMessage('Paste your token to load findings.');
      setTokenValid(false);
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const url = `${API_BASE}/api/findings?state=${nextStatus}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (response.status === 401) {
        setTokenValid(false);
        setMessage('Token invalid. Please log in again.');
        setFindings([]);
        localStorage.removeItem('friction_token');
        setToken('');
        return;
      }
      setTokenValid(true);
      const data = await response.json();
      setFindings(data.findings || []);
    } catch (err) {
      setMessage('Failed to load findings.');
    } finally {
      setLoading(false);
    }
  };

  const loadReports = async () => {
    if (!token) {
      setMessage('Paste your token to load reports.');
      setTokenValid(false);
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const response = await fetch(`${API_BASE}/api/reports/summary`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (response.status === 401) {
        setTokenValid(false);
        setMessage('Token invalid. Please log in again.');
        setRecords([]);
        localStorage.removeItem('friction_token');
        setToken('');
        return;
      }
      setTokenValid(true);
      const data = await response.json();
      setRecords(data.report || []);
    } catch (err) {
      setMessage('Failed to load report.');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenSave = () => {
    localStorage.setItem('friction_token', token);
    setMessage('Token saved.');
    setTokenValid(null);
    loadFindings('unreviewed');
  };

  const handleCopyToken = async () => {
    if (!token) {
      setMessage('No token to copy.');
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setMessage('Token copied.');
    } catch (err) {
      setMessage('Copy failed.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('friction_token');
    setToken('');
    setFindings([]);
    setRecords([]);
    setMessage('Logged out.');
    setTokenValid(null);
  };

  const updateFinding = async (id, action) => {
    if (!token) return;

    const map = {
      confirm: { method: 'POST', path: `/api/findings/${id}/confirm` },
      defer: { method: 'POST', path: `/api/findings/${id}/defer` },
      reject: { method: 'DELETE', path: `/api/findings/${id}` },
      resolve: { method: 'POST', path: `/api/findings/${id}/resolve` }
    };

    const payload = map[action];
    if (!payload) return;

    await fetch(`${API_BASE}${payload.path}`, {
      method: payload.method,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    setFindings((items) => items.filter((item) => item.finding_id !== id));
  };

  const openGoogleLogin = () => {
    window.open(`${API_BASE}/auth/google`, '_blank', 'noopener');
  };

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold">Friction</h1>
            <p className="text-muted">{activeCount} active findings</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`border px-3 py-1 text-xs ${
                isLoggedIn && tokenValid !== false
                  ? 'border-emerald-500/50 text-emerald-200'
                  : 'border-border text-muted'
              }`}
            >
              {isLoggedIn
                ? tokenValid === false
                  ? 'Token invalid'
                  : 'Logged in'
                : 'Not logged in'}
            </span>
            <button
              className="border border-border px-4 py-2 text-sm text-muted hover:text-white"
              onClick={openGoogleLogin}
            >
              Login with Google
            </button>
            {isLoggedIn && (
              <button
                className="border border-border px-4 py-2 text-sm text-muted hover:text-white"
                onClick={handleLogout}
              >
                Clear token
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 border border-border bg-card px-4 py-3 shadow-soft lg:flex-row lg:items-center">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">Extension token</div>
          <div className="flex flex-1 items-center gap-2">
            <input
              className="w-full border border-border bg-transparent text-xs text-white"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste JWT"
            />
            <button
              className="border border-border px-3 py-2 text-xs text-muted hover:text-white"
              onClick={handleTokenSave}
            >
              Save
            </button>
          </div>
          <div className="border border-border bg-black/40 px-3 py-2 text-xs text-muted lg:w-[180px]">
            {maskedToken || 'No token saved yet.'}
          </div>
          <button
            className="border border-border px-3 py-2 text-xs text-muted hover:text-white"
            onClick={handleCopyToken}
          >
            Copy token
          </button>
          {message && <div className="text-xs text-muted">{message}</div>}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-[2.3fr]">
          <div className="border border-border bg-card p-4 shadow-soft">
            <div className="flex flex-wrap items-center gap-2">
              {['findings', 'reports'].map((item) => (
                <button
                  key={item}
                  className={`border px-3 py-1 text-xs ${
                    view === item
                      ? 'border-accent bg-accent/20 text-white'
                      : 'border-border text-muted'
                  }`}
                  onClick={() => {
                    setView(item);
                    if (item === 'findings') loadFindings(status);
                    if (item === 'reports') loadReports();
                  }}
                >
                  {item === 'findings' ? 'Findings' : 'Reports'}
                </button>
              ))}
              <button
                className="ml-auto border border-border px-3 py-1 text-xs text-muted"
                onClick={() => {
                  if (view === 'findings') loadFindings(status);
                  if (view === 'reports') loadReports();
                }}
              >
                Refresh
              </button>
            </div>

            {view === 'findings' && (
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {['unreviewed', 'confirmed', 'deferred', 'rejected'].map((item) => (
                    <button
                      key={item}
                      className={`border px-3 py-1 text-xs ${
                        status === item
                          ? 'border-accent bg-accent/20 text-white'
                          : 'border-border text-muted'
                      }`}
                      onClick={() => {
                        setStatus(item);
                        loadFindings(item);
                      }}
                    >
                      {STATUS_LABELS[item]}
                    </button>
                  ))}
                </div>

                {loading && <div className="text-sm text-muted">Loading...</div>}
                {!loading && findings.length === 0 && (
                  <div className="text-sm text-muted">No findings here yet.</div>
                )}

                {groupedFindings.map((group) => (
                  <div key={group.key} className="space-y-4">
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <div className="h-px flex-1 bg-border" />
                      <span className="border border-border px-3 py-1">
                        {formatTimestamp(group.timestamp)}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    {group.items.map((finding) => (
                      <div
                        key={finding.finding_id}
                        className="border border-border bg-black/50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`border px-3 py-1 text-xs font-semibold capitalize ${
                                  finding.type === 'insight'
                                    ? 'border-emerald-500/40 bg-emerald-900/60 text-emerald-200'
                                    : 'border-amber-500/40 bg-amber-900/60 text-amber-200'
                                }`}
                              >
                                {finding.type}
                              </span>
                              <span className="border border-border px-3 py-1 text-xs text-muted">
                                {finding.confidence_ai}
                              </span>
                            </div>
                            <h3 className="mt-2 text-lg font-semibold">{finding.topic}</h3>
                            <p className="mt-2 text-sm text-muted">{finding.summary}</p>
                            {finding.recall_anchor && (
                              <p className="mt-2 text-xs text-muted">Recall: {finding.recall_anchor}</p>
                            )}
                          </div>
                          <div className="flex flex-col gap-2">
                            {status !== 'confirmed' && (
                              <button
                                className="border border-emerald-500/40 px-3 py-1 text-xs text-emerald-200"
                                onClick={() => updateFinding(finding.finding_id, 'confirm')}
                              >
                                Accept
                              </button>
                            )}
                            {status !== 'deferred' && (
                              <button
                                className="border border-amber-500/40 px-3 py-1 text-xs text-amber-200"
                                onClick={() => updateFinding(finding.finding_id, 'defer')}
                              >
                                Ignore
                              </button>
                            )}
                            {status === 'confirmed' ? (
                              <button
                                className="border border-emerald-500/40 px-3 py-1 text-xs text-emerald-200"
                                onClick={() => updateFinding(finding.finding_id, 'resolve')}
                              >
                                Resolve
                              </button>
                            ) : (
                              <button
                                className="border border-red-500/40 px-3 py-1 text-xs text-red-200"
                                onClick={() => updateFinding(finding.finding_id, 'reject')}
                              >
                                Reject
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {view === 'reports' && (
              <div className="mt-4 space-y-4">
                {loading && <div className="text-sm text-muted">Loading...</div>}
                {!loading && records.length === 0 && (
                  <div className="text-sm text-muted">No learning records yet.</div>
                )}
                {records.map((record) => (
                  <div key={record.topic} className="border border-border bg-black/50 p-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={`border px-3 py-1 text-xs font-semibold capitalize ${
                          record.type === 'insight'
                            ? 'border-emerald-500/40 bg-emerald-900/60 text-emerald-200'
                            : 'border-amber-500/40 bg-amber-900/60 text-amber-200'
                        }`}
                      >
                        {record.type}
                      </span>
                      <span className="border border-border px-3 py-1 text-xs text-muted">
                        {record.occurrence_count}x
                      </span>
                    </div>
                    <h3 className="mt-2 text-lg font-semibold">{record.topic}</h3>
                    <p className="mt-2 text-sm text-muted">{record.summary}</p>
                    {record.recall_anchor && (
                      <p className="mt-2 text-xs text-muted">Recall: {record.recall_anchor}</p>
                    )}
                    <div className="mt-3 text-xs text-muted">
                      Last seen {new Date(record.last_admitted_at).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function groupBySnapshot(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.snapshot_id || 'unknown';
    const timestamp = item.snapshot_created_at || item.created_at;
    if (!groups.has(key)) {
      groups.set(key, { key, timestamp, items: [] });
    }
    groups.get(key).items.push(item);
  });
  return Array.from(groups.values());
}

function formatTimestamp(value) {
  if (!value) return 'Unknown snapshot';
  const date = new Date(value);
  return date.toLocaleString();
}

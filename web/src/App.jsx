import { useEffect, useMemo, useState } from 'react';

const API_BASE = 'http://localhost:4000';

const STATUS_LABELS = {
  unreviewed: 'Active',
  confirmed: 'Accepted',
  deferred: 'Ignored'
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
  const [theme, setTheme] = useState(() => {
    const storedTheme = localStorage.getItem('friction_theme');
    return storedTheme || 'dark';
  });

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('friction_theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!token) return;
    setView('findings');
    setStatus('unreviewed');
    loadFindings('unreviewed');
  }, [token]);

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

  const handleCopyToken = async () => {
    if (!token) {
      alert('No token to copy.');
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      alert('Token copied. Paste it into the extension to connect.');
    } catch (err) {
      alert('Copy failed.');
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

  const generateReport = async () => {
    if (!token) {
      alert('Login required to generate report.');
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/snapshots/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ trigger_type: 'manual' })
      });
      if (response.status === 401) {
        setTokenValid(false);
        setMessage('Token invalid. Please log in again.');
        localStorage.removeItem('friction_token');
        setToken('');
        return;
      }
      loadFindings('unreviewed');
    } catch (err) {
      alert('Failed to generate report.');
    }
  };

  const updateFinding = async (id, action) => {
    if (!token) return;

    const map = {
      confirm: { method: 'POST', path: `/api/findings/${id}/confirm` },
      defer: { method: 'POST', path: `/api/findings/${id}/defer` },
      resolve: { method: 'POST', path: `/api/findings/${id}/resolve` }
    };

    const payload = map[action];
    if (!payload) return;

    const response = await fetch(`${API_BASE}${payload.path}`, {
      method: payload.method,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (response.status === 401) {
      setTokenValid(false);
      setMessage('Token invalid. Please log in again.');
      localStorage.removeItem('friction_token');
      setToken('');
      return;
    }

    setFindings((items) => items.filter((item) => item.finding_id !== id));
  };

  const openGoogleLogin = () => {
    window.open(`${API_BASE}/auth/google`, '_blank', 'noopener');
  };

  return (
    <div className="frame">
      <header className="topbar">
        <div className="brand">
          <div className="title">FRICTION</div>
          <div className="subtitle">GS1313©</div>
        </div>
        <div className="status">
          <button className="btn ghost" onClick={handleCopyToken}>Connect</button>
          <button className="btn" onClick={generateReport}>Generate report</button>
          <button
            className="btn ghost"
            onClick={() => {
              setView('reports');
              loadReports();
            }}
          >
            View reports
          </button>
          <button
            className="btn ghost"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          >
            Theme
          </button>
          <button
            className="btn ghost"
            onClick={isLoggedIn ? handleLogout : openGoogleLogin}
          >
            {isLoggedIn ? 'Logout' : 'Login'}
          </button>
        </div>
      </header>

      {message && message !== 'Logged out.' && <div className="message">{message}</div>}

      <main className="content">
        <aside className="panel">
          <div className="panel-title">Filters</div>
          <div className="tabrow">
            {['findings', 'reports'].map((item) => (
              <button
                key={item}
                className={`tab ${view === item ? 'active' : ''}`}
                onClick={() => {
                  setView(item);
                  if (item === 'findings') loadFindings(status);
                  if (item === 'reports') loadReports();
                }}
              >
                {item === 'findings' ? 'Findings' : 'Reports'}
              </button>
            ))}
          </div>
          <div className="tabrow">
            {['unreviewed', 'confirmed', 'deferred'].map((item) => (
              <button
                key={item}
                className={`tab ${status === item ? 'active' : ''}`}
                onClick={() => {
                  setStatus(item);
                  loadFindings(item);
                }}
              >
                {STATUS_LABELS[item]}
              </button>
            ))}
          </div>
          <div className="meta">{activeCount} active findings</div>
        </aside>

        <section className="stream">
          {view === 'findings' && (
            <>
              {loading && <div className="meta">Loading...</div>}
              {!loading && findings.length === 0 && (
                <div className="meta">No findings here yet.</div>
              )}

              {groupedFindings.map((group) => (
                <details key={group.key} className="batch">
                  <summary>
                    <div className="summary-left">
                      <span className="chevron">▸</span>
                      <span>{formatTimestamp(group.timestamp)}</span>
                    </div>
                    <div className="summary-right">
                      <div className="dot-row">
                        {renderDotCount('gap', group.items)}
                        {renderDotCount('insight', group.items)}
                        {renderDotCount('pattern', group.items)}
                      </div>
                      <span className="count">{group.items.length} findings</span>
                    </div>
                    <div className="summary-sub">
                      {getPreviewTitles(group.items).map((title, index) => (
                        <div key={`${group.key}-preview-${index}`} className={`summary-item s${index + 1}`}>
                          {title}
                        </div>
                      ))}
                    </div>
                  </summary>
                  <div className="batch-body">
                    {group.items.map((finding) => (
                      <article key={finding.finding_id} className="card">
                        <div className="card-head">
                          <div className="tags">
                            <span className={`tag ${finding.type}`}>{finding.type}</span>
                            <span className="tag">{finding.confidence_ai}</span>
                          </div>
                          <div className="actions">
                            {status !== 'confirmed' && (
                              <button className="btn tiny" onClick={() => updateFinding(finding.finding_id, 'confirm')}>
                                Accept
                              </button>
                            )}
                            {status !== 'deferred' && (
                              <button className="btn tiny ghost" onClick={() => updateFinding(finding.finding_id, 'defer')}>
                                Ignore
                              </button>
                            )}
                            {status === 'confirmed' && (
                              <button className="btn tiny ghost" onClick={() => updateFinding(finding.finding_id, 'resolve')}>
                                Resolve
                              </button>
                            )}
                          </div>
                        </div>
                        <h3>{finding.topic}</h3>
                        <p>{finding.summary}</p>
                        {finding.recall_anchor && <div className="anchor">Recall: {finding.recall_anchor}</div>}
                      </article>
                    ))}
                  </div>
                </details>
              ))}
            </>
          )}

          {view === 'reports' && (
            <>
              {loading && <div className="meta">Loading...</div>}
              {!loading && records.length === 0 && (
                <div className="meta">No learning records yet.</div>
              )}
              {records.map((record) => (
                <article key={record.topic} className="card">
                  <div className="card-head">
                    <div className="tags">
                      <span className={`tag ${record.type}`}>{record.type}</span>
                      <span className="tag">{record.occurrence_count}x</span>
                    </div>
                  </div>
                  <h3>{record.topic}</h3>
                  <p>{record.summary}</p>
                  {record.recall_anchor && <div className="anchor">Recall: {record.recall_anchor}</div>}
                  <div className="meta">Last seen {new Date(record.last_admitted_at).toLocaleDateString()}</div>
                </article>
              ))}
            </>
          )}
        </section>
      </main>
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

function renderDotCount(type, items) {
  const count = items.filter((item) => item.type === type).length;
  return (
    <span className="dot-item">
      <span className={`dot ${type}`} />
      <span>{count}</span>
    </span>
  );
}

function getPreviewTitles(items) {
  const titles = items.map((item) => item.topic).filter(Boolean);
  return titles.slice(0, 3);
}

import { useEffect, useMemo, useState, useRef } from 'react';
import {
  IconLink, IconSpark, IconList, IconMoon, IconSun,
  IconHome, IconLogin, IconLogout, IconCheck, IconSlash,
  IconCheckCircle, IconLoader, IconClose
} from './icons';

const IS_LOCAL_HOST =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const API_BASE =
  import.meta.env.VITE_API_BASE || (IS_LOCAL_HOST ? 'http://localhost:4000' : 'https://friction.onrender.com');
const WEB_BASE =
  import.meta.env.VITE_WEB_BASE || (IS_LOCAL_HOST ? window.location.origin : 'https://nofriction.netlify.app');

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
  const [pendingActions, setPendingActions] = useState({});
  const isLoggedIn = Boolean(token);
  const [tokenValid, setTokenValid] = useState(null);
  const groupedFindings = useMemo(() => groupBySnapshot(findings), [findings]);
  const [openBatchId, setOpenBatchId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState('findings');
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef(null);
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

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
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
      const url = `${API_BASE}/api/findings?state=${nextStatus}&_=${Date.now()}`;
      const response = await fetch(url, {
        cache: 'no-store',
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
      const response = await fetch(`${API_BASE}/api/reports/summary?_=${Date.now()}`, {
        cache: 'no-store',
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
      setMessage('No token to copy.');
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setMessage('Token copied. Paste it into the extension to connect.');
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

  const generateReport = async () => {
    if (!token) {
      setMessage('Login required to generate report.');
      return;
    }
    try {
      const width = Math.floor(window.screen.availWidth * 0.45);
      const height = Math.floor(window.screen.availHeight * 0.9);
      const left = window.screen.availWidth - width;
      const top = Math.floor((window.screen.availHeight - height) / 2);
      window.open(
        `${WEB_BASE}/reports`,
        'friction-reports',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      );

      const response = await fetch(`${API_BASE}/api/snapshots/run`, {
        method: 'POST',
        cache: 'no-store',
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
      setMessage('Failed to generate report.');
    }
  };

  const updateFinding = async (id, action) => {
    if (!token) return;
    if (pendingActions[id]) return;

    const map = {
      confirm: { method: 'POST', path: `/api/findings/${id}/confirm` },
      defer: { method: 'POST', path: `/api/findings/${id}/defer` },
      resolve: { method: 'POST', path: `/api/findings/${id}/resolve` }
    };

    const payload = map[action];
    if (!payload) return;

    setPendingActions((prev) => ({ ...prev, [id]: action }));
    let removedFinding = null;
    let removedIndex = -1;

    setFindings((items) => {
      removedIndex = items.findIndex((item) => item.finding_id === id);
      if (removedIndex === -1) return items;
      removedFinding = items[removedIndex];
      return items.filter((item) => item.finding_id !== id);
    });

    try {
      const response = await fetch(`${API_BASE}${payload.path}`, {
        method: payload.method,
        cache: 'no-store',
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
      if (!response.ok) {
        throw new Error('finding_update_failed');
      }
    } catch (err) {
      if (removedFinding) {
        setFindings((items) => {
          if (items.some((item) => item.finding_id === id)) return items;
          const next = [...items];
          const safeIndex = Math.max(0, Math.min(removedIndex, next.length));
          next.splice(safeIndex, 0, removedFinding);
          return next;
        });
      }
      setMessage('Action failed. Please retry.');
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const openGoogleLogin = () => {
    window.open(`${API_BASE}/auth/google`, '_blank', 'noopener');
  };

  const performSearch = async (query) => {
    if (!query || query.trim().length < 2) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/search?q=${encodeURIComponent(query)}&target=${searchTarget}&limit=8`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );
      if (response.status === 401) return;
      const data = await response.json();
      setSearchResults(data.results || []);
      setSearchOpen(data.results && data.results.length > 0);
    } catch (err) {
      setSearchResults([]);
      setSearchOpen(false);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => performSearch(query), 300);
  };

  const toggleSearchTarget = () => {
    const next = searchTarget === 'findings' ? 'records' : 'findings';
    setSearchTarget(next);
    if (searchQuery.trim().length >= 2) {
      performSearch(searchQuery);
    }
  };

  const showLoginHint = !isLoggedIn;
  const showConnectHint = isLoggedIn;

  return (
    <div className="frame">
      <header className="topbar">
        <div className="brand">
          <div className="title">FRICTION</div>
          <div className="subtitle">The Winner takes it all</div>
        </div>
        <div className="status">
          {isLoggedIn && (
            <div className="search-container">
              <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                className="search-input"
                type="text"
                placeholder="Search insights..."
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
              />
              {searchResults.length > 0 && (
                <div className={`search-results ${searchOpen ? 'visible' : ''}`}>
                  <div className="search-results-header">
                    <span>{searchResults.length} results</span>
                    <div className="search-target-toggle">
                      <button
                        className={`search-target-btn ${searchTarget === 'findings' ? 'active' : ''}`}
                        onClick={toggleSearchTarget}
                      >
                        {searchTarget === 'findings' ? 'Findings' : 'Records'}
                      </button>
                    </div>
                  </div>
                  {searchLoading ? (
                    <div className="search-empty">Searching...</div>
                  ) : searchResults.length === 0 ? (
                    <div className="search-empty">No results found</div>
                  ) : (
                    searchResults.map((result) => (
                      <div
                        key={result.topic}
                        className="search-result-item"
                        onClick={() => {
                          setSearchOpen(false);
                          setSearchQuery('');
                        }}
                      >
                        <div className="search-result-topic">
                          {result.topic}
                        </div>
                        <div className="search-result-summary">
                          {result.items[0]?.summary || result.topic}
                        </div>
                        <div className="search-result-meta">
                          <span className={`search-result-type ${result.type}`}>
                            {result.items[0]?.item_type || result.type}
                          </span>
                          {result.total_occurrences > 0 && (
                            <span className="search-result-occurrences">seen {result.total_occurrences}x</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <a
            className="btn ghost icon"
            href={`${WEB_BASE}/`}
            aria-label="Landing"
            data-tooltip="Landing"
          >
            <IconHome />
          </a>
          <button
            className={`btn ghost icon ${showConnectHint ? 'highlight tooltip-visible' : ''}`}
            onClick={handleCopyToken}
            aria-label="Connect to ext"
            data-tooltip="Connect"
          >
            <IconLink />
          </button>
          <button
            className="btn icon"
            onClick={generateReport}
            aria-label="Gen report"
            data-tooltip="Gen report"
          >
            <IconSpark />
          </button>
          <button
            className="btn ghost icon"
            onClick={() => {
              setView('reports');
              loadReports();
            }}
            aria-label="View reports"
            data-tooltip="View reports"
          >
            <IconList />
          </button>
          <button
            className="btn ghost icon"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            aria-label="Theme"
            data-tooltip="Theme"
          >
            {theme === 'dark' ? <IconMoon /> : <IconSun />}
          </button>
          <button
            className={`btn ghost icon ${showLoginHint ? 'highlight tooltip-visible' : ''}`}
            onClick={isLoggedIn ? handleLogout : openGoogleLogin}
            aria-label={isLoggedIn ? 'Logout' : 'Login'}
            data-tooltip={isLoggedIn ? 'Logout' : 'Login'}
          >
            {isLoggedIn ? <IconLogout /> : <IconLogin />}
          </button>
        </div>
      </header>

      {message && message !== 'Logged out.' && <div className="message">{message}</div>}
      {showConnectHint && (
        <div className="message notice">
          If the extension isn't connected, click the Connect button in the top bar.
        </div>
      )}
      {showLoginHint && (
        <div className="message notice">
          Please login to access reports.
        </div>
      )}

      <main className="content">
        <div className="filters-bar">
          <div className="filters-group">
            <span className="filters-label">View</span>
            <div className="pill-row">
              {['findings', 'reports'].map((item) => (
                <button
                  key={item}
                  className={`pill-btn ${view === item ? 'active' : ''}`}
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
          </div>
          {view === 'findings' && (
            <>
              <div className="filters-divider" />
              <div className="filters-group">
                <span className="filters-label">Status</span>
                <div className="pill-row">
                  {['unreviewed', 'confirmed', 'deferred'].map((item) => (
                    <button
                      key={item}
                      className={`pill-btn ${status === item ? 'active' : ''}`}
                      onClick={() => {
                        setStatus(item);
                        loadFindings(item);
                      }}
                    >
                      {STATUS_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="filters-count">{activeCount} active findings</div>
            </>
          )}
        </div>

        <section className={`stream ${view}`}>
          {view === 'findings' && (
            <>
              {loading && <div className="meta">Loading...</div>}
              {!loading && findings.length === 0 && (
                <div className="meta">No findings here yet.</div>
              )}

              {groupedFindings.map((group) => {
                const isOpen = openBatchId === group.key;
                return (
                  <button
                    key={group.key}
                    type="button"
                    className={`batch-card ${isOpen ? 'open' : ''}`}
                    onClick={() => setOpenBatchId(isOpen ? null : group.key)}
                    aria-expanded={isOpen}
                  >
                    <div className="batch-head">
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
                    </div>
                    <div className="summary-sub">
                      {getPreviewTitles(group.items).map((title, index) => (
                        <div key={`${group.key}-preview-${index}`} className={`summary-item s${index + 1}`}>
                          {title}
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
              {openBatchId && (
                <div className="batch-modal-overlay" onClick={() => setOpenBatchId(null)}>
                  {groupedFindings
                    .filter((group) => group.key === openBatchId)
                    .map((group) => (
                      <div
                        key={`${group.key}-modal`}
                        className="batch-modal"
                        onClick={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                      >
                        <button
                          type="button"
                          className="batch-modal-head"
                          aria-label="Close"
                          data-tooltip="Close"
                          onClick={() => setOpenBatchId(null)}
                        >
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
                          <span className="modal-close">
                            <IconClose />
                          </span>
                        </button>
                        <div className={`batch-body ${group.items.length > 1 ? 'two-col' : 'single-col'}`}>
                          {group.items.map((finding) => {
                            const isUpdating = Boolean(pendingActions[finding.finding_id]);
                            return (
                            <article
                              key={finding.finding_id}
                              className={`card ${isUpdating ? 'busy' : ''}`}
                            >
                              <div className="card-head">
                                <div className="tags">
                                  {formatDomainLabel(finding)}
                                  <span className={`tag ${finding.type}`}>{finding.type}</span>
                                  <span className="tag">{finding.confidence_ai}</span>
                                </div>
                                <div className="actions">
                                  {status !== 'confirmed' && (
                                  <button
                                    className="btn tiny icon"
                                    onClick={() => updateFinding(finding.finding_id, 'confirm')}
                                    disabled={isUpdating}
                                    aria-label="Accept"
                                    data-tooltip="Accept"
                                  >
                                    {isUpdating ? <IconLoader /> : <IconCheck />}
                                  </button>
                                  )}
                                  {status !== 'deferred' && (
                                  <button
                                    className="btn tiny ghost icon"
                                    onClick={() => updateFinding(finding.finding_id, 'defer')}
                                    disabled={isUpdating}
                                    aria-label="Ignore"
                                    data-tooltip="Ignore"
                                  >
                                    {isUpdating ? <IconLoader /> : <IconSlash />}
                                  </button>
                                  )}
                                  {status === 'confirmed' && (
                                  <button
                                    className="btn tiny ghost icon"
                                    onClick={() => updateFinding(finding.finding_id, 'resolve')}
                                    disabled={isUpdating}
                                    aria-label="Resolve"
                                    data-tooltip="Resolve"
                                  >
                                    {isUpdating ? <IconLoader /> : <IconCheckCircle />}
                                  </button>
                                  )}
                                </div>
                              </div>
                              <h3>{finding.topic}</h3>
                              <p>{finding.summary}</p>
                              {finding.recall_anchor && <div className="anchor">Recall: {finding.recall_anchor}</div>}
                            </article>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}

          {view === 'reports' && (
            <>
              {loading && <div className="meta">Loading...</div>}
              {!loading && records.length === 0 && (
                <div className="meta">No learning records yet.</div>
              )}
              {records.map((record) => (
                <article key={record.record_id || record.topic} className="card">
                  <div className="card-head">
                    <div className="tags">
                      <span className={`tag ${record.type}`}>{record.type}</span>
                      <span className="tag">{record.occurrence_count}x</span>
                      {record.confidence_ai && <span className="tag">{record.confidence_ai}</span>}
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

function formatDomainLabel(finding) {
  const domainLabel = finding.domain_label || finding.domain_name;
  const domainText = domainLabel
    ? `${domainLabel}${finding.subdomain_name ? ` · ${finding.subdomain_name}` : ''}`
    : '';
  return domainText ? <span className="tag domain">{domainText}</span> : null;
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

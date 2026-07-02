function getApiBase() {
  return globalThis.FRICTION_CONFIG?.API_BASE;
}

export async function saveMoment(rawText, sourceType = 'bulk_paste', sourceUrl = null, captureHash = null) {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { ok: false, error: 'missing_token' };

  const response = await globalThis.FrictionExt.fetchWithAuth(`${getApiBase()}/api/moments`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw_text: rawText,
      source_type: sourceType,
      source_url: sourceUrl,
      capture_hash: captureHash,
      created_at: new Date().toISOString()
    })
  });

  if (response.status === 401) {
    await globalThis.FrictionExt.clearAuthToken();
    return { ok: false, error: 'auth_expired' };
  }

  if (!response.ok) return { ok: false, error: 'save_failed' };

  return { ok: true };
}

export async function generateReport() {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { ok: false, error: 'missing_token' };

  const response = await globalThis.FrictionExt.fetchWithAuth(`${getApiBase()}/api/snapshots/run`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger_type: 'manual' })
  });

  if (response.status === 401) {
    await globalThis.FrictionExt.clearAuthToken();
    return { ok: false, error: 'auth_expired' };
  }

  return { ok: response.ok };
}

export async function loadFindings(state) {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { ok: false, error: 'missing_token' };

  try {
    const response = await fetch(`${getApiBase()}/api/findings?state=${state}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) {
      await globalThis.FrictionExt.clearAuthToken();
      return { ok: false, error: 'auth_expired' };
    }

    const data = await response.json();
    return { ok: true, findings: data.findings || [] };
  } catch (err) {
    return { ok: false, error: 'load_failed' };
  }
}

export async function updateFinding(id, action) {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { ok: false, error: 'missing_token' };

  const map = {
    confirm: { method: 'POST', path: `/api/findings/${id}/confirm` },
    defer: { method: 'POST', path: `/api/findings/${id}/defer` },
    resolve: { method: 'POST', path: `/api/findings/${id}/resolve` }
  };

  const payload = map[action];
  if (!payload) return { ok: false, error: 'invalid_action' };

  try {
    const response = await fetch(`${getApiBase()}${payload.path}`, {
      method: payload.method,
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) {
      await globalThis.FrictionExt.clearAuthToken();
      return { ok: false, error: 'auth_expired' };
    }

    return { ok: response.ok };
  } catch (err) {
    return { ok: false, error: 'update_failed' };
  }
}

export async function checkConnection() {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { status: 'disconnected' };

  try {
    const response = await fetch(`${getApiBase()}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) {
      await globalThis.FrictionExt.clearAuthToken();
      return { status: 'invalid_token' };
    }

    return { status: 'connected' };
  } catch (err) {
    return { status: 'disconnected' };
  }
}

export async function loadMomentCount() {
  if (!globalThis.FrictionExt) throw new Error('FrictionExt not available');

  const token = await globalThis.FrictionExt.getAuthToken();
  if (!token) return { count: 0 };

  try {
    const response = await fetch(`${getApiBase()}/api/moments`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return { count: 0 };

    const moments = await response.json();

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    let count = 0;
    for (const m of moments) {
      const created = new Date(m.created_at);
      if (!Number.isNaN(created.getTime()) && created >= todayStart) {
        count++;
      }
    }

    return { count };
  } catch (err) {
    return { count: 0 };
  }
}

// Takt backend API client.
//
// All requests carry the user's GitHub PAT as a Bearer token; the server uses
// it both to authenticate the user and to verify org membership. The PAT
// itself is never sent anywhere except the configured backend URL and
// api.github.com (the latter only by the existing github-api.js module).

const DEFAULT_BACKEND_URL = 'http://localhost:8000';

export async function getBackendConfig() {
  const { settings } = await chrome.storage.local.get('settings');
  const backendUrl = (settings?.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  return { backendUrl, pat: settings?.pat || null };
}

class TaktApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, { body, signal } = {}) {
  const { backendUrl, pat } = await getBackendConfig();
  if (!pat) throw new TaktApiError(0, 'no_pat', 'No PAT configured');

  const resp = await fetch(`${backendUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  // 204 No Content
  if (resp.status === 204) return null;

  let json = null;
  try {
    json = await resp.json();
  } catch {
    // non-JSON response
  }

  if (!resp.ok) {
    const detail = json?.detail || {};
    throw new TaktApiError(
      resp.status,
      detail.code || 'http_error',
      detail.message || `HTTP ${resp.status}`
    );
  }

  return json;
}

// --- Public surface ---

export async function getMe() {
  return request('GET', '/v1/me');
}

export async function pushSession(session) {
  return request('POST', '/v1/sessions', { body: session });
}

export async function listSessions(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, v);
  }
  const path = `/v1/sessions${qs.toString() ? `?${qs}` : ''}`;
  return request('GET', path);
}

export async function deleteSession(sessionId) {
  return request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`);
}

export async function updateSession(sessionId, patch) {
  // patch: { duration_ms?: number, issue_title?: string }
  return request('PUT', `/v1/sessions/${encodeURIComponent(sessionId)}`, { body: patch });
}

export async function getOrgConfig() {
  return request('GET', '/v1/config');
}

// Health/ping helper for status pip
export async function ping() {
  try {
    const me = await getMe();
    return { ok: true, me };
  } catch (err) {
    return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
  }
}

export { TaktApiError };

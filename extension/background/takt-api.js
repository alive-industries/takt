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
  return {
    backendUrl,
    pat: settings?.pat || null,
    apiKey: settings?.apiKey || null,
  };
}

class TaktApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, { body, signal } = {}) {
  const { backendUrl, pat, apiKey } = await getBackendConfig();
  if (!pat) throw new TaktApiError(0, 'no_pat', 'No PAT configured');

  const resp = await fetch(`${backendUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      ...(apiKey ? { 'X-Takt-Api-Key': apiKey } : {}),
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
  // Keep this as a single idempotent create attempt. The caller owns durable
  // retry/queue semantics, keyed by session_id; retrying a modified payload
  // here could silently drop planned context or member attribution fields.
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

// Authoritative total for a (repo, issue) across all non-deleted sessions
// and all users. Used to overwrite the GitHub Projects field after every
// mutation so edits and deletes also propagate (the old additive sync only
// handled fresh STOPs correctly).
export async function getSessionTotals(repo, issueNumber) {
  const qs = new URLSearchParams({ repo, issue: String(issueNumber) });
  return request('GET', `/v1/sessions/totals?${qs}`);
}

export async function updateSession(sessionId, patch) {
  // patch: { duration_ms?: number, issue_title?: string }
  return request('PUT', `/v1/sessions/${encodeURIComponent(sessionId)}`, { body: patch });
}

export async function getOrgConfig() {
  return request('GET', '/v1/config');
}

// --- Admin endpoints (server enforces role=admin) ---

export async function listMembers() {
  return request('GET', '/v1/members');
}

export async function upsertMember(member) {
  // member: { github_login, role?, status? }
  return request('POST', '/v1/members', { body: member });
}

export async function putOrgConfig(config) {
  // config: { default_field_name?, project_fields?, excluded_projects? }
  return request('PUT', '/v1/config', { body: config });
}

// --- Clients and repository mappings ---

export async function listClients() {
  return request('GET', '/v1/clients');
}

export async function createClient(client) {
  return request('POST', '/v1/clients', { body: client });
}

export async function mapClientProject(clientId, project) {
  return request('POST', `/v1/clients/${encodeURIComponent(clientId)}/projects`, {
    body: project,
  });
}

export async function mapProjectRepository(clientId, projectId, repo) {
  return request(
    'POST',
    `/v1/clients/${encodeURIComponent(clientId)}/projects/${encodeURIComponent(projectId)}/repositories`,
    { body: { repo } }
  );
}

// --- Projects lookup table ---

export async function getProjects() {
  return request('GET', '/v1/projects');
}

// Batch upsert project rows (id + current title) into the lookup table.
// Called on STOP so the backend always has the current project name; a
// rename is a single-row update in the projects table and every session
// referencing the id reflects the new name.
export async function syncProjects(projects) {
  // projects: [{ project_id, title, org? }]
  return request('POST', '/v1/projects/sync', { body: { projects } });
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

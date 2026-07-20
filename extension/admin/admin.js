// Takt admin page — gated on /v1/me reporting role=admin.
//
// All backend calls go through the service worker so the PAT and backend URL
// stay in one place. The admin.html UI is intentionally simple — there is no
// per-row delete; we set status=revoked instead so the audit trail stays.

(() => {
  'use strict';

  const gateEl = document.getElementById('gate');
  const membersCard = document.getElementById('members-card');
  const configCard = document.getElementById('config-card');
  const clientsCard = document.getElementById('clients-card');
  const newClientName = document.getElementById('new-client-name');
  const btnAddClient = document.getElementById('btn-add-client');
  const mapClient = document.getElementById('map-client');
  const mapProject = document.getElementById('map-project');
  const btnMapProject = document.getElementById('btn-map-project');
  const mapProjectRepo = document.getElementById('map-project-repo');
  const mapRepo = document.getElementById('map-repo');
  const btnMapRepo = document.getElementById('btn-map-repo');
  const clientStatus = document.getElementById('client-status');
  const clientsTbody = document.getElementById('clients-tbody');
  const orgLabel = document.getElementById('org-label');

  const newLoginInput = document.getElementById('new-login');
  const newRoleSelect = document.getElementById('new-role');
  const btnAdd = document.getElementById('btn-add');
  const addStatus = document.getElementById('add-status');
  const tbody = document.getElementById('members-tbody');
  const memberModal = document.getElementById('member-modal');
  const memberModalLogin = document.getElementById('member-modal-login');
  const memberModalRole = document.getElementById('member-modal-role');
  const memberModalStatus = document.getElementById('member-modal-status');
  const memberModalSave = document.getElementById('member-modal-save');
  let editingMember = null;

  const defaultFieldInput = document.getElementById('default-field-input');
  const excludedListEl = document.getElementById('excluded-projects-list');
  const projectsMetaEl = document.getElementById('projects-meta');
  const btnSaveConfig = document.getElementById('btn-save-config');
  const btnRefreshConfig = document.getElementById('btn-refresh-config');
  const configStatus = document.getElementById('config-status');

  const backLink = document.getElementById('back-link');
  backLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.top.location.href = chrome.runtime.getURL('dashboard/dashboard.html#settings');
  });

  function send(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  function showStatus(el, text, type) {
    el.textContent = text;
    el.className = type ? `status status--${type}` : 'status';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString();
    } catch {
      return '—';
    }
  }

  // --- Gate ---

  async function checkAccess() {
    const ping = await send('BACKEND_PING');
    if (!ping?.ok) {
      gateEl.classList.add('visible');
      gateEl.textContent = `Backend unreachable: ${ping?.error?.message || 'unknown error'}. Configure your PAT in Settings.`;
      return false;
    }
    const me = ping.me || {};
    if (me.role !== 'admin') {
      gateEl.classList.add('visible');
      gateEl.textContent = `Access denied. You are signed in as ${me.login} (role: ${me.role}). Only admins can view this page.`;
      return false;
    }
    return true;
  }

  // --- Members ---

  function renderMembers(members) {
    tbody.innerHTML = '';
    if (!members.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No members yet.</td></tr>';
      return;
    }
    for (const m of members) {
      const tr = document.createElement('tr');
      tr.dataset.login = m.github_login;
      const roleBadge = `<span class="badge badge--${m.role}">${m.role}</span>`;
      const statusBadge = `<span class="badge badge--${m.status}">${m.status}</span>`;
      const sourceBadge = `<span class="badge badge--${m.source === 'org' ? 'org' : 'manual'}">${m.source}</span>`;
      tr.innerHTML = `
        <td><strong title="${escapeHtml(m.github_login)}">${escapeHtml(m.github_login)}</strong></td>
        <td>${roleBadge}</td>
        <td>${statusBadge}</td>
        <td>${sourceBadge}</td>
        <td class="muted">${fmtDate(m.added_at)}</td>
        <td class="actions-cell"><div class="member-actions">
          <button class="btn btn--secondary" data-act="edit">Edit</button>
        </div></td>
      `;
      tbody.appendChild(tr);
    }
  }

  function closeMemberModal() {
    editingMember = null;
    memberModal.hidden = true;
  }

  tbody.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act="edit"]');
    if (!btn) return;
    const login = btn.closest('tr').dataset.login;
    editingMember = currentMembers.find((member) => member.github_login === login) || null;
    if (!editingMember) return;
    memberModalLogin.textContent = editingMember.github_login;
    memberModalRole.value = editingMember.role;
    memberModalStatus.value = editingMember.status;
    memberModal.hidden = false;
    memberModalRole.focus();
  });

  document.getElementById('member-modal-cancel').addEventListener('click', closeMemberModal);
  memberModal.addEventListener('click', (event) => {
    if (event.target === memberModal) closeMemberModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !memberModal.hidden) closeMemberModal();
  });
  memberModalSave.addEventListener('click', async () => {
    if (!editingMember) return;
    memberModalSave.disabled = true;
    const resp = await send('ADMIN_UPSERT_MEMBER', {
      github_login: editingMember.github_login,
      role: memberModalRole.value,
      status: memberModalStatus.value,
    });
    memberModalSave.disabled = false;
    if (!resp?.ok) {
      alert(`Update failed: ${resp?.error?.message || 'unknown error'}`);
      return;
    }
    closeMemberModal();
    await loadMembers();
  });

  let currentMembers = [];

  async function loadMembers() {
    showStatus(addStatus, 'loading…', 'loading');
    const resp = await send('ADMIN_LIST_MEMBERS');
    if (!resp?.ok) {
      showStatus(addStatus, `Error: ${resp?.error?.message || 'failed'}`, 'error');
      return;
    }
    currentMembers = resp.members || [];
    renderMembers(currentMembers);
    showStatus(addStatus, '', '');
  }

  btnAdd.addEventListener('click', async () => {
    const login = newLoginInput.value.trim();
    if (!login) {
      showStatus(addStatus, 'Enter a github login', 'error');
      return;
    }
    btnAdd.disabled = true;
    showStatus(addStatus, 'saving…', 'loading');
    const resp = await send('ADMIN_UPSERT_MEMBER', {
      github_login: login,
      role: newRoleSelect.value,
      status: 'active',
    });
    if (resp?.ok) {
      newLoginInput.value = '';
      showStatus(addStatus, 'Saved', 'success');
      await loadMembers();
    } else {
      showStatus(addStatus, `Error: ${resp?.error?.message || 'failed'}`, 'error');
    }
    btnAdd.disabled = false;
  });

  // --- Clients ---

  let adminClients = [];
  let githubProjects = [];

  function renderClientMappings() {
    mapClient.innerHTML = adminClients
      .map((client) => `<option value="${client.client_id}">${escapeHtml(client.name)}</option>`)
      .join('');
    const mappedProjects = adminClients.flatMap((client) =>
      (client.projects || []).map((project) => ({ ...project, clientId: client.client_id }))
    );
    mapProjectRepo.innerHTML = '<option value="">Select mapped project…</option>' +
      mappedProjects.map((project) =>
        `<option value="${project.clientId}|${escapeHtml(project.project_id)}">${escapeHtml(project.title)}</option>`
      ).join('');
    clientsTbody.innerHTML = adminClients.map((client) => {
      const projects = (client.projects || []).map((project) =>
        `<div><strong>${escapeHtml(project.title)}</strong><div class="muted">${escapeHtml((project.repositories || []).join(', ') || 'No repositories')}</div></div>`
      ).join('') || '—';
      return `<tr><td><strong>${escapeHtml(client.name)}</strong></td><td>${projects}</td></tr>`;
    }).join('');
  }

  async function loadClients() {
    const resp = await send('LIST_CLIENTS');
    if (!resp?.ok) {
      showStatus(clientStatus, resp?.error?.message || 'Failed to load clients', 'error');
      return;
    }
    adminClients = resp.clients || [];
    renderClientMappings();
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat) return;
    const projectsResp = await send('FETCH_ALL_PROJECTS', { pat: settings.pat });
    githubProjects = projectsResp?.projects || [];
    mapProject.innerHTML = '<option value="">Select GitHub project…</option>' +
      githubProjects.map((project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}${project.org ? ` · ${escapeHtml(project.org)}` : ''}</option>`
      ).join('');
  }

  btnAddClient.addEventListener('click', async () => {
    const name = newClientName.value.trim();
    if (!name) return;
    const resp = await send('ADMIN_CREATE_CLIENT', { name });
    if (!resp?.ok) {
      showStatus(clientStatus, resp?.error?.message || 'Failed to create client', 'error');
      return;
    }
    newClientName.value = '';
    showStatus(clientStatus, 'Client saved', 'success');
    await loadClients();
  });

  btnMapProject.addEventListener('click', async () => {
    const clientId = Number(mapClient.value);
    const project = githubProjects.find((item) => item.id === mapProject.value);
    if (!clientId || !project) return;
    const resp = await send('ADMIN_MAP_CLIENT_PROJECT', {
      clientId,
      project: { project_id: project.id, title: project.title, org: project.org || null },
    });
    if (!resp?.ok) {
      showStatus(clientStatus, resp?.error?.message || 'Failed to map project', 'error');
      return;
    }
    showStatus(clientStatus, 'Project mapped to client', 'success');
    await loadClients();
  });

  mapProjectRepo.addEventListener('change', async () => {
    const [, projectId] = mapProjectRepo.value.split('|');
    if (!projectId) return;
    mapRepo.innerHTML = '<option value="">Loading repositories…</option>';
    const resp = await send('FETCH_PROJECT_REPOS', { projectId });
    mapRepo.innerHTML = '<option value="">Select GitHub repository…</option>' +
      (resp?.repos || []).map((repo) => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('');
  });

  btnMapRepo.addEventListener('click', async () => {
    const [clientId, projectId] = mapProjectRepo.value.split('|');
    const repo = mapRepo.value;
    if (!clientId || !projectId || !repo) return;
    const resp = await send('ADMIN_MAP_PROJECT_REPO', {
      clientId: Number(clientId), projectId, repo,
    });
    if (!resp?.ok) {
      showStatus(clientStatus, resp?.error?.message || 'Failed to map repository', 'error');
      return;
    }
    showStatus(clientStatus, 'Repository mapped to project', 'success');
    await loadClients();
  });

  // --- Org config ---

  // Cached so Save can rebuild the excluded list (keyed by stable project id)
  // even if the user hasn't fetched fresh project data this session.
  let orgProjects = []; // [{ id, title, org }]
  let backendConfig = null;

  function renderExcludedList() {
    const excluded = new Set(backendConfig?.excluded_projects || []);

    // If we have no project data, show a hint but still render any
    // already-excluded titles as toggleable rows so admins can un-exclude.
    if (orgProjects.length === 0 && excluded.size === 0) {
      excludedListEl.innerHTML =
        '<div class="muted" style="padding:10px;">No org projects found. Make sure your PAT has the <code>project</code> and <code>read:org</code> scopes.</div>';
      return;
    }

    // Exclusions are stored by stable project node id (rename-proof). Legacy
    // configs stored titles, so match on either. Anything in `excluded` that
    // matches neither a live id nor a live title is a true orphan (archived
    // project, or a title left behind by a rename) and is shown separately.
    const knownIds = new Set(orgProjects.map((p) => p.id));
    const knownTitles = new Set(orgProjects.map((p) => p.title));
    const orphanExcluded = [...excluded].filter(
      (e) => !knownIds.has(e) && !knownTitles.has(e)
    );

    const rows = [];
    for (const p of orgProjects) {
      const checked = excluded.has(p.id) || excluded.has(p.title) ? 'checked' : '';
      rows.push(`
        <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #eaeef2;cursor:pointer;">
          <input type="checkbox" class="excl-cb" data-id="${escapeHtml(p.id)}" ${checked}>
          <span style="flex:1;">${escapeHtml(p.title)}</span>
          <span class="muted" style="font-size:11px;">${escapeHtml(p.org || '')}</span>
        </label>
      `);
    }
    for (const t of orphanExcluded) {
      rows.push(`
        <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #eaeef2;cursor:pointer;opacity:0.7;">
          <input type="checkbox" class="excl-cb" data-id="${escapeHtml(t)}" checked>
          <span style="flex:1;">${escapeHtml(t)}</span>
          <span class="muted" style="font-size:11px;">not currently visible</span>
        </label>
      `);
    }
    excludedListEl.innerHTML = rows.join('');
  }

  async function loadOrgProjects() {
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings?.pat) {
      projectsMetaEl.textContent = 'No PAT configured.';
      return;
    }
    projectsMetaEl.textContent = 'fetching from GitHub…';
    const resp = await send('FETCH_ALL_PROJECTS', { pat: settings.pat });
    if (!resp?.ok) {
      projectsMetaEl.textContent = `error: ${resp?.error || 'failed'}`;
      return;
    }
    // Only org-scoped projects (fetchAllProjects already excludes personal).
    orgProjects = (resp.projects || [])
      .filter((p) => p.org)
      .sort((a, b) => a.title.localeCompare(b.title));
    projectsMetaEl.textContent = `${orgProjects.length} project(s) across ${resp.orgs?.length || 0} org(s).`;
    renderExcludedList();
  }

  async function loadBackendConfig() {
    const resp = await send('ADMIN_GET_ORG_CONFIG');
    if (!resp?.ok) {
      showStatus(configStatus, `Error loading config: ${resp?.error?.message || 'unknown'}`, 'error');
      return null;
    }
    backendConfig = resp.config || {};
    if (backendConfig.org_login) orgLabel.textContent = backendConfig.org_login;
    defaultFieldInput.value = backendConfig.default_field_name || '';
    renderExcludedList();
    return backendConfig;
  }

  btnSaveConfig.addEventListener('click', async () => {
    btnSaveConfig.disabled = true;
    showStatus(configStatus, 'saving…', 'loading');

    const excluded = [...excludedListEl.querySelectorAll('.excl-cb')]
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.id);

    const payload = {
      default_field_name: defaultFieldInput.value.trim() || null,
      excluded_projects: excluded,
    };

    const resp = await send('ADMIN_PUT_ORG_CONFIG', payload);
    if (resp?.ok) {
      backendConfig = resp.config;
      showStatus(configStatus, 'Saved', 'success');
      renderExcludedList();
    } else {
      showStatus(configStatus, `Error: ${resp?.error?.message || 'failed'}`, 'error');
    }
    btnSaveConfig.disabled = false;
  });

  btnRefreshConfig.addEventListener('click', async () => {
    btnRefreshConfig.disabled = true;
    showStatus(configStatus, 'refreshing…', 'loading');
    await loadBackendConfig();
    showStatus(configStatus, '', '');
    btnRefreshConfig.disabled = false;
  });

  // --- Init ---

  (async () => {
    const ok = await checkAccess();
    if (!ok) return;
    membersCard.style.display = '';
    clientsCard.style.display = 'none';
    configCard.style.display = '';
    await Promise.all([
      loadMembers(),
      loadBackendConfig(),
      loadOrgProjects(),
    ]);
  })();
})();

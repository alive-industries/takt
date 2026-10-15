// Takt admin view — gated on /v1/me reporting role=admin.
//
// All backend calls go through the service worker so the PAT and backend URL
// stay in one place. The admin UI is intentionally simple — there is no
// per-row delete; we set status=revoked instead so the audit trail stays.

(() => {
  'use strict';

  const gateEl = document.getElementById('gate');
  const membersCard = document.getElementById('members-card');
  const configCard = document.getElementById('config-card');
  const orgLabel = document.getElementById('org-label');

  const newLoginInput = document.getElementById('new-login');
  const newRoleSelect = document.getElementById('new-role');
  const btnAdd = document.getElementById('btn-add-member');
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
  const escapeHtml = self.TaktUI.escapeHtml;
  const showStatus = (element, text, type) => {
    const statusType = { success: 'ok', loading: 'warn' }[type] || type;
    self.TaktUI.showStatus(element, text, statusType, 'status');
  };

  function send(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  // --- Gate ---

  async function checkAccess() {
    const ping = await send('BACKEND_PING');
    if (!ping?.ok) {
      gateEl.hidden = false;
      gateEl.textContent = `Backend unreachable: ${ping?.error?.message || 'unknown error'}. Configure your PAT in Settings.`;
      return false;
    }
    const me = ping.me || {};
    if (me.role !== 'admin') {
      gateEl.hidden = false;
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
      const roleBadge = `<span class="chip chip--${m.role === 'admin' ? 'info' : 'muted'}">${m.role}</span>`;
      const statusTone = { active: 'ok', pending: 'warn', revoked: 'error' }[m.status] || 'muted';
      const statusBadge = `<span class="chip chip--${statusTone}">${m.status}</span>`;
      const sourceBadge = `<span class="chip chip--${m.source === 'org' ? 'info' : 'muted'}">${m.source}</span>`;
      tr.innerHTML = `
        <td><strong title="${escapeHtml(m.github_login)}">${escapeHtml(m.github_login)}</strong></td>
        <td>${roleBadge}</td>
        <td>${statusBadge}</td>
        <td>${sourceBadge}</td>
        <td class="muted">${self.TaktUI.formatDate(m.added_at)}</td>
        <td class="actions-cell"><div class="member-actions">
          <button class="btn" data-act="edit">Edit</button>
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
        '<div class="muted">No org projects found. Make sure your PAT has the <code>project</code> and <code>read:org</code> scopes.</div>';
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
        <label class="field field--inline">
          <input type="checkbox" class="excl-cb" data-id="${escapeHtml(p.id)}" ${checked}>
          <span>${escapeHtml(p.title)}</span>
          <span class="muted">${escapeHtml(p.org || '')}</span>
        </label>
      `);
    }
    for (const t of orphanExcluded) {
      rows.push(`
        <label class="field field--inline">
          <input type="checkbox" class="excl-cb" data-id="${escapeHtml(t)}" checked>
          <span>${escapeHtml(t)}</span>
          <span class="muted">not currently visible</span>
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
    membersCard.hidden = false;
    configCard.hidden = false;
    await Promise.all([
      loadMembers(),
      loadBackendConfig(),
      loadOrgProjects(),
    ]);
  })();
})();

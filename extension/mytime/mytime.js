(() => {
  'use strict';

  const sessionsBody = document.getElementById('sessions-body');
  const filterRepo = document.getElementById('filter-repo');
  const filterFrom = document.getElementById('filter-from');
  const filterTo = document.getElementById('filter-to');
  const summaryCount = document.getElementById('summary-count');
  const summaryHours = document.getElementById('summary-hours');
  const btnExport = document.getElementById('btn-export');
  const sourcePip = document.getElementById('source-pip');
  const sourcePipText = document.getElementById('source-pip-text');

  /**
   * Sessions in the table come from chrome.storage.local.sessionCache.
   * The cache is populated by the service worker (via the local-store
   * module) on STOP, on edits, and on background reconciliation against
   * the backend. We never read directly from the backend in this view —
   * the service worker does the LIST_BACKEND_SESSIONS round-trip and
   * merges into the cache, then the cache is the source of truth here.
   *
   * Each session record has: sessionId, repo, issueNumber, issueTitle,
   * issueUrl, sourceUrl, startedAt, completedAt, durationMs, durationHours,
   * syncedToProject, projectTitles, taktVersion, syncStatus, syncedAt.
   */
  let allSessions = [];
  // Whether the active filter range is fully covered by the local cache
  // (last 30 days). Used to decide if we can serve from cache or have to
  // wait for the backend.
  const RETENTION_DAYS = 30;

  // --- Helpers ---

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  // Time parsing/formatting comes from the shared lib (../lib/time-format.js).
  // Same digit-buffer UX as the on-issue timer editor: type digits, last 2
  // become seconds, next 2 become minutes, the rest are hours. So `3000`
  // means 00:30:00.

  function toHours(ms) {
    return Math.round((ms / 3600000) * 4) / 4;
  }

  function formatDate(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateISO(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  function sendMessage(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // Sync state icon. 'pending' = STOP not yet pushed; 'dirty' = edit
  // not yet pushed; 'synced' = matches BigQuery; 'error' = last push
  // failed (set transiently by the edit handler).
  function syncBadgeHtml(status) {
    if (status === 'synced' || !status) {
      return '<span class="sync-badge sync-badge--synced" title="Synced to BigQuery">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
        '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>' +
        '</svg></span>';
    }
    if (status === 'error') {
      return '<span class="sync-badge sync-badge--error" title="Sync failed">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
        '<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>' +
        '</svg></span>';
    }
    // 'pending' or 'dirty' — animated spinner
    const title = status === 'dirty' ? 'Edit syncing…' : 'Push syncing…';
    return `<span class="sync-badge" title="${title}"><span class="sync-spinner"></span></span>`;
  }

  function startOfThisMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function endOfThisMonth() {
    const d = new Date();
    // Last day of current month: day 0 of next month.
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  // --- Source pip ---

  function setSourcePip(kind, text) {
    sourcePip.className = `source-pip source-pip--${kind}`;
    sourcePipText.textContent = text;
  }

  // --- Loading sessions: local-first stale-while-revalidate ---

  function activeRange() {
    const from = filterFrom.value || formatDateISO(startOfThisMonth());
    const to = filterTo.value || formatDateISO(endOfThisMonth());
    return { from, to };
  }

  function rangeFullyInCache(from) {
    // Cache holds last RETENTION_DAYS. If the filter "from" is older than
    // that, we can't serve fully from cache — must hit backend.
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const fromMs = new Date(from).getTime();
    return fromMs >= cutoff;
  }

  // Read from the local cache only — synchronous (well, single message
  // round-trip to the SW, but no network). Updates `allSessions` in place.
  async function loadFromCache() {
    const { from, to } = activeRange();
    const resp = await sendMessage('LIST_LOCAL_SESSIONS', {
      from: `${from}T00:00:00Z`,
      to: `${to}T23:59:59Z`,
    });
    allSessions = resp?.sessions || [];
    return resp;
  }

  // Background revalidate: tell the SW to fetch from the backend and
  // reconcile. After it finishes we re-read from cache (which now reflects
  // the merged state) and re-render.
  //
  // When `outOfCache` is true the requested window extends beyond the local
  // cache's 30-day retention. In that case the SW's reconcileWindow would
  // immediately prune the older rows it just fetched, so we render directly
  // from the response payload instead of going through the cache.
  async function revalidateFromBackend({ outOfCache = false } = {}) {
    const { from, to } = activeRange();
    const params = {
      from: `${from}T00:00:00Z`,
      to: `${to}T23:59:59Z`,
      skipReconcile: outOfCache,
    };
    const resp = await sendMessage('LIST_BACKEND_SESSIONS', params);
    if (!resp?.ok) {
      const code = resp?.error?.code || 'error';
      const msg = resp?.error?.message || 'unreachable';
      // Keep showing the cache; just flag the staleness.
      setSourcePip('error', `offline (${code})`);
      return false;
    }
    if (outOfCache) {
      // Use the response records directly — they're already normalised by
      // the SW (cache.fromBackendSession). The recent-cache subset would
      // re-prune them on save.
      allSessions = resp.records || [];
    } else {
      // Re-pull from cache so we pick up the reconciled set, then re-render.
      await loadFromCache();
    }
    populateFilters();
    render();
    setSourcePip('backend', `${allSessions.length} synced`);
    return true;
  }

  // --- Render ---

  // Apply the repo filter (date/range filtering already happened on the
  // cache lookup). Returns the array used by both the table and the CSV.
  function getVisibleSessions() {
    const repo = filterRepo.value;
    return repo ? allSessions.filter((s) => s.repo === repo) : allSessions;
  }

  // True only for repo values that look like a real GitHub `owner/name`
  // slug — manual entries can use freeform labels like "client meeting",
  // and those shouldn't render as broken GitHub links.
  function isGithubRepo(repo) {
    return /^[^/\s]+\/[^/\s]+$/.test(repo || '');
  }

  function render() {
    const sessions = getVisibleSessions();

    summaryCount.textContent = sessions.length;
    const totalMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    summaryHours.textContent = toHours(totalMs).toFixed(2);

    if (sessions.length === 0) {
      sessionsBody.innerHTML =
        '<tr><td colspan="7" class="empty-state">No time entries found.</td></tr>';
      return;
    }

    sessionsBody.innerHTML = sessions
      .map((s) => {
        const editable = !!s.sessionId;
        const editableClass = editable ? ' duration-editable' : '';
        const editTitle = editable ? ' title="Click to edit"' : '';
        const repoIsGh = isGithubRepo(s.repo);
        const repoCell = repoIsGh
          ? `<a href="https://github.com/${escapeHtml(s.repo)}" target="_blank">${escapeHtml(s.repo)}</a>`
          : escapeHtml(s.repo);
        const issueInner = `#${s.issueNumber} ${escapeHtml(s.issueTitle || '')}`;
        const issueCell = repoIsGh
          ? `<a href="https://github.com/${escapeHtml(s.repo)}/issues/${s.issueNumber}" target="_blank">${issueInner}</a>`
          : escapeHtml(s.issueTitle || `#${s.issueNumber}`);
        return `
          <tr data-sid="${escapeHtml(s.sessionId || '')}">
            <td class="muted">${formatDate(s.completedAt)}</td>
            <td>${repoCell}</td>
            <td>${issueCell}</td>
            <td class="mono${editableClass}" data-col="duration"${editTitle}>${formatDuration(s.durationMs)}</td>
            <td class="mono">${toHours(s.durationMs).toFixed(2)}</td>
            <td class="td-sync">${syncBadgeHtml(s.syncStatus)}</td>
            <td class="td-actions">
              <button class="btn btn--danger btn--sm btn-delete" title="Remove entry">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>
              </button>
            </td>
          </tr>`;
      })
      .join('');

    // Wire delete buttons
    sessionsBody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tr = e.currentTarget.closest('tr');
        deleteRow(tr);
      });
    });

    // Wire inline duration edit (backend-only, where we have a sessionId)
    sessionsBody.querySelectorAll('.duration-editable').forEach((td) => {
      td.addEventListener('click', () => startDurationEdit(td));
    });
  }

  // --- Inline duration edit ---

  function startDurationEdit(td) {
    if (td.querySelector('.edit-input')) return; // already editing
    const tr = td.closest('tr');
    const sessionId = tr.dataset.sid;
    if (!sessionId) return;
    // Find the original ms via in-memory state (more reliable than re-parsing
    // the cell text and survives the row's eventual re-render).
    const session = allSessions.find((x) => x.sessionId === sessionId);
    if (!session) return;
    const originalMs = session.durationMs;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.placeholder = 'HH:MM:SS';
    input.title = 'Type digits — last 2 = seconds, next 2 = minutes (e.g. 3000 = 30 min)';
    td.textContent = '';
    td.appendChild(input);

    // Same digit-buffer behaviour as the on-issue editor.
    const handle = self.TaktTime.bindTimeInput(input, { initialMs: originalMs });
    input.focus();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newMs = handle.getMs();
      if (newMs === null || newMs === originalMs) {
        // Invalid input or no change — revert quietly.
        td.textContent = self.TaktTime.formatMs(originalMs);
        return;
      }
      // Optimistic UI: show the new time immediately and flip the row's
      // sync badge to a spinner. The cache is updated by the service
      // worker (UPDATE_BACKEND_SESSION) before the network call; we
      // mirror that here in the in-memory `allSessions` so a full render
      // reflects the same state without waiting for the round trip.
      session.durationMs = newMs;
      session.durationHours = Math.round((newMs / 3_600_000) * 4) / 4;
      session.syncStatus = 'dirty';
      render();

      const resp = await sendMessage('UPDATE_BACKEND_SESSION', {
        sessionId,
        patch: { duration_ms: newMs },
      });
      if (resp?.ok) {
        // Authoritative values from the server (in case rounding differs).
        session.durationMs = resp.session.duration_ms;
        session.durationHours = resp.session.duration_hours;
        session.syncStatus = 'synced';
        render();
      } else {
        // Revert in memory + show error icon on the row. The SW already
        // restored the cache for us.
        session.durationMs = originalMs;
        session.durationHours = Math.round((originalMs / 3_600_000) * 4) / 4;
        session.syncStatus = 'error';
        render();
        const msg = resp?.error?.message || 'edit failed';
        setSourcePip('error', msg);
      }
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      td.textContent = self.TaktTime.formatMs(originalMs);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // --- Delete ---

  async function deleteRow(tr) {
    const sessionId = tr.dataset.sid;
    if (!sessionId) return;
    // Optimistic remove for instant feedback; SW does optimistic cache
    // remove and will restore on backend failure. We refresh from cache
    // to get the canonical state regardless.
    allSessions = allSessions.filter((s) => s.sessionId !== sessionId);
    render();
    const resp = await sendMessage('DELETE_BACKEND_SESSION', { sessionId });
    if (!resp?.ok) {
      setSourcePip('error', resp?.error?.message || 'delete failed');
      // Re-pull from cache (SW restored the row on failure).
      await loadFromCache();
      render();
    }
  }

  // --- Export CSV ---

  function exportCsv() {
    const sessions = getVisibleSessions();
    if (sessions.length === 0) return;

    const escCsv = (v) => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = ['Date', 'Repo', 'Issue #', 'Issue Title', 'Duration', 'Hours'];
    const rows = sessions.map((s) => [
      formatDateISO(s.completedAt),
      s.repo,
      s.issueNumber,
      s.issueTitle || '',
      formatDuration(s.durationMs),
      toHours(s.durationMs).toFixed(2),
    ]);

    const totalHours = sessions.reduce((sum, s) => sum + toHours(s.durationMs), 0);
    rows.push(['Total', '', '', '', '', totalHours.toFixed(2)]);

    const csv = [headers, ...rows].map((r) => r.map(escCsv).join(',')).join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `takt-time-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Init ---

  function populateFilters() {
    const repos = [...new Set(allSessions.map((s) => s.repo))].sort();
    const prev = filterRepo.value;
    filterRepo.innerHTML = '<option value="">All repos</option>';
    for (const r of repos) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      filterRepo.appendChild(opt);
    }
    if (prev && repos.includes(prev)) filterRepo.value = prev;
  }

  function setDefaultDateRange() {
    if (!filterFrom.value) filterFrom.value = formatDateISO(startOfThisMonth());
    if (!filterTo.value) filterTo.value = formatDateISO(endOfThisMonth());
  }

  // Stale-while-revalidate. Render from cache first (instant), then kick
  // off the backend revalidate which mutates the cache and re-renders.
  async function refresh() {
    const { from } = activeRange();
    const inCache = rangeFullyInCache(from);

    if (inCache) {
      // 1) Synchronous-ish read from cache → instant render.
      await loadFromCache();
      populateFilters();
      render();
      const cachedCount = allSessions.length;
      setSourcePip('backend', cachedCount > 0 ? `${cachedCount} cached, refreshing…` : 'refreshing…');

      // 2) Background revalidate. Re-renders silently when done.
      revalidateFromBackend();
    } else {
      // Range is older than cache retention — go straight to backend and
      // render the response directly (bypassing the cache, which would
      // prune anything outside the 30-day window on the next save).
      setSourcePip('backend', 'fetching from BigQuery…');
      const ok = await revalidateFromBackend({ outOfCache: true });
      if (!ok) {
        // Even fallback empty: still render cache so user sees what we have.
        await loadFromCache();
        populateFilters();
        render();
      }
    }
  }

  async function init() {
    setDefaultDateRange();
    refresh();
    // Kick off a GitHub repo fetch in the background so the Add modal has
    // an up-to-date dropdown when the user opens it. Cached to
    // chrome.storage.local.settings.knownRepos. Fire-and-forget — modal
    // works fine without it (falls back to previously-tracked repos).
    sendMessage('FETCH_USER_REPOS').catch(() => {});
  }

  // Date filter changes -> different range -> refetch + reconcile.
  // Repo filter is purely client-side; just re-render.
  filterRepo.addEventListener('change', render);
  filterFrom.addEventListener('change', refresh);
  filterTo.addEventListener('change', refresh);
  btnExport.addEventListener('click', exportCsv);

  // --- Add-entry modal ---

  const btnAdd = document.getElementById('btn-add');
  const addModal = document.getElementById('add-modal');
  const addRepoInput = document.getElementById('add-repo');
  const addIssueInput = document.getElementById('add-issue');
  const addTitleInput = document.getElementById('add-title');
  const addDateInput = document.getElementById('add-date');
  const addDurationInput = document.getElementById('add-duration');
  const addErrorEl = document.getElementById('add-error');
  const addSubmitBtn = document.getElementById('add-submit');
  const addCancelBtn = document.getElementById('add-cancel');
  const addCloseBtn = document.getElementById('add-close');
  const repoSuggestionsEl = document.getElementById('repo-suggestions');

  // Holds the bindTimeInput handle while the modal is open so we can read
  // the parsed ms on submit and detach cleanly on reopen.
  let addDurationHandle = null;

  async function openAddModal() {
    // Repo dropdown = union of (a) repos seen in previous time entries
    // and (b) repos fetched from GitHub by FETCH_USER_REPOS (cached on
    // settings.knownRepos). Free-text custom labels are allowed too.
    const fromSessions = new Set(allSessions.map((s) => s.repo));
    const { settings = {} } = await chrome.storage.local.get('settings');
    const knownRepos = settings.knownRepos || [];
    const repos = [...new Set([...knownRepos, ...fromSessions])].sort();
    repoSuggestionsEl.innerHTML = repos
      .map((r) => `<option value="${escapeHtml(r)}"></option>`)
      .join('');

    addRepoInput.value = '';
    addIssueInput.value = '';
    addTitleInput.value = '';
    addDateInput.value = formatDateISO(Date.now());
    addErrorEl.textContent = '';

    if (addDurationHandle?.detach) addDurationHandle.detach();
    addDurationInput.value = '';
    addDurationHandle = self.TaktTime.bindTimeInput(addDurationInput, { initialMs: 0 });

    addModal.hidden = false;
    addRepoInput.focus();
  }

  function closeAddModal() {
    addModal.hidden = true;
  }

  function showAddError(msg) {
    addErrorEl.textContent = msg;
  }

  async function submitAddEntry() {
    const repo = addRepoInput.value.trim();
    const issueNumber = parseInt(addIssueInput.value, 10);
    const issueTitle = addTitleInput.value.trim() || null;
    const dateStr = addDateInput.value;
    const durationMs = addDurationHandle?.getMs() ?? null;

    // Accept anything non-empty — could be owner/repo (issue URL/comment
    // will be valid) or a freeform label like "client meeting" / "admin"
    // for non-GitHub work. The repo cell renders as a GitHub link either
    // way; for non-repo labels it'll 404 if clicked, which is the
    // user's choice when they typed it.
    if (!repo) return showAddError('Repo or task name is required.');
    if (!Number.isFinite(issueNumber) || issueNumber < 1) {
      return showAddError('Issue number is required.');
    }
    if (!dateStr) return showAddError('Date is required.');
    if (!durationMs || durationMs <= 0) {
      return showAddError('Duration must be greater than zero.');
    }

    // completed_at = chosen date at 17:00 local. started_at is derived
    // backward from duration in the SW so the row stays internally
    // coherent (and matches what UPDATE recomputes on edit).
    const completedAt = new Date(`${dateStr}T17:00:00`).getTime();
    if (!Number.isFinite(completedAt)) return showAddError('Invalid date.');

    showAddError('');
    addSubmitBtn.disabled = true;
    const resp = await sendMessage('ADD_MANUAL_SESSION', {
      repo, issueNumber, issueTitle, completedAt, durationMs,
    });
    addSubmitBtn.disabled = false;

    if (resp?.ok) {
      closeAddModal();
      await refresh();
    } else {
      showAddError(resp?.error?.message || 'Failed to add entry.');
    }
  }

  btnAdd.addEventListener('click', openAddModal);
  addCancelBtn.addEventListener('click', closeAddModal);
  addCloseBtn.addEventListener('click', closeAddModal);
  addSubmitBtn.addEventListener('click', submitAddEntry);
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) closeAddModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !addModal.hidden) closeAddModal();
  });

  init();
})();

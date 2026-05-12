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
  async function revalidateFromBackend() {
    const { from, to } = activeRange();
    const params = {
      from: `${from}T00:00:00Z`,
      to: `${to}T23:59:59Z`,
    };
    const resp = await sendMessage('LIST_BACKEND_SESSIONS', params);
    if (!resp?.ok) {
      const code = resp?.error?.code || 'error';
      const msg = resp?.error?.message || 'unreachable';
      // Keep showing the cache; just flag the staleness.
      setSourcePip('error', `offline (${code})`);
      return false;
    }
    // Re-pull from cache so we pick up the reconciled set, then re-render.
    await loadFromCache();
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

  function render() {
    const sessions = getVisibleSessions();

    summaryCount.textContent = sessions.length;
    const totalMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    summaryHours.textContent = toHours(totalMs).toFixed(2);

    if (sessions.length === 0) {
      sessionsBody.innerHTML =
        '<tr><td colspan="6" class="empty-state">No time entries found.</td></tr>';
      return;
    }

    sessionsBody.innerHTML = sessions
      .map((s) => {
        // Every cache entry has a sessionId; rows with non-synced state
        // get a hint pip so the user knows their edit is in flight.
        const editable = !!s.sessionId;
        const editableClass = editable ? ' duration-editable' : '';
        const editTitle = editable ? ' title="Click to edit"' : '';
        const statusBadge = s.syncStatus === 'pending'
          ? ' <span title="Push pending" style="color:#9a6700;font-size:11px;">⟳</span>'
          : s.syncStatus === 'dirty'
            ? ' <span title="Edit pending" style="color:#9a6700;font-size:11px;">✎</span>'
            : '';
        return `
          <tr data-sid="${escapeHtml(s.sessionId || '')}">
            <td class="muted">${formatDate(s.completedAt)}${statusBadge}</td>
            <td><a href="https://github.com/${escapeHtml(s.repo)}" target="_blank">${escapeHtml(s.repo)}</a></td>
            <td><a href="https://github.com/${escapeHtml(s.repo)}/issues/${s.issueNumber}" target="_blank">#${s.issueNumber} ${escapeHtml(s.issueTitle || '')}</a></td>
            <td class="mono${editableClass}" data-col="duration"${editTitle}>${formatDuration(s.durationMs)}</td>
            <td class="mono">${toHours(s.durationMs).toFixed(2)}</td>
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
      td.textContent = '…';
      const resp = await sendMessage('UPDATE_BACKEND_SESSION', {
        sessionId,
        patch: { duration_ms: newMs },
      });
      if (resp?.ok) {
        session.durationMs = resp.session.duration_ms;
        render();
      } else {
        td.textContent = self.TaktTime.formatMs(originalMs);
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
      // Range is older than cache retention — go straight to backend.
      setSourcePip('backend', 'fetching from BigQuery…');
      const ok = await revalidateFromBackend();
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
  }

  // Date filter changes -> different range -> refetch + reconcile.
  // Repo filter is purely client-side; just re-render.
  filterRepo.addEventListener('change', render);
  filterFrom.addEventListener('change', refresh);
  filterTo.addEventListener('change', refresh);
  btnExport.addEventListener('click', exportCsv);

  init();
})();

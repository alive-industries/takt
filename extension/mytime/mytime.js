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
        const hasIssue = s.issueNumber > 0;
        const repoCell = repoIsGh
          ? `<a href="https://github.com/${escapeHtml(s.repo)}" target="_blank">${escapeHtml(s.repo)}</a>`
          : escapeHtml(s.repo);
        // issueNumber=0 is the manual-entry "no linked issue" sentinel.
        // Render the title as-is and skip the GitHub link in that case
        // so the table doesn't show a phantom #0 link that would 404.
        let issueCell;
        if (!hasIssue) {
          issueCell = `<span class="muted">${escapeHtml(s.issueTitle || '—')}</span>`;
        } else {
          const issueInner = `#${s.issueNumber} ${escapeHtml(s.issueTitle || '')}`;
          issueCell = repoIsGh
            ? `<a href="https://github.com/${escapeHtml(s.repo)}/issues/${s.issueNumber}" target="_blank">${issueInner}</a>`
            : escapeHtml(s.issueTitle || `#${s.issueNumber}`);
        }
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
    refreshActiveTimer();
    // Kick off a GitHub repo fetch in the background so the Add modal has
    // an up-to-date dropdown when the user opens it. Cached to
    // chrome.storage.local.settings.knownReposByOrg. Fire-and-forget — modal
    // works fine without it (falls back to previously-tracked repos).
    sendMessage('FETCH_USER_REPOS').catch(() => {});
    // Same for the user's org list — populates the new Organization dropdown.
    sendMessage('FETCH_USER_ORGS').catch(() => {});
  }

  // --- Active-timer panel ---
  //
  // Mirrors the popup's live timer: polls GET_STATE, ticks once a second
  // while running, exposes Pause/Resume/Stop. The user no longer has to
  // bounce out to the toolbar popup after clicking "Start tracking" from
  // the Add-entry modal — they can finish the session right here.

  const activeTimerPanel = document.getElementById('active-timer');
  const activeTimerMeta = document.getElementById('active-timer-meta');
  const activeTimerTitle = document.getElementById('active-timer-title');
  const activeTimerClock = document.getElementById('active-timer-clock');
  const activeTimerToggle = document.getElementById('active-timer-toggle');
  const activeTimerStop = document.getElementById('active-timer-stop');
  let activeTimerSession = null;
  let activeTimerInterval = null;

  function computeElapsedMs(s) {
    if (!s) return 0;
    const running = s.status === 'running' ? Date.now() - s.startedAt : 0;
    return (s.accumulatedMs || 0) + running;
  }

  function renderActiveTimer() {
    if (!activeTimerSession) {
      activeTimerPanel.hidden = true;
      stopActiveTimerInterval();
      return;
    }
    const s = activeTimerSession;
    const running = s.status === 'running';
    activeTimerPanel.hidden = false;
    activeTimerPanel.classList.toggle('active-timer-panel--paused', !running);
    activeTimerClock.classList.toggle('active-timer-clock--paused', !running);
    activeTimerClock.textContent = formatDuration(computeElapsedMs(s));
    activeTimerToggle.textContent = running ? 'Pause' : 'Resume';
    // Meta line = repo (+ #issue when linked). Mirrors popup formatting.
    const ref = s.issueNumber > 0
      ? `${s.repo} · #${s.issueNumber}`
      : s.repo;
    activeTimerMeta.textContent = running ? `Tracking · ${ref}` : `Paused · ${ref}`;
    activeTimerTitle.textContent = s.issueTitle || (s.issueNumber > 0 ? `Issue #${s.issueNumber}` : 'Untitled');
    if (running) startActiveTimerInterval();
    else stopActiveTimerInterval();
  }

  function startActiveTimerInterval() {
    if (activeTimerInterval) return;
    activeTimerInterval = setInterval(() => {
      if (!activeTimerSession || activeTimerSession.status !== 'running') return;
      activeTimerClock.textContent = formatDuration(computeElapsedMs(activeTimerSession));
    }, 1000);
  }

  function stopActiveTimerInterval() {
    if (activeTimerInterval) {
      clearInterval(activeTimerInterval);
      activeTimerInterval = null;
    }
  }

  async function refreshActiveTimer() {
    const state = await sendMessage('GET_STATE');
    activeTimerSession = state?.activeSession || null;
    renderActiveTimer();
  }

  activeTimerToggle.addEventListener('click', async () => {
    if (!activeTimerSession) return;
    const action = activeTimerSession.status === 'running' ? 'PAUSE' : 'RESUME';
    const resp = await sendMessage(action);
    if (resp?.ok) {
      activeTimerSession = resp.session;
      renderActiveTimer();
    }
  });

  activeTimerStop.addEventListener('click', async () => {
    if (!activeTimerSession) return;
    activeTimerStop.disabled = true;
    const resp = await sendMessage('STOP');
    activeTimerStop.disabled = false;
    if (resp?.ok) {
      activeTimerSession = null;
      renderActiveTimer();
      // STOP just wrote a new row to BigQuery — re-pull so the table
      // shows the completed entry immediately.
      await refresh();
      // Surface the project-field sync outcome. Until we added this the
      // Stop button looked silent from My Time and there was no way to
      // tell whether the GitHub "Actual Hours" field actually updated.
      showSyncToast(resp.syncResult, resp.backendResult);
    }
  });

  // --- Sync result toast ---
  //
  // The service worker returns `syncResult` from STOP describing what
  // happened to the GitHub Project field (overwrite with new total, skip
  // because the issue isn't linked to a project, error, etc.). My Time
  // surfaces this as a transient toast so the user can see whether the
  // Actual Hours field updated — the content-script status pill only
  // shows on the GitHub issue page.
  function showSyncToast(syncResult, backendResult) {
    const messages = [];
    let variant = 'success';

    if (backendResult && !backendResult.ok) {
      messages.push(
        backendResult.queued
          ? 'Saved locally — backend push queued for retry.'
          : `Backend push failed: ${backendResult.error || 'unknown'}.`
      );
      variant = backendResult.queued ? 'warning' : 'error';
    }

    if (!syncResult) {
      messages.push('Saved.');
    } else if (syncResult.error) {
      messages.push(`Project sync failed: ${syncResult.error}`);
      variant = 'error';
    } else if (syncResult.skipped) {
      // 'No linked issue', 'Not a GitHub repo', 'Issue is not linked to
      // any GitHub Project', 'No PAT configured' — show the reason so
      // the user knows nothing was written to a project field.
      messages.push(`Saved. ${syncResult.reason || 'No project sync.'}`);
      if (variant === 'success') variant = 'warning';
    } else if (syncResult.results?.length) {
      const synced = syncResult.results.filter((r) => r.synced);
      const skipped = syncResult.results.filter((r) => r.skipped);
      const errored = syncResult.results.filter((r) => r.error);
      const parts = [];
      if (synced.length) {
        const names = synced.map((r) => `${r.project} → ${r.hours}h`).join(', ');
        parts.push(`Actual Hours updated: ${names}`);
      }
      if (skipped.length) {
        parts.push(`Skipped: ${skipped.map((r) => `${r.project} (${r.reason})`).join(', ')}`);
        if (variant === 'success' && !synced.length) variant = 'warning';
      }
      if (errored.length) {
        parts.push(`Errors: ${errored.map((r) => `${r.project}: ${r.error}`).join(', ')}`);
        variant = 'error';
      }
      messages.push(parts.join(' · '));
      if (syncResult.fallback === 'local_cache') {
        messages.push('(used local-cache fallback — server /totals unavailable)');
        if (variant === 'success') variant = 'warning';
      }
    } else {
      messages.push('Saved.');
    }

    const toast = document.createElement('div');
    toast.className = `toast toast--${variant}`;
    toast.textContent = messages.join(' ');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), variant === 'error' ? 9000 : 5000);
  }

  // chrome.storage.local.activeSession is updated by the service worker on
  // every START / PAUSE / RESUME / STOP / SET_TIME. Listening to it gives
  // us a free push-update when the user starts a timer from another
  // surface (popup, content script on an issue page) — no polling needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activeSession) return;
    activeTimerSession = changes.activeSession.newValue || null;
    renderActiveTimer();
  });

  // Date filter changes -> different range -> refetch + reconcile.
  // Repo filter is purely client-side; just re-render.
  filterRepo.addEventListener('change', render);
  filterFrom.addEventListener('change', refresh);
  filterTo.addEventListener('change', refresh);
  btnExport.addEventListener('click', exportCsv);

  // --- Add-entry modal ---
  //
  // Cascading dropdowns: repo -> project (optional) -> issue (optional).
  // When the user picks an issue we auto-fill the title field; without an
  // issue (meetings, PM, email) the title field becomes the entry name
  // and `issueNumber=0` is sent to the backend as the "no linked issue"
  // sentinel. Repo list is restricted to the alive-industries org server-
  // side (FETCH_USER_REPOS).

  const btnAdd = document.getElementById('btn-add');
  const addModal = document.getElementById('add-modal');
  const addOrgSelect = document.getElementById('add-org');
  const addRepoSelect = document.getElementById('add-repo');
  const addProjectSelect = document.getElementById('add-project');
  const addIssueSelect = document.getElementById('add-issue-select');
  const addTitleInput = document.getElementById('add-title');
  const addTitleHint = document.getElementById('add-title-hint');
  const addDateInput = document.getElementById('add-date');
  const addDurationInput = document.getElementById('add-duration');
  const addErrorEl = document.getElementById('add-error');
  const addSubmitBtn = document.getElementById('add-submit');
  const addStartBtn = document.getElementById('add-start');
  const addCancelBtn = document.getElementById('add-cancel');
  const addCloseBtn = document.getElementById('add-close');

  // Holds the bindTimeInput handle while the modal is open so we can read
  // the parsed ms on submit and detach cleanly on reopen.
  let addDurationHandle = null;
  // Cached lookups so we can resolve a selection back to its data after
  // the user clicks Submit/Start without re-fetching.
  let projectsByRepo = new Map();      // repo -> [{ id, title, number }]
  let issuesByProject = new Map();     // projectId -> [{ number, title, repo }]

  function populateOrgSelect(orgs, selected) {
    const list = [...new Set(orgs || [])].sort();
    addOrgSelect.innerHTML = '<option value="">Select an organization…</option>' +
      list.map((o) => `<option value="${escapeHtml(o)}"${o === selected ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    addOrgSelect.disabled = list.length === 0;
  }

  function populateRepoSelect(repos, selected, org) {
    // Historical repos from past sessions belonging to the selected org —
    // surfaces repos the user has tracked even if the GitHub fetch hasn't
    // returned yet (or returns nothing).
    const fromSessions = org
      ? [...new Set(allSessions.map((s) => s.repo))]
          .filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r) && r.startsWith(`${org}/`))
      : [];
    const merged = [...new Set([...(repos || []), ...fromSessions])].sort();
    if (merged.length === 0) {
      addRepoSelect.innerHTML = '<option value="">No repos found</option>';
      addRepoSelect.disabled = false;
      return;
    }
    addRepoSelect.disabled = false;
    addRepoSelect.innerHTML = '<option value="">Select a repo…</option>' +
      merged.map((r) => `<option value="${escapeHtml(r)}"${r === selected ? ' selected' : ''}>${escapeHtml(r)}</option>`).join('');
  }

  function setRepoSelectState(state) {
    if (state === 'loading') {
      addRepoSelect.innerHTML = '<option value="">Loading repos…</option>';
      addRepoSelect.disabled = true;
    } else if (state === 'idle') {
      addRepoSelect.innerHTML = '<option value="">Pick an organization first</option>';
      addRepoSelect.disabled = true;
    } else if (state === 'error') {
      addRepoSelect.innerHTML = '<option value="">(error fetching repos)</option>';
      addRepoSelect.disabled = false;
    }
  }

  function setProjectSelectState(state, projects) {
    if (state === 'loading') {
      addProjectSelect.innerHTML = '<option value="">Loading projects…</option>';
      addProjectSelect.disabled = true;
      return;
    }
    if (state === 'idle') {
      addProjectSelect.innerHTML = '<option value="">Pick a repo first</option>';
      addProjectSelect.disabled = true;
      return;
    }
    if (state === 'error') {
      addProjectSelect.innerHTML = '<option value="">(error fetching projects)</option>';
      addProjectSelect.disabled = false;
      return;
    }
    // ready
    addProjectSelect.disabled = false;
    addProjectSelect.innerHTML = '<option value="">No project</option>' +
      (projects || []).map((p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`
      ).join('');
  }

  function setIssueSelectState(state, issues) {
    if (state === 'loading') {
      addIssueSelect.innerHTML = '<option value="">Loading issues…</option>';
      addIssueSelect.disabled = true;
      return;
    }
    if (state === 'idle') {
      addIssueSelect.innerHTML = '<option value="">Pick a project first</option>';
      addIssueSelect.disabled = true;
      return;
    }
    if (state === 'error') {
      addIssueSelect.innerHTML = '<option value="">(error fetching issues)</option>';
      addIssueSelect.disabled = false;
      return;
    }
    addIssueSelect.disabled = false;
    addIssueSelect.innerHTML = '<option value="">No issue (use title below)</option>' +
      (issues || []).map((i) => {
        const stateBadge = i.state === 'OPEN' ? '' : ' [closed]';
        return `<option value="${i.number}">#${i.number} ${escapeHtml(i.title)}${stateBadge}</option>`;
      }).join('');
  }

  async function onOrgChange() {
    const org = addOrgSelect.value;
    // Reset the downstream cascade — the picked repo no longer applies.
    setProjectSelectState('idle');
    setIssueSelectState('idle');
    if (!org) {
      setRepoSelectState('idle');
      return;
    }
    const { settings = {} } = await chrome.storage.local.get('settings');
    const cached = settings.knownReposByOrg?.[org];
    if (cached?.length) {
      populateRepoSelect(cached, '', org);
    } else {
      setRepoSelectState('loading');
    }
    // Always re-fetch in the background so the list stays fresh.
    const resp = await sendMessage('FETCH_USER_REPOS', { org });
    if (addModal.hidden || addOrgSelect.value !== org) return;
    if (resp?.ok) {
      populateRepoSelect(resp.repos, addRepoSelect.value, org);
    } else if (!cached?.length) {
      setRepoSelectState('error');
    }
  }

  async function onRepoChange() {
    const repo = addRepoSelect.value;
    setIssueSelectState('idle');
    if (!repo) {
      setProjectSelectState('idle');
      return;
    }
    if (projectsByRepo.has(repo)) {
      setProjectSelectState('ready', projectsByRepo.get(repo));
      return;
    }
    setProjectSelectState('loading');
    const resp = await sendMessage('FETCH_REPO_PROJECTS', { repo });
    if (!resp?.ok) {
      setProjectSelectState('error');
      return;
    }
    projectsByRepo.set(repo, resp.projects);
    setProjectSelectState('ready', resp.projects);
  }

  async function onProjectChange() {
    const projectId = addProjectSelect.value;
    if (!projectId) {
      setIssueSelectState('idle');
      return;
    }
    const repo = addRepoSelect.value;
    const cacheKey = `${projectId}|${repo}`;
    if (issuesByProject.has(cacheKey)) {
      setIssueSelectState('ready', issuesByProject.get(cacheKey));
      return;
    }
    setIssueSelectState('loading');
    const resp = await sendMessage('FETCH_PROJECT_ISSUES', { projectId, repo });
    if (!resp?.ok) {
      setIssueSelectState('error');
      return;
    }
    issuesByProject.set(cacheKey, resp.issues);
    setIssueSelectState('ready', resp.issues);
  }

  function onIssueChange() {
    // Auto-fill the title when an issue is picked so the user doesn't
    // have to retype it. Leave it alone (don't blank) when issue is
    // cleared — the user may have typed something custom.
    const issueNumber = parseInt(addIssueSelect.value, 10);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      addTitleHint.textContent = '(required when no issue is linked)';
      return;
    }
    addTitleHint.textContent = '(autofilled — edit if needed)';
    const projectId = addProjectSelect.value;
    const repo = addRepoSelect.value;
    const issues = issuesByProject.get(`${projectId}|${repo}`) || [];
    const match = issues.find((i) => i.number === issueNumber);
    if (match) addTitleInput.value = match.title;
  }

  async function openAddModal() {
    addErrorEl.textContent = '';
    addDateInput.value = formatDateISO(Date.now());
    addTitleInput.value = '';
    addTitleHint.textContent = '(required when no issue is linked)';

    if (addDurationHandle?.detach) addDurationHandle.detach();
    addDurationInput.value = '';
    addDurationHandle = self.TaktTime.bindTimeInput(addDurationInput, { initialMs: 0 });

    projectsByRepo = new Map();
    issuesByProject = new Map();
    setProjectSelectState('idle');
    setIssueSelectState('idle');

    // Render cached orgs/repos (settings.knownOrgs, settings.knownReposByOrg
    // — falling back to legacy knownRepos for the primary Takt org) so the
    // dropdowns aren't empty on first open. Then kick fresh fetches in
    // parallel; when they land we re-render, preserving any user selection.
    const { settings = {} } = await chrome.storage.local.get('settings');
    const cachedOrgs = settings.knownOrgs || [];
    // Default selection: the primary Takt org so existing users see no
    // behavioural change on first open.
    const defaultOrg = cachedOrgs.includes('alive-industries')
      ? 'alive-industries'
      : (cachedOrgs[0] || 'alive-industries');
    const initialOrgs = cachedOrgs.length ? cachedOrgs : [defaultOrg];
    populateOrgSelect(initialOrgs, defaultOrg);
    addOrgSelect.value = defaultOrg;

    // Seed the repo dropdown with whatever we have cached for the default
    // org (knownReposByOrg, falling back to the legacy knownRepos field).
    const seededRepos =
      settings.knownReposByOrg?.[defaultOrg]
      || (defaultOrg === 'alive-industries' ? settings.knownRepos : null)
      || [];
    if (seededRepos.length) {
      populateRepoSelect(seededRepos, '', defaultOrg);
    } else {
      setRepoSelectState('loading');
    }

    // Refresh orgs in the background; if new ones appear, re-populate while
    // preserving the user's current selection.
    sendMessage('FETCH_USER_ORGS').then((resp) => {
      if (!resp?.ok || addModal.hidden) return;
      populateOrgSelect(resp.orgs, addOrgSelect.value || defaultOrg);
    }).catch(() => {});

    // Refresh repos for the default org in the background.
    sendMessage('FETCH_USER_REPOS', { org: defaultOrg }).then((resp) => {
      if (addModal.hidden || addOrgSelect.value !== defaultOrg) return;
      if (resp?.ok) {
        populateRepoSelect(resp.repos, addRepoSelect.value, defaultOrg);
      } else if (!seededRepos.length) {
        setRepoSelectState('error');
      }
    }).catch(() => {
      if (!addModal.hidden && !seededRepos.length) setRepoSelectState('error');
    });

    addModal.hidden = false;
    addOrgSelect.focus();
  }

  function closeAddModal() {
    addModal.hidden = true;
  }

  function showAddError(msg) {
    addErrorEl.textContent = msg;
  }

  // Collect + validate the modal state. Returns either
  //   { ok: true, ...fields }  for a valid form, or
  //   { ok: false, error }     so the caller can show it.
  function readAddForm({ requireDuration }) {
    const repo = addRepoSelect.value;
    if (!repo) return { ok: false, error: 'Pick a repo.' };

    const issueRaw = parseInt(addIssueSelect.value, 10);
    const issueNumber = Number.isFinite(issueRaw) && issueRaw > 0 ? issueRaw : 0;

    const issueTitle = addTitleInput.value.trim();
    if (issueNumber === 0 && !issueTitle) {
      return { ok: false, error: 'Title is required when no issue is linked.' };
    }

    if (requireDuration) {
      const durationMs = addDurationHandle?.getMs() ?? null;
      if (!durationMs || durationMs <= 0) {
        return { ok: false, error: 'Duration must be greater than zero.' };
      }
      const dateStr = addDateInput.value;
      if (!dateStr) return { ok: false, error: 'Date is required.' };
      const completedAt = new Date(`${dateStr}T17:00:00`).getTime();
      if (!Number.isFinite(completedAt)) return { ok: false, error: 'Invalid date.' };
      return { ok: true, repo, issueNumber, issueTitle: issueTitle || null, completedAt, durationMs };
    }
    return { ok: true, repo, issueNumber, issueTitle: issueTitle || null };
  }

  async function submitAddEntry() {
    const form = readAddForm({ requireDuration: true });
    if (!form.ok) return showAddError(form.error);

    showAddError('');
    addSubmitBtn.disabled = true;
    const resp = await sendMessage('ADD_MANUAL_SESSION', {
      repo: form.repo,
      issueNumber: form.issueNumber,
      issueTitle: form.issueTitle,
      completedAt: form.completedAt,
      durationMs: form.durationMs,
    });
    addSubmitBtn.disabled = false;

    if (resp?.ok) {
      closeAddModal();
      await refresh();
    } else {
      showAddError(resp?.error?.message || 'Failed to add entry.');
    }
  }

  // Start a live timer from the modal. Skips Date/Duration — the timer
  // will accumulate its own elapsed time; the user finishes it from the
  // popup or content-script button on the issue page (same as a STOP).
  async function startTrackingFromModal() {
    const form = readAddForm({ requireDuration: false });
    if (!form.ok) return showAddError(form.error);

    showAddError('');
    addStartBtn.disabled = true;
    const resp = await sendMessage('START', {
      repo: form.repo,
      issueNumber: form.issueNumber,
      issueTitle: form.issueTitle
        || (form.issueNumber > 0 ? `Issue #${form.issueNumber}` : 'Untitled'),
      sourceUrl: null,
    });
    addStartBtn.disabled = false;

    if (resp?.ok) {
      closeAddModal();
    } else {
      showAddError(resp?.error || resp?.error?.message || 'Failed to start timer.');
    }
  }

  btnAdd.addEventListener('click', openAddModal);
  addCancelBtn.addEventListener('click', closeAddModal);
  addCloseBtn.addEventListener('click', closeAddModal);
  addSubmitBtn.addEventListener('click', submitAddEntry);
  addStartBtn.addEventListener('click', startTrackingFromModal);
  addOrgSelect.addEventListener('change', onOrgChange);
  addRepoSelect.addEventListener('change', onRepoChange);
  addProjectSelect.addEventListener('change', onProjectChange);
  addIssueSelect.addEventListener('change', onIssueChange);
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) closeAddModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !addModal.hidden) closeAddModal();
  });

  init();
})();

(() => {
  'use strict';

  const sessionsBody = document.getElementById('sessions-body');
  const filterRepo = document.getElementById('filter-repo');
  const filterFrom = document.getElementById('filter-from');
  const filterTo = document.getElementById('filter-to');
  const summaryCount = document.getElementById('summary-count');
  const summaryHours = document.getElementById('summary-hours');
  const btnExport = document.getElementById('btn-export');

  let allSessions = [];

  // --- Helpers ---

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

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
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Filtering ---

  function getFiltered() {
    let sessions = allSessions;

    const repo = filterRepo.value;
    if (repo) {
      sessions = sessions.filter((s) => s.repo === repo);
    }

    const from = filterFrom.value;
    if (from) {
      const fromMs = new Date(from).getTime();
      sessions = sessions.filter((s) => s.completedAt >= fromMs);
    }

    const to = filterTo.value;
    if (to) {
      const toMs = new Date(to).getTime() + 86400000; // end of day
      sessions = sessions.filter((s) => s.completedAt < toMs);
    }

    return sessions;
  }

  // --- Render ---

  function render() {
    const sessions = getFiltered();

    // Summary
    summaryCount.textContent = sessions.length;
    const totalMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    summaryHours.textContent = toHours(totalMs).toFixed(2);

    // Table
    if (sessions.length === 0) {
      sessionsBody.innerHTML = '<tr><td colspan="6" class="empty-state">No time entries found.</td></tr>';
      return;
    }

    sessionsBody.innerHTML = sessions
      .map((s, i) => {
        const originalIndex = allSessions.indexOf(s);
        return `
          <tr data-index="${originalIndex}">
            <td class="muted">${formatDate(s.completedAt)}</td>
            <td><a href="https://github.com/${escapeHtml(s.repo)}" target="_blank">${escapeHtml(s.repo)}</a></td>
            <td><a href="https://github.com/${escapeHtml(s.repo)}/issues/${s.issueNumber}" target="_blank">#${s.issueNumber} ${escapeHtml(s.issueTitle || '')}</a></td>
            <td class="mono">${formatDuration(s.durationMs)}</td>
            <td class="mono">${toHours(s.durationMs).toFixed(2)}</td>
            <td class="td-actions">
              <button class="btn btn--danger btn--sm btn-delete" data-index="${originalIndex}" title="Remove entry">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>
              </button>
            </td>
          </tr>`;
      })
      .join('');

    // Delete buttons
    sessionsBody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteSession(parseInt(btn.dataset.index)));
    });
  }

  // --- Delete ---

  async function deleteSession(index) {
    const resp = await sendMessage('DELETE_SESSION', { index });
    if (resp?.ok) {
      allSessions = resp.completedSessions;
      render();
    }
  }

  // --- Export CSV ---

  function exportCsv() {
    const sessions = getFiltered();
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

    // BOM for Excel UTF-8 compatibility
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
    filterRepo.innerHTML = '<option value="">All repos</option>';
    for (const r of repos) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      filterRepo.appendChild(opt);
    }
  }

  function init() {
    sendMessage('GET_STATE').then((state) => {
      allSessions = state?.completedSessions || [];
      populateFilters();
      render();
    });
  }

  filterRepo.addEventListener('change', render);
  filterFrom.addEventListener('change', render);
  filterTo.addEventListener('change', render);
  btnExport.addEventListener('click', exportCsv);

  init();
})();

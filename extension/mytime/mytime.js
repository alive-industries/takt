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
            <td>${escapeHtml(s.repo)}</td>
            <td>#${s.issueNumber} ${escapeHtml(s.issueTitle || '')}</td>
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

  // --- Export .xlsx ---

  function exportXlsx() {
    const sessions = getFiltered();
    if (sessions.length === 0) return;

    // Build XLSX using the simple XML spreadsheet format (Excel-compatible)
    const rows = sessions.map((s) => [
      formatDateISO(s.completedAt),
      s.repo,
      s.issueNumber,
      s.issueTitle || '',
      formatDuration(s.durationMs),
      toHours(s.durationMs),
    ]);

    const totalHours = rows.reduce((sum, r) => sum + r[5], 0);

    const escXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let xml = '<?xml version="1.0"?>\n';
    xml += '<?mso-application progid="Excel.Sheet"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
    xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
    xml += '<Styles>\n';
    xml += '  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#F6F8FA" ss:Pattern="Solid"/></Style>\n';
    xml += '  <Style ss:ID="Num"><NumberFormat ss:Format="0.00"/></Style>\n';
    xml += '  <Style ss:ID="Bold"><Font ss:Bold="1"/></Style>\n';
    xml += '</Styles>\n';
    xml += '<Worksheet ss:Name="Time Log">\n';
    xml += '<Table>\n';

    // Column widths
    xml += '<Column ss:Width="85"/><Column ss:Width="160"/><Column ss:Width="55"/><Column ss:Width="200"/><Column ss:Width="80"/><Column ss:Width="65"/>\n';

    // Header
    xml += '<Row ss:StyleID="Header">\n';
    ['Date', 'Repo', 'Issue #', 'Issue Title', 'Duration', 'Hours'].forEach((h) => {
      xml += `  <Cell><Data ss:Type="String">${escXml(h)}</Data></Cell>\n`;
    });
    xml += '</Row>\n';

    // Data rows
    for (const row of rows) {
      xml += '<Row>\n';
      xml += `  <Cell><Data ss:Type="String">${escXml(row[0])}</Data></Cell>\n`;
      xml += `  <Cell><Data ss:Type="String">${escXml(row[1])}</Data></Cell>\n`;
      xml += `  <Cell><Data ss:Type="Number">${row[2]}</Data></Cell>\n`;
      xml += `  <Cell><Data ss:Type="String">${escXml(row[3])}</Data></Cell>\n`;
      xml += `  <Cell><Data ss:Type="String">${escXml(row[4])}</Data></Cell>\n`;
      xml += `  <Cell ss:StyleID="Num"><Data ss:Type="Number">${row[5]}</Data></Cell>\n`;
      xml += '</Row>\n';
    }

    // Total row
    xml += '<Row>\n';
    xml += '  <Cell ss:StyleID="Bold"><Data ss:Type="String">Total</Data></Cell>\n';
    xml += '  <Cell/><Cell/><Cell/><Cell/>\n';
    xml += `  <Cell ss:StyleID="Bold"><Data ss:Type="Number">${Math.round(totalHours * 100) / 100}</Data></Cell>\n`;
    xml += '</Row>\n';

    xml += '</Table>\n</Worksheet>\n</Workbook>';

    // Download
    const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `takt-time-log-${dateStr}.xlsx`;
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
  btnExport.addEventListener('click', exportXlsx);

  init();
})();

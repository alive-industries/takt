(function (root) {
  'use strict';

  const htmlEscapes = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => htmlEscapes[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function computeElapsed(session) {
    if (!session) return 0;
    const running = session.status === 'running' ? Date.now() - session.startedAt : 0;
    return (session.accumulatedMs || 0) + running;
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
  }

  function formatDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDate(value, locale, options) {
    if (!value) return '—';
    return new Date(value).toLocaleDateString(locale, options);
  }

  function showStatus(element, text, type, baseClass = '') {
    element.textContent = text;
    element.className = type
      ? [baseClass, `status--${type}`].filter(Boolean).join(' ')
      : baseClass;
  }

  root.TaktUI = {
    escapeHtml,
    escapeAttribute,
    computeElapsed,
    formatElapsed,
    formatDuration,
    formatDate,
    showStatus,
  };
})(typeof self !== 'undefined' ? self : globalThis);

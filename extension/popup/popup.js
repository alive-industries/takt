(() => {
  'use strict';

  const activeSection = document.getElementById('active-section');
  const sessionsList = document.getElementById('sessions-list');
  const optionsLink = document.getElementById('options-link');

  let currentSession = null;
  let displayInterval = null;

  // --- Helpers ---

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function formatDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatRelative(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function computeElapsed(session) {
    if (!session) return 0;
    const running =
      session.status === 'running' ? Date.now() - session.startedAt : 0;
    return session.accumulatedMs + running;
  }

  function sendMessage(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  // --- Render ---

  function renderActive() {
    if (!currentSession) {
      activeSection.innerHTML =
        '<div class="active-empty">No active timer. Start one from a GitHub issue page.</div>';
      return;
    }

    const elapsed = computeElapsed(currentSession);
    const isRunning = currentSession.status === 'running';
    const timerClass = isRunning
      ? 'active-timer--running'
      : 'active-timer--paused';

    activeSection.innerHTML = `
      <div class="active">
        <div class="active-repo">${currentSession.repo}</div>
        <div class="active-issue">#${currentSession.issueNumber} ${escapeHtml(currentSession.issueTitle)}</div>
        <div class="active-timer ${timerClass}" id="timer-display">${formatElapsed(elapsed)}</div>
        <div class="active-controls">
          <button class="btn btn--primary" id="btn-toggle">
            ${isRunning ? '\u23F8 Pause' : '\u25B6 Resume'}
          </button>
          <button class="btn btn--danger" id="btn-stop">\u25A0 Stop</button>
        </div>
      </div>
    `;

    document.getElementById('btn-toggle').addEventListener('click', () => {
      const action = currentSession.status === 'running' ? 'PAUSE' : 'RESUME';
      sendMessage(action).then((resp) => {
        if (resp?.ok) {
          currentSession = resp.session;
          renderActive();
          toggleDisplayTimer();
        }
      });
    });

    document.getElementById('btn-stop').addEventListener('click', () => {
      sendMessage('STOP').then((resp) => {
        if (resp?.ok) {
          currentSession = null;
          renderActive();
          stopDisplayTimer();
          loadSessions();
        }
      });
    });
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML =
        '<li style="color:#656d76">No sessions yet</li>';
      return;
    }

    sessionsList.innerHTML = sessions
      .slice(0, 5)
      .map(
        (s) => `
        <li>
          <span class="session-ref">${s.repo}#${s.issueNumber}</span>
          <span class="session-duration">${formatDuration(s.durationMs)} &middot; ${formatRelative(s.completedAt)}</span>
        </li>
      `
      )
      .join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Display timer ---

  function toggleDisplayTimer() {
    if (currentSession?.status === 'running') {
      startDisplayTimer();
    } else {
      stopDisplayTimer();
    }
  }

  function startDisplayTimer() {
    stopDisplayTimer();
    displayInterval = setInterval(() => {
      const el = document.getElementById('timer-display');
      if (el && currentSession) {
        el.textContent = formatElapsed(computeElapsed(currentSession));
      }
    }, 1000);
  }

  function stopDisplayTimer() {
    if (displayInterval) {
      clearInterval(displayInterval);
      displayInterval = null;
    }
  }

  // --- Load data ---

  function loadSessions() {
    chrome.storage.local.get('completedSessions', ({ completedSessions }) => {
      renderSessions(completedSessions || []);
    });
  }

  function init() {
    sendMessage('GET_STATE').then((state) => {
      currentSession = state?.activeSession || null;
      renderActive();
      toggleDisplayTimer();
      renderSessions(state?.completedSessions || []);
    });
  }

  // --- Options link ---

  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // --- Init ---

  init();
})();

(() => {
  'use strict';

  const activeSection = document.getElementById('active-section');
  const sessionsList = document.getElementById('sessions-list');

  let currentSession = null;
  let displayInterval = null;
  const { escapeHtml, formatElapsed, formatDuration, computeElapsed } = self.TaktUI;

  // --- Helpers ---

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

  function sendMessage(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  // --- Render ---

  function renderActive() {
    if (!currentSession) {
      activeSection.innerHTML =
        '<div class="active-empty">No active timer. Resume recent work below or start from the dashboard.</div>';
      return;
    }

    const elapsed = computeElapsed(currentSession);
    const isRunning = currentSession.status === 'running';
    const timerClass = isRunning
      ? 'active-timer--running'
      : 'active-timer--paused';

    // issueNumber=0 = manual entry / "no linked issue" (meetings, PM,
    // email). Show just the title without a phantom #0 prefix.
    const issueLabel = currentSession.issueNumber > 0
      ? `#${currentSession.issueNumber} ${escapeHtml(currentSession.issueTitle || '')}`
      : escapeHtml(currentSession.description || 'Untitled');
    const baseContext = currentSession.label
      || currentSession.repo
      || (currentSession.client ? `${currentSession.client} — ops` : 'unassigned');
    const contextLabel = currentSession.reportingStatus === 'pending_metadata'
      ? `Needs reporting details — ${baseContext}`
      : baseContext;
    activeSection.innerHTML = `
      <div class="active${isRunning ? '' : ' active--paused'}">
        <div class="active-repo">${escapeHtml(contextLabel || '')}</div>
        <div class="active-issue">${issueLabel}</div>
        <div class="active-timer ${timerClass}" id="timer-display">${formatElapsed(elapsed)}</div>
        <div class="active-controls">
          <button class="btn btn--primary btn--sm" id="btn-toggle">${isRunning ? 'Pause' : 'Resume'}</button>
          <button class="btn btn--danger btn--sm" id="btn-stop">Stop</button>
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
          refreshSyncStatus();
        }
      });
    });
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML =
        '<li class="empty">No sessions yet</li>';
      return;
    }

    const recent = sessions.slice(0, 3);
    sessionsList.innerHTML = recent.map((session) => {
      const ref = session.issueNumber > 0
        ? `${escapeHtml(session.repo)}#${session.issueNumber}`
        : escapeHtml(session.label || session.description || session.client || 'Needs reporting details');
      return `
        <li>
          <div class="session-row">
            <span class="session-ref">${ref}</span>
            <button class="btn btn--sm btn--resume" data-resume="${escapeHtml(session.sessionId)}"${currentSession ? ' disabled' : ''}>Resume</button>
          </div>
          <div class="session-duration">${formatDuration(session.durationMs)} &middot; ${formatRelative(session.completedAt)}</div>
        </li>`;
    }).join('');
    sessionsList.querySelectorAll('[data-resume]').forEach((button) => {
      button.addEventListener('click', async () => {
        const session = recent.find((item) => item.sessionId === button.dataset.resume);
        if (!session || currentSession) return;
        button.disabled = true;
        const resp = await sendMessage('START', {
          source: session.source,
          entryType: session.entryType,
          clientId: session.clientId,
          client: session.client,
          repo: session.repo,
          reportingProjectId: session.reportingProjectId,
          project: session.project,
          issueNumber: session.issueNumber,
          issueTitle: session.issueTitle,
          description: session.description,
          sourceUrl: session.source === 'github' ? session.sourceUrl : null,
        });
        if (resp?.ok) {
          currentSession = resp.session;
          renderActive();
          toggleDisplayTimer();
          renderSessions(recent);
        } else {
          button.disabled = false;
        }
      });
    });
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
    sendMessage('LIST_LOCAL_SESSIONS', { limit: 5 }).then((resp) => {
      const records = resp?.sessions || [];
      // Cache records use { issueNumber, durationMs, completedAt } too, so
      // renderSessions works directly.
      renderSessions(records);
    });
  }

  async function refreshSyncStatus() {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const [ping, queue] = await Promise.all([
      sendMessage('BACKEND_PING'),
      sendMessage('QUEUE_STATUS'),
    ]);
    const failed = queue?.failed?.length || 0;
    let variant = 'ok';
    let text = 'Synced';
    if (failed > 0) {
      variant = 'error';
      text = `${failed} failed to sync`;
    } else if (queue?.authBlocked) {
      variant = 'warn';
      text = 'Sync paused — check token';
    } else if ((queue?.pending || 0) > 0) {
      variant = 'warn';
      text = `${queue.pending} pending`;
    } else if (!ping?.ok) {
      variant = 'error';
      text = 'Offline';
    }
    const chip = document.createElement('span');
    chip.className = `chip chip--${variant}`;
    const dotEl = document.createElement('span');
    dotEl.className = 'chip-dot';
    chip.append(dotEl, text);
    if (failed > 0) {
      const retry = document.createElement('button');
      retry.className = 'sync-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        await sendMessage('RETRY_FAILED');
        refreshSyncStatus();
      });
      chip.append(retry);
    }
    el.replaceChildren(chip);
  }

  function init() {
    sendMessage('GET_STATE').then((state) => {
      currentSession = state?.activeSession || null;
      renderActive();
      toggleDisplayTimer();
    });
    loadSessions();
    refreshSyncStatus();
  }

  document.getElementById('dashboard-link').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.activeSession) return;
    currentSession = changes.activeSession.newValue || null;
    renderActive();
    toggleDisplayTimer();
  });

  // --- Init ---

  init();
})();

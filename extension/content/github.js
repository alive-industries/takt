(() => {
  'use strict';

  const CONTAINER_ID = 'takt-timer-container';
  const LOG_PREFIX = '[Takt]';
  let timerInterval = null;
  let currentSession = null;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // --- URL parsing ---

  function parseIssuePage() {
    const path = window.location.pathname;
    const search = window.location.search;

    // Standard issue page: /owner/repo/issues/123
    const issueMatch = path.match(/^\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    if (issueMatch) {
      return { repo: issueMatch[1], issueNumber: parseInt(issueMatch[2], 10) };
    }

    // Project board: /orgs/org/projects/N?pane=issue&issue=owner|repo|123
    if (path.match(/^\/orgs\/[^/]+\/projects\/\d+/)) {
      const params = new URLSearchParams(search);
      const issueParam = params.get('issue');
      if (issueParam) {
        const parts = issueParam.split('|');
        if (parts.length === 3) {
          return { repo: `${parts[0]}/${parts[1]}`, issueNumber: parseInt(parts[2], 10) };
        }
      }
    }

    return null;
  }

  // --- Wait for element ---

  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  // --- Time formatting ---

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function computeElapsed(session) {
    if (!session) return 0;
    const running = session.status === 'running' ? Date.now() - session.startedAt : 0;
    return session.accumulatedMs + running;
  }

  // --- Styles ---

  function injectStyles() {
    if (document.getElementById('takt-styles')) return;
    const style = document.createElement('style');
    style.id = 'takt-styles';
    style.textContent = `
      #${CONTAINER_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 4px;
      }
      .takt-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 12px;
        border: 1px solid var(--borderColor-default, #d1d9e0);
        border-radius: 6px;
        background: var(--bgColor-default, #fff);
        color: var(--fgColor-default, #1f2328);
        font-size: 12px;
        font-weight: 500;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
        cursor: pointer;
        transition: background 0.15s;
        white-space: nowrap;
        height: 32px;
        box-sizing: border-box;
      }
      .takt-btn:hover { background: var(--bgColor-muted, #f6f8fa); }
      .takt-btn--running {
        border-color: var(--borderColor-accent-emphasis, #0969da);
        color: var(--fgColor-accent, #0969da);
        background: var(--bgColor-accent-muted, #ddf4ff);
      }
      .takt-btn--running:hover { background: #b6e3ff; }
      .takt-btn--paused {
        border-color: var(--borderColor-attention-emphasis, #bf8700);
        color: var(--fgColor-attention, #9a6700);
        background: var(--bgColor-attention-muted, #fff8c5);
      }
      .takt-btn--paused:hover { background: #fef3b4; }
      .takt-stop-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 8px;
        border: 1px solid var(--borderColor-danger-emphasis, #cf222e);
        border-radius: 6px;
        background: var(--bgColor-default, #fff);
        color: var(--fgColor-danger, #d1242f);
        font-size: 12px;
        cursor: pointer;
        height: 32px;
        box-sizing: border-box;
        transition: background 0.15s;
      }
      .takt-stop-btn:hover { background: var(--bgColor-danger-muted, #ffebe9); }
      .takt-timer {
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .takt-sync-status {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 6px;
        margin-left: 4px;
      }
      .takt-sync-status--success { color: var(--fgColor-success, #1a7f37); background: var(--bgColor-success-muted, #dafbe1); }
      .takt-sync-status--error { color: var(--fgColor-danger, #d1242f); background: var(--bgColor-danger-muted, #ffebe9); }
    `;
    document.head.appendChild(style);
  }

  // --- UI rendering ---

  function renderContainer(container, issue) {
    // Active session on a different issue
    if (
      currentSession &&
      (currentSession.repo !== issue.repo ||
        currentSession.issueNumber !== issue.issueNumber)
    ) {
      container.innerHTML = `
        <button class="takt-btn" disabled title="Timer active on ${currentSession.repo}#${currentSession.issueNumber}">
          <span>\u25B6</span> Track time
        </button>
      `;
      return;
    }

    // Active session on THIS issue
    if (
      currentSession &&
      currentSession.repo === issue.repo &&
      currentSession.issueNumber === issue.issueNumber
    ) {
      const elapsed = computeElapsed(currentSession);
      const isRunning = currentSession.status === 'running';
      const stateClass = isRunning ? 'takt-btn--running' : 'takt-btn--paused';
      const icon = isRunning ? '\u23F8' : '\u25B6';
      const label = isRunning ? '' : 'Resume ';

      container.innerHTML = `
        <button class="takt-btn ${stateClass}" data-action="${isRunning ? 'PAUSE' : 'RESUME'}">
          <span>${icon}</span>
          <span class="takt-timer">${label}${formatElapsed(elapsed)}</span>
        </button>
        <button class="takt-stop-btn" data-action="STOP" title="Stop timer">
          <span>\u25A0</span>
        </button>
      `;
      return;
    }

    // Idle
    container.innerHTML = `
      <button class="takt-btn" data-action="START">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: text-bottom;">
          <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 3a.75.75 0 01.75.75v3.69l2.28 2.28a.75.75 0 01-1.06 1.06l-2.5-2.5A.75.75 0 017.25 8V3.75A.75.75 0 018 3z"/>
        </svg>
        Track time
      </button>
    `;
  }

  // --- Timer display ---

  function startDisplayTimer(container) {
    stopDisplayTimer();
    timerInterval = setInterval(() => {
      if (!currentSession || currentSession.status !== 'running') return;
      const timerEl = container.querySelector('.takt-timer');
      if (timerEl) {
        timerEl.textContent = formatElapsed(computeElapsed(currentSession));
      }
    }, 1000);
  }

  function stopDisplayTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // --- Message sending ---

  function sendMessage(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  // --- Click handling ---

  function handleClick(container, issue, action) {
    switch (action) {
      case 'START': {
        const title =
          document.querySelector('[data-testid="issue-title"]')?.textContent?.trim() ||
          document.querySelector('.markdown-title')?.textContent?.trim() ||
          `Issue #${issue.issueNumber}`;
        sendMessage('START', {
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          issueTitle: title,
        }).then((resp) => {
          if (resp?.ok) {
            currentSession = resp.session;
            renderContainer(container, issue);
            startDisplayTimer(container);
          }
        });
        break;
      }
      case 'PAUSE':
        sendMessage('PAUSE').then((resp) => {
          if (resp?.ok) { currentSession = resp.session; renderContainer(container, issue); stopDisplayTimer(); }
        });
        break;
      case 'RESUME':
        sendMessage('RESUME').then((resp) => {
          if (resp?.ok) { currentSession = resp.session; renderContainer(container, issue); startDisplayTimer(container); }
        });
        break;
      case 'STOP':
        sendMessage('STOP').then((resp) => {
          if (resp?.ok) {
            currentSession = null;
            stopDisplayTimer();
            renderContainer(container, issue);
            showSyncStatus(container, resp.syncResult);
          }
        });
        break;
    }
  }

  function showSyncStatus(container, syncResult) {
    if (!syncResult) return;
    const statusDiv = document.createElement('span');
    statusDiv.className = syncResult.error
      ? 'takt-sync-status takt-sync-status--error'
      : 'takt-sync-status takt-sync-status--success';
    statusDiv.textContent = syncResult.error
      ? `Sync failed: ${syncResult.error}`
      : 'Synced';
    container.appendChild(statusDiv);
    setTimeout(() => statusDiv.remove(), 5000);
  }

  // --- Header anchor selectors ---
  // Inject into the header actions area (next to Edit/New Issue buttons)
  // Clockify uses [data-component="PH_Actions"], we'll use the same approach

  const HEADER_SELECTORS = [
    // PageHeader Actions area (contains Edit + New Issue buttons) - standard issue page
    '[data-component="PH_Actions"]',
    // Context area actions (narrow viewport variant)
    '[class*="HeaderMenu-module__menuActionsContainer"]',
    // Side panel header actions (project board issue pane)
    '[class*="HeaderMenu-module__buttonContainer"]',
  ];

  // --- Injection ---

  async function inject() {
    const issue = parseIssuePage();
    if (!issue) {
      log('Not an issue page:', window.location.href);
      return;
    }

    if (document.getElementById(CONTAINER_ID)) {
      log('Already injected');
      return;
    }

    log('Issue detected:', issue.repo, '#' + issue.issueNumber);

    // Wait for the header actions area to appear
    let anchor = null;
    for (const sel of HEADER_SELECTORS) {
      anchor = document.querySelector(sel);
      if (anchor) {
        log('Found header anchor immediately:', sel);
        break;
      }
    }

    if (!anchor) {
      const combinedSel = HEADER_SELECTORS.join(', ');
      log('Waiting for header anchor:', combinedSel);
      anchor = await waitForElement(combinedSel, 15000);
    }

    if (!anchor) {
      log('ERROR: Header anchor not found. Available data-component elements:',
        [...document.querySelectorAll('[data-component]')].map(e => e.getAttribute('data-component')).join(', ')
      );
      return;
    }

    // Don't double-inject (race condition guard)
    if (document.getElementById(CONTAINER_ID)) return;

    log('Injecting into header area');
    injectStyles();

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    // Insert at the beginning of the actions area (before Edit button)
    anchor.prepend(container);

    // Event delegation
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) handleClick(container, issue, btn.dataset.action);
    });

    // Get current state and render
    sendMessage('GET_STATE').then((state) => {
      currentSession = state?.activeSession || null;
      renderContainer(container, issue);
      if (currentSession?.status === 'running') {
        startDisplayTimer(container);
      }
      log('Rendered:', currentSession ? currentSession.status : 'idle');
    });
  }

  // --- SPA navigation handling ---

  let lastUrl = window.location.href;

  function onUrlChange() {
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();
    stopDisplayTimer();
    inject();
  }

  const observer = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      log('URL changed:', currentUrl);
      onUrlChange();
      return;
    }
    // Re-inject if container was removed by GitHub's DOM updates
    if (!document.getElementById(CONTAINER_ID) && parseIssuePage()) {
      inject();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('turbo:load', () => {
    log('turbo:load');
    lastUrl = window.location.href;
    onUrlChange();
  });

  window.addEventListener('popstate', () => {
    log('popstate');
    lastUrl = window.location.href;
    onUrlChange();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'TICK' && message.payload?.session) {
      currentSession = message.payload.session;
    }
  });

  log('Content script loaded:', window.location.href);
  inject();
})();

(() => {
  'use strict';

  const patInput = document.getElementById('pat');
  const btnValidate = document.getElementById('btn-validate');
  const statusEl = document.getElementById('status');
  const projectsSection = document.getElementById('projects-section');
  const projectsList = document.getElementById('projects-list');
  const defaultFieldSelect = document.getElementById('default-field');
  const btnSaveFields = document.getElementById('btn-save-fields');
  const fieldsStatusEl = document.getElementById('fields-status');

  let discoveredProjects = []; // [{ id, title, org, fields: [{ id, name }] }]

  function sendMessage(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  function showStatus(el, text, type) {
    el.textContent = text;
    el.className = type ? `status status--${type}` : '';
  }

  // --- Load saved settings ---

  chrome.storage.local.get('settings', ({ settings }) => {
    if (settings) {
      patInput.value = settings.pat || '';
    }
  });

  // --- Validate & fetch projects ---

  btnValidate.addEventListener('click', async () => {
    const pat = patInput.value.trim();
    if (!pat) { showStatus(statusEl, 'Please enter a PAT.', 'error'); return; }

    btnValidate.disabled = true;
    showStatus(statusEl, 'Validating...', 'loading');

    try {
      // Validate PAT
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
      });

      if (!resp.ok) {
        showStatus(statusEl, resp.status === 401 ? 'Invalid token.' : `GitHub API error: ${resp.status}`, 'error');
        return;
      }

      // Check scopes — Projects v2 requires classic PAT with repo + project
      const scopes = (resp.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
      if (!scopes.includes('repo') || !scopes.includes('project')) {
        const missing = [];
        if (!scopes.includes('repo')) missing.push('repo');
        if (!scopes.includes('project')) missing.push('project');
        showStatus(statusEl,
          missing.length
            ? `Missing scope(s): ${missing.join(', ')}. Takt requires a classic PAT with repo + project scopes.`
            : 'This appears to be a fine-grained PAT. Takt requires a classic PAT for Projects v2 support.',
          'error');
        return;
      }

      const user = await resp.json();

      // Save PAT + username immediately
      const { settings: existing } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...existing, pat, username: user.login } });

      showStatus(statusEl, `Connected as ${user.login}. Fetching orgs & projects...`, 'loading');

      // Auto-discover orgs and projects
      const result = await sendMessage('FETCH_ALL_PROJECTS', { pat });
      if (!result?.ok) {
        showStatus(statusEl, `Failed to fetch projects: ${result?.error || 'Unknown error'}`, 'error');
        return;
      }

      // Fetch fields for each project
      discoveredProjects = [];
      for (const proj of result.projects) {
        const fieldsResp = await sendMessage('FETCH_PROJECT_FIELDS', { pat, projectId: proj.id });
        discoveredProjects.push({
          id: proj.id,
          title: proj.title,
          org: proj.org,
          fields: fieldsResp?.ok ? fieldsResp.fields : [],
        });
      }

      const orgCount = result.orgs.length;
      const projCount = discoveredProjects.length;
      showStatus(statusEl,
        `Connected as ${user.login}. Found ${projCount} project(s) across ${orgCount} org(s).`,
        'success');

      renderProjectFields();
    } catch (err) {
      showStatus(statusEl, `Error: ${err.message}`, 'error');
    } finally {
      btnValidate.disabled = false;
    }
  });

  // --- Render project field mapping UI ---

  function renderProjectFields() {
    projectsSection.classList.add('visible');

    const allFieldNames = new Set();
    for (const proj of discoveredProjects) {
      for (const f of proj.fields) {
        allFieldNames.add(f.name);
      }
    }

    chrome.storage.local.get('settings', ({ settings }) => {
      const savedDefault = settings?.defaultFieldName || settings?.fieldName || '';
      const savedMappings = settings?.projectFields || {};

      // Default field dropdown
      defaultFieldSelect.innerHTML = '';
      const sortedFields = [...allFieldNames].sort();

      let smartDefault = sortedFields[0] || '';
      for (const name of sortedFields) {
        if (/hour|time/i.test(name)) { smartDefault = name; break; }
      }

      for (const name of sortedFields) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (savedDefault ? name === savedDefault : name === smartDefault) {
          opt.selected = true;
        }
        defaultFieldSelect.appendChild(opt);
      }

      // Per-project rows
      const savedExcluded = settings?.excludedProjects || [];
      projectsList.innerHTML = '';
      for (const proj of discoveredProjects) {
        const row = document.createElement('div');
        row.className = 'project-row';
        row.dataset.project = proj.title;
        const isExcluded = savedExcluded.includes(proj.title);
        if (isExcluded) row.classList.add('project-row--removed');

        const nameDiv = document.createElement('div');
        nameDiv.className = 'project-name';
        nameDiv.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="#656d76" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM6.5 6.5v8h7.75a.25.25 0 0 0 .25-.25V6.5Zm8-1.5V1.75a.25.25 0 0 0-.25-.25H6.5V5Zm-13 1.5v7.75c0 .138.112.25.25.25H5v-8ZM5 5V1.5H1.75a.25.25 0 0 0-.25.25V5Z"/></svg>`;
        nameDiv.appendChild(document.createTextNode(proj.title));
        if (proj.org) {
          const orgBadge = document.createElement('span');
          orgBadge.style.cssText = 'font-size:11px;color:#656d76;margin-left:6px;';
          orgBadge.textContent = proj.org;
          nameDiv.appendChild(orgBadge);
        }

        const select = document.createElement('select');
        select.className = 'project-field-select';
        select.dataset.project = proj.title;

        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Use default';
        select.appendChild(defaultOpt);

        for (const f of proj.fields) {
          const opt = document.createElement('option');
          opt.value = f.name;
          opt.textContent = f.name;
          if (savedMappings[proj.title] === f.name) opt.selected = true;
          select.appendChild(opt);
        }

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'project-remove';
        removeBtn.title = 'Remove project';
        removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
        removeBtn.addEventListener('click', () => {
          row.classList.add('project-row--removed');
          removeBtn.style.display = 'none';
          // Add undo button
          const undoBtn = document.createElement('button');
          undoBtn.className = 'project-undo';
          undoBtn.textContent = 'Undo';
          undoBtn.addEventListener('click', () => {
            row.classList.remove('project-row--removed');
            removeBtn.style.display = '';
            undoBtn.remove();
          });
          row.appendChild(undoBtn);
        });

        // Undo button for already-excluded projects
        if (isExcluded) {
          const undoBtn = document.createElement('button');
          undoBtn.className = 'project-undo';
          undoBtn.textContent = 'Undo';
          undoBtn.addEventListener('click', () => {
            row.classList.remove('project-row--removed');
            removeBtn.style.display = '';
            undoBtn.remove();
          });
          row.appendChild(undoBtn);
        }

        row.appendChild(nameDiv);
        row.appendChild(select);
        row.appendChild(removeBtn);
        projectsList.appendChild(row);
      }
    });
  }

  // --- Save field settings ---

  btnSaveFields.addEventListener('click', async () => {
    btnSaveFields.disabled = true;

    const defaultFieldName = defaultFieldSelect.value;
    const projectFields = {};
    const excludedProjects = [];

    for (const row of projectsList.querySelectorAll('.project-row')) {
      const title = row.dataset.project;
      if (row.classList.contains('project-row--removed')) {
        excludedProjects.push(title);
      } else {
        const sel = row.querySelector('select');
        if (sel?.value) projectFields[title] = sel.value;
      }
    }

    const { settings: existing } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...existing, defaultFieldName, projectFields, excludedProjects, fieldName: undefined },
    });

    showStatus(fieldsStatusEl, 'Saved!', 'success');
    setTimeout(() => showStatus(fieldsStatusEl, '', ''), 3000);
    btnSaveFields.disabled = false;
  });
})();

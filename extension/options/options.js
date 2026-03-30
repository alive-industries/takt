(() => {
  'use strict';

  const patInput = document.getElementById('pat');
  const orgInput = document.getElementById('org');
  const fieldNameInput = document.getElementById('field-name');
  const btnSave = document.getElementById('btn-save');
  const statusEl = document.getElementById('status');

  // --- Load saved settings ---

  chrome.storage.local.get('settings', ({ settings }) => {
    if (settings) {
      patInput.value = settings.pat || '';
      orgInput.value = settings.org || '';
      fieldNameInput.value = settings.fieldName || 'Tracked Time (mins)';
    }
  });

  // --- Save & validate ---

  btnSave.addEventListener('click', async () => {
    const pat = patInput.value.trim();
    const org = orgInput.value.trim();
    const fieldName = fieldNameInput.value.trim();

    if (!pat) {
      showStatus('Please enter a PAT.', 'error');
      return;
    }
    if (!org) {
      showStatus('Please enter an organization.', 'error');
      return;
    }
    if (!fieldName) {
      showStatus('Please enter a field name.', 'error');
      return;
    }

    btnSave.disabled = true;
    showStatus('Validating...', 'loading');

    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
        },
      });

      if (!resp.ok) {
        const msg =
          resp.status === 401
            ? 'Invalid token. Check your PAT.'
            : `GitHub API error: ${resp.status}`;
        showStatus(msg, 'error');
        return;
      }

      // Check scopes
      const scopes = (resp.headers.get('x-oauth-scopes') || '')
        .split(',')
        .map((s) => s.trim());
      const hasRepo = scopes.includes('repo');
      const hasProject = scopes.includes('project');

      if (!hasRepo || !hasProject) {
        const missing = [];
        if (!hasRepo) missing.push('repo');
        if (!hasProject) missing.push('project');
        showStatus(
          `Missing scope(s): ${missing.join(', ')}. Update your PAT.`,
          'error'
        );
        return;
      }

      const user = await resp.json();

      // Save settings
      await chrome.storage.local.set({
        settings: { pat, org, fieldName },
      });

      showStatus(
        `Connected as ${user.login}. Settings saved.`,
        'success'
      );
    } catch (err) {
      showStatus(`Network error: ${err.message}`, 'error');
    } finally {
      btnSave.disabled = false;
    }
  });

  function showStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = `status status--${type}`;
  }
})();

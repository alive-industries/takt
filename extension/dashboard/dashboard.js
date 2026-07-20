(() => {
  'use strict';

  const views = {
    time: { title: 'Time', url: '../mytime/mytime.html' },
    clients: { title: 'Clients', native: true },
    settings: { title: 'Settings', url: '../options/options.html' },
    admin: { title: 'Admin', url: '../admin/admin.html' },
  };
  const frame = document.getElementById('workspace-frame');
  const clientsWorkspace = document.getElementById('clients-workspace');
  const title = document.getElementById('view-title');
  const clientsNav = document.getElementById('clients-nav');
  const adminNav = document.getElementById('admin-nav');
  const clientList = document.getElementById('client-list');
  const clientDetail = document.getElementById('client-detail');
  const newClientForm = document.getElementById('new-client-form');
  let currentUser = null;
  let clients = [];
  let githubProjects = [];
  let selectedClientId = null;
  let clientsLoaded = false;

  function send(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, payload });
  }

  function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = value == null ? '' : String(value);
    return element.innerHTML;
  }

  function toast(message) {
    const element = document.getElementById('dashboard-toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.hidden = true; }, 3200);
  }

  function selectedClient() {
    return clients.find((client) => client.client_id === selectedClientId) || null;
  }

  function renderClientList() {
    if (!clients.length) {
      clientList.innerHTML = '<div class="empty-detail"><p>No clients configured yet.</p></div>';
      return;
    }
    clientList.innerHTML = clients.map((client) => `
      <button class="client-list-item${client.client_id === selectedClientId ? ' is-active' : ''}" data-client="${client.client_id}">
        <div><strong>${escapeHtml(client.name)}</strong><span>${client.projects?.length || 0} GitHub project${client.projects?.length === 1 ? '' : 's'}</span></div>
        <span class="count-badge">${client.repositories?.length || 0}</span>
      </button>
    `).join('');
    clientList.querySelectorAll('[data-client]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedClientId = Number(button.dataset.client);
        renderClientList();
        renderClientDetail();
      });
    });
  }

  function availableProjects() {
    const owned = new Set(
      clients.flatMap((client) => (client.projects || []).map((project) => project.project_id))
    );
    return githubProjects.filter((project) => !owned.has(project.id));
  }

  function renderClientDetail() {
    const client = selectedClient();
    if (!client) {
      clientDetail.innerHTML = '<div class="empty-detail"><div class="empty-icon">◫</div><h2>Select a client</h2><p>Choose a client to manage its GitHub projects and repository mappings.</p></div>';
      return;
    }
    const available = availableProjects();
    const projects = client.projects || [];
    clientDetail.innerHTML = `
      <div class="detail-heading">
        <div><p class="eyebrow">Client</p><h2>${escapeHtml(client.name)}</h2><p>Map GitHub projects first, then attach the repositories used by each project.</p></div>
        <div class="project-picker">
          <select id="github-project-picker">
            <option value="">${available.length ? 'Select a GitHub project…' : 'No unmapped projects available'}</option>
            ${available.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}${project.org ? ` · ${escapeHtml(project.org)}` : ''}</option>`).join('')}
          </select>
          <button class="primary-button" id="add-project-to-client"${available.length ? '' : ' disabled'}>Add project</button>
        </div>
      </div>
      <div class="hierarchy-label">Projects → repositories</div>
      <div class="project-list">
        ${projects.length ? projects.map((project) => `
          <article class="project-card" data-project-card="${escapeHtml(project.project_id)}">
            <div class="project-title"><h3>${escapeHtml(project.title)}</h3><span>${escapeHtml(project.project_id)}</span></div>
            <div class="repo-chips">
              ${(project.repositories || []).length
                ? project.repositories.map((repo) => `<span class="repo-chip">${escapeHtml(repo)}</span>`).join('')
                : '<span class="repo-empty">No repositories mapped yet</span>'}
            </div>
            <div class="repo-mapper">
              <select data-repo-picker="${escapeHtml(project.project_id)}"><option value="">Load GitHub repositories…</option></select>
              <button class="primary-button" data-map-repo="${escapeHtml(project.project_id)}">Add repository</button>
            </div>
          </article>
        `).join('') : '<div class="empty-detail"><div class="empty-icon">◇</div><h2>No projects yet</h2><p>Select a GitHub project above. A project can belong to only one client.</p></div>'}
      </div>
    `;
    document.getElementById('add-project-to-client')?.addEventListener('click', addProject);
    clientDetail.querySelectorAll('[data-repo-picker]').forEach((select) => {
      select.addEventListener('focus', () => loadProjectRepositories(select.dataset.repoPicker));
    });
    clientDetail.querySelectorAll('[data-map-repo]').forEach((button) => {
      button.addEventListener('click', () => addRepository(button.dataset.mapRepo));
    });
  }

  async function loadProjectRepositories(projectId) {
    const select = clientDetail.querySelector(`[data-repo-picker="${CSS.escape(projectId)}"]`);
    if (!select || select.dataset.loaded === 'true') return;
    select.innerHTML = '<option value="">Loading from GitHub…</option>';
    const response = await send('FETCH_PROJECT_REPOS', { projectId });
    const mapped = new Set(selectedClient()?.projects
      ?.find((project) => project.project_id === projectId)?.repositories || []);
    const repositories = (response?.repos || []).filter((repo) => !mapped.has(repo));
    select.innerHTML = '<option value="">Select a GitHub repository…</option>' +
      repositories.map((repo) => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('');
    select.dataset.loaded = 'true';
  }

  async function addProject() {
    const projectId = document.getElementById('github-project-picker').value;
    const project = githubProjects.find((item) => item.id === projectId);
    if (!project) return;
    const response = await send('ADMIN_MAP_CLIENT_PROJECT', {
      clientId: selectedClientId,
      project: { project_id: project.id, title: project.title, org: project.org || null },
    });
    if (!response?.ok) return toast(response?.error?.message || 'Could not map project');
    toast(`${project.title} added to ${selectedClient().name}`);
    await loadClients(true);
  }

  async function addRepository(projectId) {
    const select = clientDetail.querySelector(`[data-repo-picker="${CSS.escape(projectId)}"]`);
    if (!select?.value) return;
    const response = await send('ADMIN_MAP_PROJECT_REPO', {
      clientId: selectedClientId,
      projectId,
      repo: select.value,
    });
    if (!response?.ok) return toast(response?.error?.message || 'Could not map repository');
    toast('Repository mapped and historical entries queued for backfill');
    await loadClients(true);
  }

  async function loadClients(force = false) {
    if (clientsLoaded && !force) return;
    const [clientResponse, storage] = await Promise.all([
      send('LIST_CLIENTS'),
      chrome.storage.local.get('settings'),
    ]);
    clients = clientResponse?.clients || [];
    if (!selectedClientId && clients.length) selectedClientId = clients[0].client_id;
    if (storage.settings?.pat && (!githubProjects.length || force)) {
      const response = await send('FETCH_ALL_PROJECTS', { pat: storage.settings.pat });
      githubProjects = response?.projects || [];
    }
    clientsLoaded = true;
    renderClientList();
    renderClientDetail();
  }

  function showView(name) {
    const view = views[name] || views.time;
    if ((name === 'admin' || name === 'clients') && currentUser?.role !== 'admin') {
      return showView('time');
    }
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.view === name);
    });
    title.textContent = view.title;
    frame.hidden = !!view.native;
    frame.style.display = view.native ? 'none' : 'block';
    clientsWorkspace.hidden = !view.native;
    clientsWorkspace.style.display = view.native ? 'grid' : 'none';
    if (view.native) loadClients();
    else {
      frame.title = `Takt ${view.title}`;
      frame.src = view.url;
    }
    if (window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }

  async function init() {
    const [meResponse, ping, queue] = await Promise.all([
      send('GET_BACKEND_ME'), send('BACKEND_PING'), send('QUEUE_LENGTH'),
    ]);
    if (meResponse?.ok) {
      currentUser = meResponse.me;
      document.getElementById('identity').textContent = currentUser.login;
      document.getElementById('role').textContent = currentUser.role;
      adminNav.hidden = currentUser.role !== 'admin';
      clientsNav.hidden = currentUser.role !== 'admin';
    }
    const online = !!ping?.ok;
    document.getElementById('status-dot').style.background = online ? '#42c88a' : '#ef6b73';
    const pending = queue?.length || 0;
    document.getElementById('sync-pill').textContent = online
      ? (pending ? `${pending} pending` : 'All changes synced') : 'Working offline';
    showView(window.location.hash.slice(1) || 'time');
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => showView(item.dataset.view));
  });
  document.getElementById('new-client-button').addEventListener('click', () => {
    newClientForm.hidden = !newClientForm.hidden;
    if (!newClientForm.hidden) document.getElementById('new-client-name').focus();
  });
  newClientForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('new-client-name');
    const name = input.value.trim();
    if (!name) return;
    const response = await send('ADMIN_CREATE_CLIENT', { name });
    if (!response?.ok) return toast(response?.error?.message || 'Could not create client');
    selectedClientId = response.client.client_id;
    input.value = '';
    newClientForm.hidden = true;
    clientsLoaded = false;
    toast(`${name} created`);
    await loadClients(true);
  });
  window.addEventListener('hashchange', () => showView(window.location.hash.slice(1)));
  init();
})();

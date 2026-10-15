import {
  fetchAllProjects,
  fetchOrgRepos,
  fetchProjectIssues,
  fetchProjectNumberFields,
  fetchRepoProjects,
  fetchUserOrgs,
  TAKT_ORG,
} from '../github-api.js';

export const githubHandlers = {
  FETCH_ALL_PROJECTS: async (payload) => {
    const result = await fetchAllProjects(payload.pat);
    return { ok: true, orgs: result.orgs, projects: result.projects };
  },

  FETCH_PROJECT_FIELDS: async (payload) => {
    const fields = await fetchProjectNumberFields(payload.pat, payload.projectId);
    return { ok: true, fields };
  },

  FETCH_USER_REPOS: async (payload) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat) {
      return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
    }
    const org = payload?.org || TAKT_ORG;
    try {
      const repos = await fetchOrgRepos(settings.pat, org);
      const knownReposByOrg = { ...(settings.knownReposByOrg || {}), [org]: repos };
      const next = { ...settings, knownReposByOrg };
      if (org === TAKT_ORG) next.knownRepos = repos;
      await chrome.storage.local.set({ settings: next });
      return { ok: true, org, repos };
    } catch (err) {
      return { ok: false, error: { code: 'fetch_failed', message: err.message } };
    }
  },

  FETCH_USER_ORGS: async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat) {
      return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
    }
    try {
      const orgs = await fetchUserOrgs(settings.pat);
      await chrome.storage.local.set({
        settings: { ...settings, knownOrgs: orgs },
      });
      return { ok: true, orgs };
    } catch (err) {
      return { ok: false, error: { code: 'fetch_failed', message: err.message } };
    }
  },

  FETCH_REPO_PROJECTS: async (payload) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat) {
      return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
    }
    const repo = payload?.repo;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return { ok: false, error: { code: 'invalid_repo', message: 'Repo must be owner/name.' } };
    }
    const [owner, name] = repo.split('/');
    try {
      const projects = await fetchRepoProjects(settings.pat, owner, name);
      return { ok: true, projects };
    } catch (err) {
      return { ok: false, error: { code: 'fetch_failed', message: err.message } };
    }
  },

  FETCH_PROJECT_ISSUES: async (payload) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat) {
      return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
    }
    const projectId = payload?.projectId;
    const repoFilter = payload?.repo || null;
    if (!projectId) {
      return { ok: false, error: { code: 'invalid_input', message: 'projectId required.' } };
    }
    try {
      const issues = await fetchProjectIssues(settings.pat, projectId, repoFilter);
      return { ok: true, issues };
    } catch (err) {
      return { ok: false, error: { code: 'fetch_failed', message: err.message } };
    }
  },

  FETCH_PROJECT_REPOS: async (payload) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.pat || !payload?.projectId) {
      return { ok: false, error: { code: 'invalid_input', message: 'PAT and project required.' } };
    }
    try {
      const issues = await fetchProjectIssues(settings.pat, payload.projectId);
      return { ok: true, repos: [...new Set(issues.map((issue) => issue.repo))].sort() };
    } catch (err) {
      return { ok: false, error: { code: 'fetch_failed', message: err.message } };
    }
  },
};

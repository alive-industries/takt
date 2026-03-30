const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

// --- GraphQL helper ---

async function graphql(pat, query, variables = {}) {
  const resp = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  }

  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

// --- Discovery queries (used by options page via service worker) ---

export async function fetchUserOrgs(pat) {
  const resp = await fetch('https://api.github.com/user/orgs?per_page=100', {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!resp.ok) throw new Error(`Failed to fetch orgs: ${resp.status}`);
  const orgs = await resp.json();
  return orgs.map((o) => o.login);
}

export async function fetchOrgProjects(pat, org) {
  const data = await graphql(
    pat,
    `query ($org: String!) {
      organization(login: $org) {
        projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { id title }
        }
      }
    }`,
    { org }
  );
  return data.organization.projectsV2.nodes.map((p) => ({ ...p, org }));
}

export async function fetchAllProjects(pat) {
  const orgs = await fetchUserOrgs(pat);
  const allProjects = [];
  for (const org of orgs) {
    try {
      const projects = await fetchOrgProjects(pat, org);
      allProjects.push(...projects);
    } catch (e) {
      // Skip orgs where we lack project access
      console.warn(`[Takt] Skipping org ${org}: ${e.message}`);
    }
  }
  return { orgs, projects: allProjects };
}

export async function fetchProjectNumberFields(pat, projectId) {
  const data = await graphql(
    pat,
    `query ($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
            }
          }
        }
      }
    }`,
    { projectId }
  );
  return data.node.fields.nodes.filter((f) => f.dataType === 'NUMBER');
}

// --- Issue sync queries ---

async function getIssueProjectItems(pat, owner, repo, issueNumber) {
  const data = await graphql(
    pat,
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          projectItems(first: 10) {
            nodes {
              id
              project { id title }
            }
          }
        }
      }
    }`,
    { owner, repo, number: issueNumber }
  );
  return data.repository.issue.projectItems.nodes;
}

async function getProjectField(pat, projectId, fieldName) {
  const data = await graphql(
    pat,
    `query ($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
            }
          }
        }
      }
    }`,
    { projectId }
  );
  return data.node.fields.nodes.find(
    (f) => f.name === fieldName && f.dataType === 'NUMBER'
  );
}

async function getCurrentFieldValue(pat, itemId, fieldName) {
  const data = await graphql(
    pat,
    `query ($itemId: ID!, $fieldName: String!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValueByName(name: $fieldName) {
            ... on ProjectV2ItemFieldNumberValue { number }
          }
        }
      }
    }`,
    { itemId, fieldName }
  );
  return data.node.fieldValueByName?.number || 0;
}

async function updateTrackedTime(pat, projectId, itemId, fieldId, totalMinutes) {
  await graphql(
    pat,
    `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { number: $value }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId, fieldId, value: totalMinutes }
  );
}

// --- Main sync function ---

export async function syncToGitHub(completedSession) {
  const { settings } = await chrome.storage.local.get('settings');

  if (!settings?.pat) {
    return { skipped: true, reason: 'No PAT configured' };
  }

  const { pat } = settings;
  const [owner, repo] = completedSession.repo.split('/');
  const durationHours =
    Math.round((completedSession.durationMs / 3600000) * 4) / 4;

  const projectItems = await getIssueProjectItems(
    pat, owner, repo, completedSession.issueNumber
  );

  if (!projectItems.length) {
    return { skipped: true, reason: 'Issue is not linked to any GitHub Project' };
  }

  const results = [];

  const excluded = settings.excludedProjects || [];

  for (const item of projectItems) {
    const projectId = item.project.id;
    const itemId = item.id;
    const projectTitle = item.project.title;

    // Skip excluded projects
    if (excluded.includes(projectTitle)) {
      results.push({ project: projectTitle, skipped: true, reason: 'Excluded' });
      continue;
    }

    // Resolve field name: per-project override > global default > fallback
    const fieldName = settings.projectFields?.[projectTitle]
      || settings.defaultFieldName
      || settings.fieldName  // backward compat with old single-field setting
      || 'Tracked Time (mins)';

    const field = await getProjectField(pat, projectId, fieldName);
    if (!field) {
      results.push({
        project: projectTitle,
        skipped: true,
        reason: `No "${fieldName}" field found`,
      });
      continue;
    }

    const currentValue = await getCurrentFieldValue(pat, itemId, fieldName);
    const newTotal = Math.round((currentValue + durationHours) * 10) / 10;
    await updateTrackedTime(pat, projectId, itemId, field.id, newTotal);

    results.push({ project: projectTitle, synced: true, minutes: newTotal });
  }

  return { synced: true, results };
}

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

// The single GitHub org whose repos / projects / issues power the My Time
// dropdowns. Matches the server's `TAKT_GITHUB_ORG` (config.py) so the
// backend's auth and the extension's repo list agree on scope.
export const TAKT_ORG = 'alive-industries';

// Fetch repos in the Takt org only — personal repos are deliberately
// excluded so the My Time "Add entry" repo picker matches the time-tracker
// scope. Paginates up to 400 repos.
export async function fetchOrgRepos(pat, org = TAKT_ORG) {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    const data = await graphql(
      pat,
      `query ($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(
            first: 100,
            after: $cursor,
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes { nameWithOwner }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { org, cursor }
    );
    const conn = data.organization.repositories;
    repos.push(...conn.nodes.map((n) => n.nameWithOwner));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return repos;
}

// Back-compat alias. Older callers expect `fetchUserRepos`; we now restrict
// the result to the Takt org regardless of which entry point they use.
export const fetchUserRepos = (pat) => fetchOrgRepos(pat);

// List Projects v2 that this repo is associated with. The repo level
// query covers org projects the repo's been added to and any user-owned
// projects. The "Add entry" cascading dropdown calls this when the user
// picks a repo.
export async function fetchRepoProjects(pat, owner, name) {
  const data = await graphql(
    pat,
    `query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        projectsV2(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { id title number closed }
        }
      }
    }`,
    { owner, name }
  );
  return (data.repository?.projectsV2?.nodes || []).filter((p) => !p.closed);
}

// List issue items in a Project v2. Filters server-side to OPEN issues
// belonging to the target repo so the user doesn't have to scroll past
// issues from sibling repos in the same project. Returns
// [{ number, title, repo, state }].
export async function fetchProjectIssues(pat, projectId, repoFilter = null) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const data = await graphql(
      pat,
      `query ($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              nodes {
                content {
                  __typename
                  ... on Issue {
                    number
                    title
                    state
                    repository { nameWithOwner }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { projectId, cursor }
    );
    const conn = data.node?.items;
    if (!conn) break;
    for (const n of conn.nodes) {
      const c = n.content;
      if (!c || c.__typename !== 'Issue') continue;
      const repo = c.repository.nameWithOwner;
      if (repoFilter && repo !== repoFilter) continue;
      items.push({ number: c.number, title: c.title, repo, state: c.state });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  // Open issues first, then by descending number.
  items.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'OPEN' ? -1 : 1;
    return b.number - a.number;
  });
  return items;
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

// --- Issue comment ---

export async function postTimeComment(pat, owner, repo, issueNumber, durationHours, username) {
  const body = `Tracked **${durationHours} hours** on this issue — @${username} via Takt`;
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Comment failed: ${resp.status} ${resp.statusText}`);
  }
}

// Projects an issue is linked to, minus any the user has excluded. This is
// the project *association* for reporting / the projects lookup table — it is
// deliberately independent of syncIssueTimeToProjects, which only reports a
// project as "synced" when it successfully wrote to a Number field. An issue
// can sit on a project board that has no such field (or a differently-named
// one); we still want the session tagged with that project.
//
// Returns [{ projectId, title }]. Empty for manual entries (issueNumber<=0),
// non-GitHub repos, missing PAT, or on any lookup error (association is
// best-effort and must never block the STOP write).
export async function getLinkedProjects(pat, repo, issueNumber, settings = {}) {
  if (!pat || !issueNumber || issueNumber <= 0) return [];
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return [];
  const [owner, name] = repo.split('/');
  let items;
  try {
    items = await getIssueProjectItems(pat, owner, name, issueNumber);
  } catch (err) {
    console.warn('[Takt] getLinkedProjects failed:', err.message);
    return [];
  }
  const excluded = settings.excludedProjects || [];
  const linked = [];
  for (const item of items) {
    const projectId = item.project.id;
    const title = item.project.title;
    // Exclusions are keyed by stable id (legacy configs used titles).
    if (excluded.includes(projectId) || excluded.includes(title)) continue;
    linked.push({ projectId, title });
  }
  return linked;
}

// --- Project field sync ---
//
// Overwrites (does NOT add to) the configured Number field on every Project
// item the issue is linked to, using `totalHours` supplied by the caller.
// The caller is expected to pull the authoritative total from the Takt
// backend (GET /v1/sessions/totals) so create/update/delete from any device
// all converge on the same value. The old additive flow only handled
// fresh STOPs and silently drifted on edits and deletes.
//
// `issueNumber=0` is the manual-entry "no linked issue" sentinel — bail
// early; there's no project item to write to.
export async function syncIssueTimeToProjects(
  pat, repo, issueNumber, totalHours, settings = {}
) {
  if (!pat) return { skipped: true, reason: 'No PAT configured' };
  if (!issueNumber || issueNumber <= 0) {
    return { skipped: true, reason: 'No linked issue' };
  }
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { skipped: true, reason: 'Not a GitHub repo' };
  }

  const [owner, name] = repo.split('/');
  let projectItems;
  try {
    projectItems = await getIssueProjectItems(pat, owner, name, issueNumber);
  } catch (err) {
    return { error: `Failed to list project items: ${err.message}` };
  }

  if (!projectItems.length) {
    return { skipped: true, reason: 'Issue is not linked to any GitHub Project' };
  }

  // Project config (exclusions + per-project field overrides) is keyed by
  // the stable Projects v2 node id so it survives project renames. Older
  // configs were keyed by title; we accept either to stay backward
  // compatible until the config is re-saved (which migrates it to ids).
  const excluded = settings.excludedProjects || [];
  const projectFields = settings.projectFields || {};
  const results = [];
  // Round to 2 decimals so the GitHub Projects field displays cleanly
  // (it's a Number column, fractional values are fine). The old logic
  // bucketed to the nearest quarter-hour which ate short sessions —
  // a 3-minute STOP would round to 0 and look like the field didn't
  // update at all.
  const rounded = Math.round(totalHours * 100) / 100;

  for (const item of projectItems) {
    const projectId = item.project.id;
    const itemId = item.id;
    const projectTitle = item.project.title;

    if (excluded.includes(projectId) || excluded.includes(projectTitle)) {
      results.push({ project: projectTitle, projectId, skipped: true, reason: 'Excluded' });
      continue;
    }

    const fieldName = projectFields[projectId]
      ?? projectFields[projectTitle] // legacy title-keyed override
      ?? settings.defaultFieldName
      ?? settings.fieldName // legacy single-field setting
      ?? 'Tracked Time (mins)';

    let field;
    try {
      field = await getProjectField(pat, projectId, fieldName);
    } catch (err) {
      results.push({ project: projectTitle, projectId, error: err.message });
      continue;
    }
    if (!field) {
      results.push({
        project: projectTitle,
        projectId,
        skipped: true,
        reason: `No "${fieldName}" field found`,
      });
      continue;
    }

    try {
      await updateTrackedTime(pat, projectId, itemId, field.id, rounded);
      results.push({ project: projectTitle, projectId, synced: true, hours: rounded });
    } catch (err) {
      results.push({ project: projectTitle, projectId, error: err.message });
    }
  }

  return { synced: results.some((r) => r.synced), results };
}

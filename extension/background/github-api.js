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

// --- Queries ---

async function getIssueProjectItems(pat, owner, repo, issueNumber) {
  const data = await graphql(
    pat,
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          projectItems(first: 10) {
            nodes {
              id
              project {
                id
                title
              }
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

  const fields = data.node.fields.nodes;
  return fields.find(
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
            ... on ProjectV2ItemFieldNumberValue {
              number
            }
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

  const { pat, fieldName } = settings;
  const [owner, repo] = completedSession.repo.split('/');
  const durationMinutes =
    Math.round((completedSession.durationMs / 60000) * 10) / 10;

  // 1. Resolve project items for this issue
  const projectItems = await getIssueProjectItems(
    pat,
    owner,
    repo,
    completedSession.issueNumber
  );

  if (!projectItems.length) {
    return { skipped: true, reason: 'Issue is not linked to any GitHub Project' };
  }

  const results = [];

  // 2. Update each project the issue belongs to
  for (const item of projectItems) {
    const projectId = item.project.id;
    const itemId = item.id;

    // Find the tracked time field
    const field = await getProjectField(pat, projectId, fieldName);
    if (!field) {
      results.push({
        project: item.project.title,
        skipped: true,
        reason: `No "${fieldName}" field found`,
      });
      continue;
    }

    // Read current value and accumulate
    const currentValue = await getCurrentFieldValue(pat, itemId, fieldName);
    const newTotal = Math.round((currentValue + durationMinutes) * 10) / 10;

    await updateTrackedTime(pat, projectId, itemId, field.id, newTotal);

    results.push({
      project: item.project.title,
      synced: true,
      minutes: newTotal,
    });
  }

  return { synced: true, results };
}

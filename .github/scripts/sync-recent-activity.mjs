import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = process.env.README_PATH || "README.md";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_REPOSITORIES = Number(process.env.MAX_REPOSITORIES || 100);
const START_MARKER = "<!-- RECENT_ACTIVITY:START -->";
const END_MARKER = "<!-- RECENT_ACTIVITY:END -->";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const PRIVATE_REPO_DESCRIPTIONS = [
  "What lies hidden here? Just wait and see.",
  "Nothing to see here. Move along.",
  "Classified. Eyes only.",
  "Under construction - or maybe just secret.",
  "Some things are better left unsaid.",
  "This repo does not exist. Probably.",
  "You weren't supposed to find this.",
  "The less you know, the better.",
  "404: description not found. Intentionally.",
  "Access denied. (For now.)",
  "If you know, you know.",
  "This looked like a good idea at 2am.",
  "Shh.",
  "Not all secrets are meant to be kept. This one is.",
];

const token = process.env.SYNC_TOKEN;

if (!token) {
  throw new Error("Missing SYNC_TOKEN. A token with private repo access is required.");
}

const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - WINDOW_DAYS);
const fromIso = from.toISOString();

const viewer = await fetchViewer();
const repositories = await fetchCandidateRepositories(fromIso, MAX_REPOSITORIES);

const activity = [];

for (const repository of repositories) {
  const stats = await fetchRepositoryStats({
    authorId: viewer.id,
    fromIso,
    name: repository.name,
    owner: repository.owner,
  });

  if (!stats || stats.commits <= 0) {
    continue;
  }

  activity.push({
    commits: stats.commits,
    description: repository.description,
    isPrivate: repository.isPrivate,
    lastCommitAt: stats.lastCommitAt,
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
  });
}

activity.sort((left, right) => {
  if (right.commits !== left.commits) {
    return right.commits - left.commits;
  }

  if (right.lastCommitAt !== left.lastCommitAt) {
    return right.lastCommitAt.localeCompare(left.lastCommitAt);
  }

  return left.nameWithOwner.localeCompare(right.nameWithOwner);
});

const totalCommits = activity.reduce((sum, repo) => sum + repo.commits, 0);
const privateRepoDescriptions = shuffle([...PRIVATE_REPO_DESCRIPTIONS]);
let privateRepoDescriptionIndex = 0;

const items = activity
  .map((repo) => {
    const projectLabel = repo.isPrivate
      ? "bunizao/private-repo"
      : `<a href="${repo.url}">${escapeHtml(repo.nameWithOwner)}</a>`;
    const description = repo.isPrivate
      ? nextPrivateRepoDescription()
      : formatDescription(repo.description);

    return `  <li><strong>${projectLabel}</strong> — ${escapeHtml(description)}</li>`;
  })
  .join("\n\n");

const renderedSection = [
  START_MARKER,
  "### Recent Activity",
  "",
  `<p><strong>${activity.length} active ${activity.length === 1 ? "project" : "projects"}</strong> in the past ${WINDOW_DAYS} days, with ${totalCommits} total ${totalCommits === 1 ? "commit" : "commits"}.</p>`,
  "",
  ...(items ? ["<ul>", items, "</ul>"] : ["<p>No active projects in this window.</p>"]),
  END_MARKER,
].join("\n");

const readmePath = path.resolve(process.cwd(), README_PATH);
const readme = await readFile(readmePath, "utf8");

if (!readme.includes(START_MARKER) || !readme.includes(END_MARKER)) {
  throw new Error(`README markers not found in ${README_PATH}.`);
}

const nextReadme = readme.replace(
  new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`),
  renderedSection,
);

if (nextReadme !== readme) {
  await writeFile(readmePath, nextReadme);
  console.log(`Updated ${README_PATH} with ${activity.length} active projects.`);
} else {
  console.log(`No README changes for ${README_PATH}.`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDescription(value) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "No public description.";
  }

  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function nextPrivateRepoDescription() {
  const description =
    privateRepoDescriptions[privateRepoDescriptionIndex % privateRepoDescriptions.length];

  privateRepoDescriptionIndex += 1;
  return description;
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }

  return items;
}

async function fetchViewer() {
  const payload = await githubGraphql(`
    query Viewer {
      viewer {
        id
        login
      }
    }
  `);

  const viewer = payload.data?.viewer;

  if (!viewer) {
    throw new Error("GitHub GraphQL response is missing viewer data.");
  }

  return viewer;
}

async function fetchCandidateRepositories(fromIso, maxRepositories) {
  const repositories = [];
  let cursor = null;

  while (repositories.length < maxRepositories) {
    const payload = await githubGraphql(
      `
        query CandidateRepositories($cursor: String) {
          viewer {
            repositories(
              first: 100
              after: $cursor
              affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
              orderBy: { field: PUSHED_AT, direction: DESC }
            ) {
              nodes {
                description
                name
                nameWithOwner
                isPrivate
                pushedAt
                url
                owner {
                  login
                }
                defaultBranchRef {
                  target {
                    __typename
                  }
                }
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      `,
      { cursor },
    );

    const page = payload.data?.viewer?.repositories;

    if (!page) {
      throw new Error("GitHub GraphQL response is missing repository data.");
    }

    const eligible = page.nodes
      .filter((repository) => repository.pushedAt && repository.pushedAt >= fromIso)
      .filter((repository) => repository.defaultBranchRef?.target?.__typename === "Commit")
      .map((repository) => ({
        description: repository.description,
        isPrivate: repository.isPrivate,
        name: repository.name,
        nameWithOwner: repository.nameWithOwner,
        owner: repository.owner.login,
        pushedAt: repository.pushedAt,
        url: repository.url,
      }));

    repositories.push(...eligible);

    const oldestPushedAt = page.nodes.at(-1)?.pushedAt;

    if (!page.pageInfo.hasNextPage || (oldestPushedAt && oldestPushedAt < fromIso)) {
      break;
    }

    cursor = page.pageInfo.endCursor;
  }

  return repositories.slice(0, maxRepositories);
}

async function fetchRepositoryStats({ authorId, fromIso, name, owner }) {
  let payload;

  try {
    payload = await githubGraphql(
      `
        query RepositoryStats($authorId: ID!, $from: GitTimestamp!, $name: String!, $owner: String!) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef {
              target {
                __typename
                ... on Commit {
                  history(first: 1, since: $from, author: { id: $authorId }) {
                    totalCount
                    nodes {
                      committedDate
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        authorId,
        from: fromIso,
        name,
        owner,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Could not resolve to a Repository")) {
      console.warn(`Skipping unavailable repository: ${owner}/${name}`);
      return null;
    }

    throw error;
  }

  const history = payload.data?.repository?.defaultBranchRef?.target?.history;

  if (!history) {
    return null;
  }

  return {
    commits: history.totalCount,
    lastCommitAt: history.nodes[0]?.committedDate || "",
  };
}

async function githubGraphql(query, variables = {}) {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }

  return payload;
}

import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = process.env.README_PATH || "README.md";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_REPOSITORIES = Number(process.env.MAX_REPOSITORIES || 100);
const REPOSITORY_CONCURRENCY = Number(process.env.REPOSITORY_CONCURRENCY || 4);
const COMMIT_DETAIL_CONCURRENCY = Number(process.env.COMMIT_DETAIL_CONCURRENCY || 8);
const ACTIVITY_PANEL_TTL_SECONDS = Number(process.env.ACTIVITY_PANEL_TTL_SECONDS || 28800);
const START_MARKER = "<!-- RECENT_ACTIVITY:START -->";
const END_MARKER = "<!-- RECENT_ACTIVITY:END -->";
const GITHUB_API_URL = "https://api.github.com";
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
const activityPanelSigningSecret = process.env.ACTIVITY_PANEL_SIGNING_SECRET;

if (!token) {
  throw new Error("Missing SYNC_TOKEN. A token with repository read access is required.");
}

if (!activityPanelSigningSecret) {
  throw new Error("Missing ACTIVITY_PANEL_SIGNING_SECRET.");
}

const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - WINDOW_DAYS);

const fromIso = from.toISOString();
const toIso = now.toISOString();
const viewer = await fetchViewer();
const repositories = await fetchCandidateRepositories(fromIso, MAX_REPOSITORIES);
const activity = (
  await mapConcurrent(repositories, REPOSITORY_CONCURRENCY, async (repository) => {
    const stats = await fetchRepositoryStats({
      authorLogin: viewer.login,
      defaultBranch: repository.defaultBranch,
      fromIso,
      name: repository.name,
      owner: repository.owner,
      toIso,
    });

    if (!stats || stats.commits <= 0) {
      return null;
    }

    return {
      additions: stats.additions,
      commits: stats.commits,
      deletions: stats.deletions,
      description: repository.description,
      isPrivate: repository.isPrivate,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
    };
  })
).filter(Boolean);

activity.sort((left, right) => {
  if (right.commits !== left.commits) {
    return right.commits - left.commits;
  }

  return left.nameWithOwner.localeCompare(right.nameWithOwner);
});

const totals = activity.reduce(
  (summary, repository) => ({
    activeProjects: summary.activeProjects + 1,
    additions: summary.additions + repository.additions,
    commits: summary.commits + repository.commits,
    deletions: summary.deletions + repository.deletions,
  }),
  {
    activeProjects: 0,
    additions: 0,
    commits: 0,
    deletions: 0,
  },
);

const totalNet = totals.additions - totals.deletions;
const privateRepoDescriptions = shuffle([...PRIVATE_REPO_DESCRIPTIONS]);
let privateRepoDescriptionIndex = 0;
const hoursInWindow = WINDOW_DAYS * 24;
const linesPerHour = Math.round(totalNet / hoursInWindow);

const panelParams = new URLSearchParams({
  days: String(WINDOW_DAYS),
  projects: formatNumber(totals.activeProjects),
  commits: formatNumber(totals.commits),
  added: formatSigned(totals.additions),
  removed: formatSigned(-totals.deletions),
  net: formatSigned(totalNet),
  lph: formatSigned(linesPerHour),
});
const panelDark = createSignedActivityPanelUrl("dark", panelParams);
const panelLight = createSignedActivityPanelUrl("light", panelParams);
const items = activity
  .map((repository) => {
    const projectLabel = repository.isPrivate
      ? `${viewer.login}/private-repo`
      : `<a href="${repository.url}">${escapeHtml(repository.nameWithOwner)}</a>`;
    const description = repository.isPrivate
      ? nextPrivateRepoDescription()
      : formatDescription(repository.description);

    return `  <li><strong>${projectLabel}</strong> — ${escapeHtml(description)}</li>`;
  })
  .join("\n\n");

const renderedSection = [
  START_MARKER,
  "<picture>",
  `  <source media="(prefers-color-scheme: dark)" srcset="${panelDark}">`,
  `  <source media="(prefers-color-scheme: light)" srcset="${panelLight}">`,
  `  <img height="155" src="${panelDark}" alt="Recent Activity Stats" />`,
  "</picture>",
  "",
  "</div>",
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

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSigned(value) {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
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

function createSignedActivityPanelUrl(theme, baseParams) {
  const expiresAt = Math.floor(Date.now() / 1000) + ACTIVITY_PANEL_TTL_SECONDS;
  const signedParams = new URLSearchParams(baseParams);
  signedParams.set("theme", theme);
  signedParams.set("exp", String(expiresAt));

  const normalizedSearch = new URLSearchParams(
    Array.from(signedParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }

      return leftKey.localeCompare(rightKey);
    })
  ).toString();
  const payload = `/api/activity-panel.svg?${normalizedSearch}`;
  const signature = createHmac("sha256", activityPanelSigningSecret)
    .update(payload)
    .digest("base64url");

  signedParams.set("sig", signature);
  return `https://buxx.me/api/activity-panel.svg?${signedParams.toString()}`;
}

async function fetchViewer() {
  const payload = await githubGraphql(`
    query Viewer {
      viewer {
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
                  name
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
        defaultBranch: repository.defaultBranchRef.name,
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

async function fetchRepositoryStats({ authorLogin, defaultBranch, fromIso, name, owner, toIso }) {
  const commits = await fetchRepositoryCommits({
    authorLogin,
    defaultBranch,
    fromIso,
    name,
    owner,
    toIso,
  });

  if (commits.length === 0) {
    return null;
  }

  let additions = 0;
  let deletions = 0;
  const stats = await mapConcurrent(commits, COMMIT_DETAIL_CONCURRENCY, async (commit) => {
    const details = await githubRest(`/repos/${owner}/${name}/commits/${commit.sha}`);
    return {
      additions: details.stats?.additions || 0,
      deletions: details.stats?.deletions || 0,
    };
  });

  for (const summary of stats) {
    additions += summary.additions;
    deletions += summary.deletions;
  }

  return {
    additions,
    commits: commits.length,
    deletions,
  };
}

async function fetchRepositoryCommits({ authorLogin, defaultBranch, fromIso, name, owner, toIso }) {
  const commits = [];
  let page = 1;

  try {
    while (true) {
      const payload = await githubRest(
        `/repos/${owner}/${name}/commits`,
        new URLSearchParams({
          author: authorLogin,
          page: String(page),
          per_page: "100",
          sha: defaultBranch,
          since: fromIso,
          until: toIso,
        }),
      );

      if (!Array.isArray(payload) || payload.length === 0) {
        break;
      }

      commits.push(...payload);

      if (payload.length < 100) {
        break;
      }

      page += 1;
    }
  } catch (error) {
    if (error instanceof Error && "status" in error && (error.status === 404 || error.status === 409)) {
      console.warn(`Skipping unavailable repository: ${owner}/${name}`);
      return [];
    }

    throw error;
  }

  return commits;
}

async function mapConcurrent(items, limit, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index;

      if (currentIndex >= items.length) {
        return;
      }

      index += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function githubGraphql(query, variables = {}) {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
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

async function githubRest(endpoint, searchParams = new URLSearchParams()) {
  const query = searchParams.toString();
  const url = `${GITHUB_API_URL}${endpoint}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const error = new Error(
      `GitHub REST request failed for ${endpoint}: ${response.status} ${response.statusText}`,
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

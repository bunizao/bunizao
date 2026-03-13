import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = process.env.README_PATH || "README.md";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_REPOSITORIES = Number(process.env.MAX_REPOSITORIES || 100);
const START_MARKER = "<!-- RECENT_ACTIVITY:START -->";
const END_MARKER = "<!-- RECENT_ACTIVITY:END -->";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

const token = process.env.PROFILE_SYNC_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error(
    "Missing PROFILE_SYNC_TOKEN or GITHUB_TOKEN. A PAT is required if you want private repos included.",
  );
}

const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - WINDOW_DAYS);

const query = `
  query RecentActivity($from: DateTime!, $to: DateTime!, $maxRepositories: Int!, $maxDays: Int!) {
    viewer {
      login
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        restrictedContributionsCount
        commitContributionsByRepository(maxRepositories: $maxRepositories) {
          repository {
            nameWithOwner
            url
            isPrivate
          }
          contributions(first: $maxDays) {
            nodes {
              commitCount
              occurredAt
            }
          }
        }
      }
    }
  }
`;

const response = await fetch(GITHUB_GRAPHQL_URL, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    query,
    variables: {
      from: from.toISOString(),
      to: now.toISOString(),
      maxRepositories: MAX_REPOSITORIES,
      maxDays: WINDOW_DAYS,
    },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
}

const viewer = payload.data?.viewer;
const collection = viewer?.contributionsCollection;

if (!viewer || !collection) {
  throw new Error("GitHub GraphQL response is missing contribution data.");
}

const activity = collection.commitContributionsByRepository
  .map(({ repository, contributions }) => {
    const commits = contributions.nodes.reduce((sum, node) => sum + node.commitCount, 0);
    const lastCommitAt = contributions.nodes.reduce((latest, node) => {
      if (!latest || node.occurredAt > latest) {
        return node.occurredAt;
      }

      return latest;
    }, "");

    return {
      commits,
      isPrivate: repository.isPrivate,
      lastCommitAt,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
    };
  })
  .filter((repo) => repo.commits > 0)
  .sort((left, right) => {
    if (right.commits !== left.commits) {
      return right.commits - left.commits;
    }

    if (right.lastCommitAt !== left.lastCommitAt) {
      return right.lastCommitAt.localeCompare(left.lastCommitAt);
    }

    return left.nameWithOwner.localeCompare(right.nameWithOwner);
  });

const totalCommits = activity.reduce((sum, repo) => sum + repo.commits, 0);
let privateIndex = 0;

const rows = activity
  .map((repo) => {
    const label = repo.isPrivate
      ? `Private project ${String(++privateIndex).padStart(2, "0")}`
      : `<a href="${repo.url}">${escapeHtml(repo.nameWithOwner)}</a>`;

    return `  <tr><td>${label}</td><td align="right"><code>${repo.commits} ${repo.commits === 1 ? "commit" : "commits"}</code></td></tr>`;
  })
  .join("\n");

const renderedSection = [
  START_MARKER,
  "### Recent Activity",
  "",
  '<table align="center">',
  "  <tr><td colspan=\"2\" align=\"center\">",
  `    <strong>${activity.length} active ${activity.length === 1 ? "project" : "projects"}</strong><br/>`,
  `    <sub>Past ${WINDOW_DAYS} days · ${totalCommits} total ${totalCommits === 1 ? "commit" : "commits"}</sub>`,
  "  </td></tr>",
  ...(rows ? [rows] : ["  <tr><td colspan=\"2\" align=\"center\"><sub>No commits in this window.</sub></td></tr>"]),
  "</table>",
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

import type { Identity, Repository } from "./types";

const DEMO_IDENTITY: Identity = { id: "demo-user", login: "demo", mode: "demo" };
const DEMO_REPOS: Repository[] = [
  {
    id: "demo-hello-world",
    fullName: "demo/hello-world",
    defaultBranch: "main",
    private: false,
    url: "https://github.com/demo/hello-world",
  },
];

interface GitHubUser { id: number; login: string }
interface GitHubRepo { id: number; full_name: string; default_branch: string; private: boolean; html_url: string }

async function githubFetch(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "ino-cloud-coding-agent",
    },
  });
}

async function checkedGithubFetch(path: string, token: string): Promise<Response> {
  const response = await githubFetch(path, token);
  if (!response.ok) throw new Error(`GitHub rejected the token (${response.status})`);
  return response;
}

export async function getIdentity(token?: string): Promise<Identity> {
  if (!token) return DEMO_IDENTITY;
  const response = await checkedGithubFetch("/user", token);
  const user = await response.json() as GitHubUser;
  return { id: String(user.id), login: user.login, mode: "github" };
}

export async function listRepositories(token?: string): Promise<Repository[]> {
  if (!token) return DEMO_REPOS;
  const response = await checkedGithubFetch("/user/repos?per_page=100&sort=updated", token);
  const repositories = await response.json() as GitHubRepo[];
  return repositories.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    url: repo.html_url,
  }));
}

import { ConfiguredRepo } from '../config/repos.js';

export interface CommitSummary {
  sha: string;
  /** First 7 characters of the sha — what a human actually quotes. */
  short_sha: string;
  author: string;
  date: string;
  message: string;
  url: string;
}

export interface RepoMeta {
  full_name: string;
  description: string | null;
  default_branch: string;
  /** ISO timestamp of the last push. Null when the repo has never been pushed to. */
  last_activity: string | null;
  html_url: string;
  private: boolean;
  archived: boolean;
}

export interface ProjectStatus {
  repo: string;
  alias: string;
  default_branch: string;
  last_commit: CommitSummary | null;
  open_pull_requests: number;
  open_issues: number;
  last_activity: string | null;
  html_url: string;
}

export interface FileContent {
  repo: string;
  path: string;
  /** Branch the content was read from. Null means the repo's default branch. */
  branch: string | null;
  /** UTF-8 text. Binary files are rejected before reaching here. */
  content: string;
  size_bytes: number;
  sha: string;
  html_url: string | null;
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface BranchSummary {
  name: string;
  /** Head commit of the branch. */
  sha: string;
  /** ISO date of the head commit — how "active" the branch is. */
  last_commit_date: string | null;
  is_default: boolean;
}

/**
 * Everything the tools need from GitHub, in one read-only interface.
 * Implemented by OctokitGitHubClient (real API) and MockGitHubClient (tests).
 */
export interface GitHubClient {
  getRepoMeta(target: ConfiguredRepo): Promise<RepoMeta>;
  getProjectStatus(target: ConfiguredRepo): Promise<ProjectStatus>;
  getRecentCommits(target: ConfiguredRepo, limit: number): Promise<CommitSummary[]>;
  /** `ref` is a branch name; omitted means the default branch. */
  getFileContent(target: ConfiguredRepo, path: string, ref?: string): Promise<FileContent>;
  /** Full recursive file listing of one branch, used to expand doc globs. */
  listTree(target: ConfiguredRepo, ref?: string): Promise<TreeEntry[]>;
  /** Branches of the repo, newest commit first. */
  listBranches(target: ConfiguredRepo): Promise<BranchSummary[]>;
}

import { Octokit } from '@octokit/rest';
import { ConfiguredRepo } from '../config/repos.js';
import { NotFoundError, PermissionError, RateLimitError, ValidationError } from '../core/errors.js';
import {
  BranchSummary,
  CommitSummary,
  FileContent,
  GitHubClient,
  ProjectStatus,
  RepoMeta,
  TreeEntry
} from './types.js';

/** Counting stops here — nobody needs an exact number past a hundred open PRs. */
const COUNT_PAGE_SIZE = 100;

/** Refuse to inline anything larger than this through get_file_content. */
const MAX_FILE_BYTES = 400_000;

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'repo-rag-mcp/0.1.0'
    });
  }

  async getRepoMeta(target: ConfiguredRepo): Promise<RepoMeta> {
    const { data } = await this.call(target, () =>
      this.octokit.repos.get({ owner: target.owner, repo: target.repo })
    );

    return {
      full_name: data.full_name,
      description: data.description,
      default_branch: data.default_branch,
      last_activity: data.pushed_at ?? null,
      html_url: data.html_url,
      private: data.private,
      archived: data.archived
    };
  }

  async getProjectStatus(target: ConfiguredRepo): Promise<ProjectStatus> {
    // One round trip each, in parallel: status is the tool called most often.
    const [meta, commits, openPulls, openIssues] = await Promise.all([
      this.getRepoMeta(target),
      this.getRecentCommits(target, 1),
      this.countOpenPulls(target),
      this.countOpenIssues(target)
    ]);

    return {
      repo: meta.full_name,
      alias: target.alias,
      default_branch: meta.default_branch,
      last_commit: commits[0] ?? null,
      open_pull_requests: openPulls,
      open_issues: openIssues,
      last_activity: meta.last_activity,
      html_url: meta.html_url
    };
  }

  async getRecentCommits(target: ConfiguredRepo, limit: number): Promise<CommitSummary[]> {
    const { data } = await this.call(target, () =>
      this.octokit.repos.listCommits({
        owner: target.owner,
        repo: target.repo,
        per_page: Math.min(Math.max(limit, 1), COUNT_PAGE_SIZE)
      })
    );

    return data.map(entry => ({
      sha: entry.sha,
      short_sha: entry.sha.slice(0, 7),
      // commit.author is the git trailer and survives when the GitHub user is gone.
      author: entry.commit.author?.name ?? entry.author?.login ?? 'unknown',
      date: entry.commit.author?.date ?? entry.commit.committer?.date ?? '',
      message: firstLine(entry.commit.message),
      url: entry.html_url
    }));
  }

  async getFileContent(
    target: ConfiguredRepo,
    path: string,
    ref?: string
  ): Promise<FileContent> {
    const cleanPath = normalizePath(path);
    const { data } = await this.call(
      target,
      () =>
        this.octokit.repos.getContent({
          owner: target.owner,
          repo: target.repo,
          path: cleanPath,
          ...(ref ? { ref } : {})
        }),
      ref ? `${cleanPath}@${ref}` : cleanPath
    );

    if (Array.isArray(data)) {
      throw new ValidationError(
        `"${cleanPath}" is a directory in ${target.fullName}, not a file. ` +
          'Pass a full file path.'
      );
    }
    if (data.type !== 'file' || typeof data.content !== 'string') {
      throw new ValidationError(
        `"${cleanPath}" in ${target.fullName} is a ${data.type}, which cannot be read as text.`
      );
    }
    if (data.size > MAX_FILE_BYTES) {
      throw new ValidationError(
        `"${cleanPath}" is ${data.size} bytes, over the ${MAX_FILE_BYTES} byte limit. ` +
          'Use search_project_docs to get the relevant fragments instead.'
      );
    }

    const decoded = Buffer.from(data.content, 'base64');
    if (decoded.includes(0)) {
      throw new ValidationError(
        `"${cleanPath}" in ${target.fullName} looks binary and cannot be returned as text.`
      );
    }

    return {
      repo: target.fullName,
      path: cleanPath,
      branch: ref ?? null,
      content: decoded.toString('utf8'),
      size_bytes: data.size,
      sha: data.sha,
      html_url: data.html_url
    };
  }

  async listTree(target: ConfiguredRepo, ref?: string): Promise<TreeEntry[]> {
    const branch = ref ?? (await this.getRepoMeta(target)).default_branch;
    const { data } = await this.call(
      target,
      () =>
        this.octokit.git.getTree({
          owner: target.owner,
          repo: target.repo,
          tree_sha: branch,
          recursive: 'true'
        }),
      `tree@${branch}`
    );

    // A truncated tree still indexes the files it did return; the alternative is
    // failing the whole refresh over a repo that is simply large.
    if (data.truncated) {
      console.error(
        `[github] tree of ${target.fullName}@${branch} was truncated by the API; ` +
          'some deep files may be missing from the index.'
      );
    }

    return data.tree
      .filter(entry => entry.type === 'blob' && typeof entry.path === 'string')
      .map(entry => ({
        path: entry.path as string,
        sha: entry.sha ?? '',
        size: entry.size ?? 0
      }));
  }

  async listBranches(target: ConfiguredRepo): Promise<BranchSummary[]> {
    const meta = await this.getRepoMeta(target);
    const { data } = await this.call(target, () =>
      this.octokit.repos.listBranches({
        owner: target.owner,
        repo: target.repo,
        per_page: COUNT_PAGE_SIZE
      })
    );

    // listBranches gives no commit date, so each head is dated individually.
    // Bounded by COUNT_PAGE_SIZE and only ever called during a refresh.
    const summaries = await Promise.all(
      data.map(async branch => {
        let date: string | null = null;
        try {
          const { data: commit } = await this.call(target, () =>
            this.octokit.repos.getCommit({
              owner: target.owner,
              repo: target.repo,
              ref: branch.commit.sha
            })
          );
          date = commit.commit.author?.date ?? commit.commit.committer?.date ?? null;
        } catch {
          // An undatable branch simply sorts last; it must not fail the listing.
        }

        return {
          name: branch.name,
          sha: branch.commit.sha,
          last_commit_date: date,
          is_default: branch.name === meta.default_branch
        };
      })
    );

    return summaries.sort(
      (a, b) => Date.parse(b.last_commit_date ?? '') - Date.parse(a.last_commit_date ?? '') || 0
    );
  }

  private async countOpenPulls(target: ConfiguredRepo): Promise<number> {
    const { data } = await this.call(target, () =>
      this.octokit.pulls.list({
        owner: target.owner,
        repo: target.repo,
        state: 'open',
        per_page: COUNT_PAGE_SIZE
      })
    );
    return data.length;
  }

  private async countOpenIssues(target: ConfiguredRepo): Promise<number> {
    const { data } = await this.call(target, () =>
      this.octokit.issues.listForRepo({
        owner: target.owner,
        repo: target.repo,
        state: 'open',
        per_page: COUNT_PAGE_SIZE
      })
    );
    // GitHub models pull requests as issues; only real issues are wanted here.
    return data.filter(entry => entry.pull_request === undefined).length;
  }

  /** Single funnel where every HTTP failure becomes a domain error. */
  private async call<T>(
    target: ConfiguredRepo,
    request: () => Promise<T>,
    path?: string
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw translateGitHubError(error, target, path);
    }
  }
}

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0] ?? '';
  return line.trim();
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '');
  if (trimmed === '') {
    throw new ValidationError('Empty file path.');
  }
  if (trimmed.split('/').includes('..')) {
    throw new ValidationError(`Path "${path}" may not contain "..".`);
  }
  return trimmed;
}

interface HttpErrorShape {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined> };
}

export function translateGitHubError(
  error: unknown,
  target: ConfiguredRepo,
  path?: string
): Error {
  const shaped = error as HttpErrorShape;
  const status = shaped?.status;
  const headers = shaped?.response?.headers ?? {};
  const where = path ? `${target.fullName}/${path}` : target.fullName;

  if (status === 404) {
    return new NotFoundError(
      `Not found on GitHub: ${where}. Either it does not exist, or the token has no ` +
        'access to it. Check the repo name in repos.json and the token repository scope.'
    );
  }

  if (status === 403 || status === 429) {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    if (remaining === '0' || status === 429 || /rate limit/i.test(shaped?.message ?? '')) {
      const resetAt = reset ? new Date(Number(reset) * 1000) : null;
      return new RateLimitError(
        `GitHub rate limit hit while reading ${where}` +
          (resetAt ? `. Quota resets at ${resetAt.toISOString()}.` : '.') +
          ' Retry later, or narrow the request to a single repo.',
        resetAt
      );
    }
    return new PermissionError(
      `The GitHub token is not allowed to read ${where}. The fine-grained token needs ` +
        'Contents, Metadata, Pull requests and Issues set to read, and must list this repo.'
    );
  }

  if (status === 401) {
    return new PermissionError(
      'GitHub rejected the token (401). It is missing, expired or revoked — ' +
        'check GITHUB_TOKEN in .env.'
    );
  }

  if (status === 409) {
    return new NotFoundError(
      `${target.fullName} is empty (no commits yet), so there is nothing to read.`
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

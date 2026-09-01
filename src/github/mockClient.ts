import { ConfiguredRepo } from '../config/repos.js';
import { NotFoundError } from '../core/errors.js';
import {
  BranchSummary,
  CommitSummary,
  FileContent,
  GitHubClient,
  ProjectStatus,
  RepoMeta,
  TreeEntry
} from './types.js';

export interface MockRepoFixture {
  description?: string;
  default_branch?: string;
  last_activity?: string;
  open_pull_requests?: number;
  open_issues?: number;
  commits?: CommitSummary[];
  /** ruta -> texto del archivo en la rama default. Sirve también como listado del árbol. */
  files?: Record<string, string>;
  /**
   * rama -> (ruta -> texto del archivo), para ramas distintas de la default.
   * Una rama que no esté acá no existe, igual que en GitHub.
   */
  branches?: Record<string, { last_commit_date?: string; files: Record<string, string> }>;
}

/**
 * GitHub en memoria. Permite ejercitar las tools, el indexador y los contratos
 * de cada tool sin red, sin token y sin rate limit.
 */
export class MockGitHubClient implements GitHubClient {
  constructor(private readonly fixtures: Record<string, MockRepoFixture> = {}) {}

  async getRepoMeta(target: ConfiguredRepo): Promise<RepoMeta> {
    const fixture = this.fixture(target);
    return {
      full_name: target.fullName,
      description: fixture.description ?? target.description,
      default_branch: fixture.default_branch ?? 'main',
      last_activity: fixture.last_activity ?? '2026-01-15T10:00:00Z',
      html_url: `https://github.com/${target.fullName}`,
      private: true,
      archived: false
    };
  }

  async getProjectStatus(target: ConfiguredRepo): Promise<ProjectStatus> {
    const fixture = this.fixture(target);
    const meta = await this.getRepoMeta(target);
    return {
      repo: meta.full_name,
      alias: target.alias,
      default_branch: meta.default_branch,
      last_commit: fixture.commits?.[0] ?? null,
      open_pull_requests: fixture.open_pull_requests ?? 0,
      open_issues: fixture.open_issues ?? 0,
      last_activity: meta.last_activity,
      html_url: meta.html_url
    };
  }

  async getRecentCommits(target: ConfiguredRepo, limit: number): Promise<CommitSummary[]> {
    return (this.fixture(target).commits ?? []).slice(0, limit);
  }

  async getFileContent(
    target: ConfiguredRepo,
    path: string,
    ref?: string
  ): Promise<FileContent> {
    const content = this.filesOf(target, ref)[path];
    if (content === undefined) {
      throw new NotFoundError(
        `Not found on GitHub: ${target.fullName}/${path}${ref ? ` on branch ${ref}` : ''}.`
      );
    }
    return {
      repo: target.fullName,
      path,
      branch: ref ?? null,
      content,
      size_bytes: Buffer.byteLength(content, 'utf8'),
      sha: `mock-${path}`,
      html_url: `https://github.com/${target.fullName}/blob/${ref ?? 'main'}/${path}`
    };
  }

  async listTree(target: ConfiguredRepo, ref?: string): Promise<TreeEntry[]> {
    return Object.entries(this.filesOf(target, ref)).map(([path, content]) => ({
      path,
      sha: `mock-${path}`,
      size: Buffer.byteLength(content, 'utf8')
    }));
  }

  async listBranches(target: ConfiguredRepo): Promise<BranchSummary[]> {
    const fixture = this.fixture(target);
    const defaultBranch = fixture.default_branch ?? 'main';

    const branches: BranchSummary[] = [
      {
        name: defaultBranch,
        sha: 'mock-head',
        last_commit_date: fixture.last_activity ?? null,
        is_default: true
      }
    ];

    for (const [name, branch] of Object.entries(fixture.branches ?? {})) {
      branches.push({
        name,
        sha: `mock-head-${name}`,
        last_commit_date: branch.last_commit_date ?? null,
        is_default: false
      });
    }

    return branches.sort(
      (a, b) => Date.parse(b.last_commit_date ?? '') - Date.parse(a.last_commit_date ?? '') || 0
    );
  }

  /**
   * Resuelve una rama a su mapa de archivos. Una rama desconocida es un
   * NotFoundError, igual que en GitHub, en vez de caer en silencio a la default.
   */
  private filesOf(target: ConfiguredRepo, ref?: string): Record<string, string> {
    const fixture = this.fixture(target);
    const defaultBranch = fixture.default_branch ?? 'main';

    if (ref === undefined || ref === defaultBranch) return fixture.files ?? {};

    const branch = fixture.branches?.[ref];
    if (branch === undefined) {
      throw new NotFoundError(`Not found on GitHub: branch ${ref} of ${target.fullName}.`);
    }
    return branch.files;
  }

  private fixture(target: ConfiguredRepo): MockRepoFixture {
    return this.fixtures[target.alias] ?? this.fixtures[target.fullName] ?? {};
  }
}

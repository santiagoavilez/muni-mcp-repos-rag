import { ConfiguredRepo } from '../config/repos.js';

export interface CommitSummary {
  sha: string;
  /** Los primeros 7 caracteres del sha: lo que una persona realmente cita. */
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
  /** Timestamp ISO del último push. Null si el repo nunca recibió uno. */
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
  /** Rama de la que se leyó el contenido. Null significa la rama default del repo. */
  branch: string | null;
  /** Texto UTF-8. Los archivos binarios se rechazan antes de llegar acá. */
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
  /** Commit de cabecera de la rama. */
  sha: string;
  /** Fecha ISO del commit de cabecera: qué tan "activa" está la rama. */
  last_commit_date: string | null;
  is_default: boolean;
}

/**
 * Todo lo que las tools necesitan de GitHub, en una sola interfaz de solo lectura.
 * La implementan OctokitGitHubClient (API real) y MockGitHubClient (tests).
 */
export interface GitHubClient {
  getRepoMeta(target: ConfiguredRepo): Promise<RepoMeta>;
  getProjectStatus(target: ConfiguredRepo): Promise<ProjectStatus>;
  getRecentCommits(target: ConfiguredRepo, limit: number): Promise<CommitSummary[]>;
  /** `ref` es un nombre de rama; omitirlo significa la rama default. */
  getFileContent(target: ConfiguredRepo, path: string, ref?: string): Promise<FileContent>;
  /** Listado recursivo completo de archivos de una rama, para expandir los globs de docs. */
  listTree(target: ConfiguredRepo, ref?: string): Promise<TreeEntry[]>;
  /** Ramas del repo, de commit más nuevo a más viejo. */
  listBranches(target: ConfiguredRepo): Promise<BranchSummary[]>;
}

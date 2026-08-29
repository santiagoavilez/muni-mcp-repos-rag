import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { REPOS_CONFIG_PATH } from '../core/paths.js';

/**
 * Doc patterns are either an exact path ("README.md") or a directory glob
 * ("docs/**"), which means "every markdown file under docs/, recursively".
 * Nothing fancier is supported on purpose — see matchesDocPattern.
 */
const docPatternSchema = z.string().min(1);

const repoEntrySchema = z.object({
  alias: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'alias must be lowercase kebab-case'),
  repo: z.string().min(1),
  /** Overrides the top-level org for this repo only. */
  org: z.string().min(1).optional(),
  description: z.string().default(''),
  /** Overrides defaultDocs for this repo only. */
  docs: z.array(docPatternSchema).optional(),
  /** Overrides defaultBranches for this repo only. */
  branches: z.array(z.string().min(1)).optional()
});

const configSchema = z.object({
  org: z.string().min(1),
  defaultDocs: z.array(docPatternSchema).min(1),
  /**
   * team convention: `main` is production and `dev` is the replica. Branches
   * listed here that do not exist in a given repo are skipped silently, so one
   * list works for every repo.
   */
  defaultBranches: z.array(z.string().min(1)).min(1).default(['main', 'dev']),
  /**
   * Also index any branch pushed within this many days, on top of the fixed
   * list. Work in progress lives on feature branches whose docs never reach
   * `main`, and that is exactly what people ask about. 0 disables it.
   */
  activeBranchDays: z.number().int().min(0).max(365).default(0),
  /** Ceiling on how many active branches get indexed per repo, newest first. */
  maxActiveBranches: z.number().int().min(1).max(50).default(5),
  repos: z.array(repoEntrySchema).min(1)
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;

export interface ConfiguredRepo {
  alias: string;
  owner: string;
  repo: string;
  description: string;
  docPatterns: string[];
  /** Branches to index, in priority order. Missing ones are skipped. */
  branches: string[];
  /** "owner/repo" — the canonical key used by the index and every log line. */
  fullName: string;
}

export interface ReposConfig {
  all: ConfiguredRepo[];
  /** Resolves an alias, a bare repo name or "owner/repo". Case-insensitive. */
  resolve(reference: string): ConfiguredRepo;
  /** Days of recent activity that make a branch worth indexing. 0 = disabled. */
  activeBranchDays: number;
  maxActiveBranches: number;
}

const PLACEHOLDER = /REEMPLAZAR/i;

export function loadReposConfig(path: string = REPOS_CONFIG_PATH): ReposConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read repo config at ${path}: ${detail}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid repo config at ${path}: ${issues}`);
  }

  const seen = new Set<string>();
  const all: ConfiguredRepo[] = parsed.data.repos.map(entry => {
    if (seen.has(entry.alias)) {
      throw new Error(`Duplicate alias "${entry.alias}" in ${path}.`);
    }
    seen.add(entry.alias);

    const owner = entry.org ?? parsed.data.org;
    return {
      alias: entry.alias,
      owner,
      repo: entry.repo,
      description: entry.description,
      docPatterns: entry.docs ?? parsed.data.defaultDocs,
      branches: entry.branches ?? parsed.data.defaultBranches,
      fullName: `${owner}/${entry.repo}`
    };
  });

  return {
    all,
    resolve: reference => resolveRepo(all, reference, path),
    activeBranchDays: parsed.data.activeBranchDays,
    maxActiveBranches: parsed.data.maxActiveBranches
  };
}

function resolveRepo(all: ConfiguredRepo[], reference: string, path: string): ConfiguredRepo {
  const needle = reference.trim().toLowerCase();
  if (needle === '') {
    throw new ValidationError('Empty repo reference. Call list_projects to see valid aliases.');
  }

  const match = all.find(
    candidate =>
      candidate.alias.toLowerCase() === needle ||
      candidate.repo.toLowerCase() === needle ||
      candidate.fullName.toLowerCase() === needle
  );
  if (match) return match;

  const known = all.map(candidate => candidate.alias).join(', ');
  throw new ValidationError(
    `Unknown repo "${reference}". Configured aliases: ${known}. ` +
      `Add it to ${path} if it should be tracked, then restart the server.`
  );
}

/** True when the config still holds the shipped placeholders. */
export function hasPlaceholders(config: ReposConfig): boolean {
  return config.all.some(repo => PLACEHOLDER.test(repo.fullName));
}

/**
 * Matches a repo file path against one configured doc pattern.
 *
 *  - "*.md"    every markdown file at the repo ROOT, not recursive
 *  - "docs/**" every markdown file under docs/, recursively
 *  - "**"      every markdown file in the repo, at any depth
 *  - anything else is an exact path
 *
 * "*.md" exists because projects drop design documents at the root under names
 * nobody can predict; "**" is deliberately not the default, since it drags in
 * issue templates and dependency docs and multiplies by the branch count.
 */
export function matchesDocPattern(filePath: string, pattern: string): boolean {
  if (pattern === '**') return isMarkdown(filePath);

  if (pattern === '*.md') return !filePath.includes('/') && isMarkdown(filePath);

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2); // keep the trailing slash
    return filePath.startsWith(prefix) && isMarkdown(filePath);
  }

  return filePath === pattern;
}

/** True when the pattern needs a repo tree listing to be expanded. */
export function isGlobPattern(pattern: string): boolean {
  return pattern === '**' || pattern === '*.md' || pattern.endsWith('/**');
}

export function isMarkdown(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}

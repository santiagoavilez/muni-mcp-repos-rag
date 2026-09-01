import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { REPOS_CONFIG_PATH } from '../core/paths.js';

/**
 * Los patrones de documentos son una ruta exacta ("README.md") o un glob de
 * directorio ("docs/**"), que significa "todo markdown bajo docs/, recursivo".
 * A propósito no se soporta nada más sofisticado; ver matchesDocPattern.
 */
const docPatternSchema = z.string().min(1);

const repoEntrySchema = z.object({
  alias: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'alias must be lowercase kebab-case'),
  repo: z.string().min(1),
  /** Pisa la org global, solo para este repo. */
  org: z.string().min(1).optional(),
  description: z.string().default(''),
  /** Pisa defaultDocs, solo para este repo. */
  docs: z.array(docPatternSchema).optional(),
  /** Pisa defaultBranches, solo para este repo. */
  branches: z.array(z.string().min(1)).optional()
});

const configSchema = z.object({
  org: z.string().min(1),
  defaultDocs: z.array(docPatternSchema).min(1),
  /**
   * Convención del equipo: `main` es producción y `dev` la réplica. Las ramas
   * listadas acá que no existan en un repo dado se saltean en silencio, así una
   * sola lista sirve para todos los repos.
   */
  defaultBranches: z.array(z.string().min(1)).min(1).default(['main', 'dev']),
  /**
   * Además de la lista fija, indexa toda rama con push dentro de esta cantidad
   * de días. El trabajo en curso vive en feature branches cuya documentación
   * nunca llega a `main`, y es justo eso lo que la gente pregunta. 0 lo desactiva.
   */
  activeBranchDays: z.number().int().min(0).max(365).default(0),
  /** Techo de ramas activas indexadas por repo, de la más nueva a la más vieja. */
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
  /** Ramas a indexar, en orden de prioridad. Las que no existen se saltean. */
  branches: string[];
  /** "owner/repo": la clave canónica que usan el índice y cada línea de log. */
  fullName: string;
}

export interface ReposConfig {
  all: ConfiguredRepo[];
  /** Resuelve un alias, un nombre de repo pelado o "owner/repo". No distingue mayúsculas. */
  resolve(reference: string): ConfiguredRepo;
  /** Días de actividad reciente que hacen que valga la pena indexar una rama. 0 = desactivado. */
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

/** True cuando la configuración todavía tiene los placeholders de fábrica. */
export function hasPlaceholders(config: ReposConfig): boolean {
  return config.all.some(repo => PLACEHOLDER.test(repo.fullName));
}

/**
 * Compara la ruta de un archivo del repo contra un patrón de documentos.
 *
 *  - "*.md"    todo markdown en la RAÍZ del repo, no recursivo
 *  - "docs/**" todo markdown bajo docs/, recursivo
 *  - "**"      todo markdown del repo, a cualquier profundidad
 *  - cualquier otra cosa es una ruta exacta
 *
 * "*.md" existe porque los proyectos dejan documentos de diseño en la raíz con
 * nombres que nadie puede predecir; "**" a propósito no es el default, porque
 * arrastra plantillas de issues y docs de dependencias, y todo eso se multiplica
 * por la cantidad de ramas.
 */
export function matchesDocPattern(filePath: string, pattern: string): boolean {
  if (pattern === '**') return isMarkdown(filePath);

  if (pattern === '*.md') return !filePath.includes('/') && isMarkdown(filePath);

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2); // conserva la barra final
    return filePath.startsWith(prefix) && isMarkdown(filePath);
  }

  return filePath === pattern;
}

/** True cuando el patrón necesita listar el árbol del repo para expandirse. */
export function isGlobPattern(pattern: string): boolean {
  return pattern === '**' || pattern === '*.md' || pattern.endsWith('/**');
}

export function isMarkdown(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConfiguredRepo } from '../config/repos.js';
import { ServerContext } from '../context.js';
import { mapWithLimit } from '../core/concurrency.js';
import { ProjectStatus } from '../github/types.js';
import { ok, guard } from './shared.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cuántos repos pueden estar pidiendo su estado al mismo tiempo.
 *
 * getProjectStatus ya dispara CUATRO llamadas a GitHub por repo en paralelo
 * (meta, último commit, pulls abiertos, issues abiertos), así que un fan-out sin
 * límite sobre N repos son 4N requests simultáneos. Los rate limits secundarios
 * de GitHub se disparan por concurrencia, no solo por volumen, así que comparar
 * una docena de repos empezaría a ser frenado justo cuando todo el sentido de la
 * tool es una sola llamada barata. Cuatro repos en vuelo son dieciséis requests:
 * lo bastante rápido para sentirse como una única llamada, lo bastante bajo para
 * quedar cómodamente dentro del límite.
 */
const MAX_REPOS_IN_FLIGHT = 4;

interface ComparedProject extends ProjectStatus {
  /** Días enteros desde el último commit en la rama default hasta `now`. */
  days_since_default_branch_commit: number | null;
  /** Días enteros desde el último push en CUALQUIER rama hasta `now`. */
  days_since_any_activity: number | null;
  /**
   * La brecha entre los dos: hace cuánto que el trabajo viene cayendo en algún
   * lado que no es la rama default. A propósito es un número y no un booleano: el
   * umbral a partir del cual preocupa depende del proyecto, así que la tool
   * reporta el hecho y la descripción le dice al agente cómo leerlo.
   */
  days_of_work_off_default_branch: number | null;
}

interface FailedRepo {
  repo: string;
  error: string;
}

export function registerCompareStatus(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'compare_status',
    {
      title: 'Compare the live status of several repositories',
      description:
        'Returns the current GitHub state of several repositories side by side, sorted by most ' +
        'recent activity: default branch, last commit, open pull requests, open issues, plus ' +
        'how many days have passed since the last commit on the default branch and since the ' +
        'last activity on any branch. This is live data, never the search index, so it is ' +
        'always up to date and never needs refresh_index. Use it for "how are the projects ' +
        'going", "which project is moving", or "compare X and Y" — one call instead of chaining ' +
        'get_project_status N times. Do NOT use it for a single repository: that is ' +
        'get_project_status, which is cheaper and answers the same thing. Do NOT use it to find ' +
        'out which repos exist or what is indexed: that is list_projects. A large ' +
        'days_of_work_off_default_branch means someone is pushing to branches whose work has ' +
        'not reached the default branch yet — the most useful signal when comparing projects. ' +
        'Read-only.',
      inputSchema: {
        repos: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Repository aliases from list_projects (also accepts "owner/repo"). ' +
              'Omit to compare every configured repository.'
          )
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repos }) =>
      guard(async () => {
        // La resolución ocurre antes de cualquier llamada de red, así un alias
        // desconocido se reporta como falla propia en vez de llevarse puesta toda
        // la comparación: normalmente el llamador escribió mal un nombre, no todos.
        const requested = repos ?? context.config.all.map(repo => repo.alias);
        const targets: { reference: string; target: ConfiguredRepo }[] = [];
        const failed: FailedRepo[] = [];

        for (const reference of requested) {
          try {
            targets.push({ reference, target: context.config.resolve(reference) });
          } catch (error) {
            failed.push({ repo: reference, error: describe(error) });
          }
        }

        // Se captura una sola vez, antes de los pedidos, para que todos los
        // "días desde" de la respuesta se midan desde el mismo instante.
        const checkedAt = new Date();
        const now = checkedAt.getTime();

        const outcomes = await mapWithLimit(targets, MAX_REPOS_IN_FLIGHT, async entry => {
          try {
            const status = await context.github.getProjectStatus(entry.target);
            return { project: derive(status, now), failure: null };
          } catch (error) {
            // Un repo inalcanzable no puede tapar el estado de los demás.
            return {
              project: null,
              failure: { repo: entry.reference, error: describe(error) }
            };
          }
        });

        const projects: ComparedProject[] = [];
        for (const outcome of outcomes) {
          if (outcome.project) projects.push(outcome.project);
          else if (outcome.failure) failed.push(outcome.failure);
        }

        // La tool existe para comparar, así que el orden tiene que significar
        // algo: primero los más movidos, y al final los repos sin actividad registrada.
        projects.sort((a, b) => rank(b.last_activity) - rank(a.last_activity));

        return ok({
          // Los "días desde" llevan incorporado el momento de la lectura. Sin
          // esto, una respuesta vieja citada más tarde es indistinguible de una fresca.
          checked_at: checkedAt.toISOString(),
          projects,
          failed,
          summary: {
            requested: requested.length,
            succeeded: projects.length,
            failed: failed.length,
            total_open_pull_requests: projects.reduce(
              (sum, project) => sum + project.open_pull_requests,
              0
            ),
            total_open_issues: projects.reduce((sum, project) => sum + project.open_issues, 0)
          }
        });
      })
  );
}

function derive(status: ProjectStatus, now: number): ComparedProject {
  const sinceCommit = wholeDaysSince(status.last_commit?.date ?? null, now);
  const sinceActivity = wholeDaysSince(status.last_activity, now);

  return {
    ...status,
    days_since_default_branch_commit: sinceCommit,
    days_since_any_activity: sinceActivity,
    days_of_work_off_default_branch:
      sinceCommit === null || sinceActivity === null
        ? null
        : // Acotado: un commit en la rama default más nuevo que el push
          // registrado no es "trabajo negativo fuera de la rama", simplemente es
          // nada. Además el pushed_at de GitHub puede ir unos segundos atrás del commit.
          Math.max(0, sinceCommit - sinceActivity)
  };
}

/**
 * Días enteros desde un timestamp ISO hasta `now`, o null cuando no hay fecha o
 * no se puede parsear. Devolver null en vez de NaN importa: NaN sobrevive a la
 * aritmética en silencio y de todos modos se serializa como `null`, así que una
 * fecha mala le llegaría al agente con el mismo aspecto que una faltante, pero
 * recién después de contaminar cada número derivado de ella.
 *
 * Se exporta para los tests, que son el único lugar donde la diferencia entre
 * null y NaN sigue siendo observable: JSON.stringify aplana los dos a `null`.
 */
export function wholeDaysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}

/** Clave de orden para `last_activity`: la actividad desconocida queda por debajo de cualquier fecha conocida. */
function rank(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

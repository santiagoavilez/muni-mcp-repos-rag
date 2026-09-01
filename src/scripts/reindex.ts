#!/usr/bin/env node
/**
 * Indexador standalone: `pnpm reindex [alias]`.
 *
 * El mismo camino de código que usa refresh_index, corrido desde una terminal
 * para poder construir el primer índice (y ver su progreso) antes de siquiera
 * cablear el cliente MCP.
 */
import { buildContext } from '../context.js';
import { loadEnvFile } from '../core/env.js';

loadEnvFile();

async function main(): Promise<void> {
  const [alias] = process.argv.slice(2);
  const context = buildContext();

  console.log(
    alias
      ? `Indexing "${alias}" with ${context.embeddings.model}...`
      : `Indexing ${context.config.all.length} repositories with ${context.embeddings.model}...`
  );

  const report = await context.indexer.refresh(alias);

  for (const result of report.results) {
    if (result.error) {
      console.error(`  FAIL  ${result.repo}: ${result.error}`);
      continue;
    }

    console.log(`  ${result.repo}: ${result.files} files, ${result.chunks} chunks`);
    for (const branch of result.branches) {
      const tag = branch.active ? ' (active)' : '';
      if (branch.error) {
        console.error(`      FAIL  ${branch.branch}${tag}: ${branch.error}`);
        continue;
      }
      console.log(
        `      OK    ${branch.branch}${tag}: ${branch.files} files, ${branch.chunks} chunks`
      );
      for (const skipped of branch.skipped) console.log(`            skipped ${skipped}`);
    }

    if (result.missing_branches.length > 0) {
      console.log(`      note  branches not in this repo: ${result.missing_branches.join(', ')}`);
    }
    if (result.pruned_branches > 0) {
      console.log(`      note  pruned ${result.pruned_branches} chunks from stale branches`);
    }
  }

  context.store.close();

  const failed = report.results.filter(
    result => result.error !== null || result.branches.some(branch => branch.error !== null)
  ).length;
  if (failed > 0) {
    console.error(`\n${failed} repository(ies) failed. See the messages above.`);
    process.exit(1);
  }
  console.log('\nIndex up to date.');
}

main().catch(error => {
  console.error('Indexing failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

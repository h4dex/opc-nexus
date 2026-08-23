import type { Engine } from './types.js';

const RETIRED_EXECUTION_ENGINE_IDS = new Set([
  'eng-deepseek-harness',
  'eng-deepseek-harness-managed',
  // v39 renamed the built-in runtime from `eng-hermes` to `eng-nexus`.
  // A partially migrated store can still contain this historical row.
  'eng-hermes',
  'eng-zcode',
  'eng-kimi'
]);

/**
 * Retired runtime identities may remain on historical task and employee rows,
 * but they are never a user-facing engine or plugin choice.
 */
export function isRetiredExecutionEngine(engine: Pick<Engine, 'id'>): boolean {
  return RETIRED_EXECUTION_ENGINE_IDS.has(engine.id);
}

/** Engines that may be projected into a user-facing catalog or snapshot. */
export function isQuestVisibleEngine(engine: Pick<Engine, 'id'>): boolean {
  return !isRetiredExecutionEngine(engine);
}

/**
 * Product-facing names for the two built-in runtimes.
 *
 * The database IDs are intentionally stable for task/audit history.  The
 * labels must make the boundary visible: Hermes is the Quest scheduler, while
 * Nexus is only an optional employee Worker and must never look like the
 * current scheduler just because an employee still uses it.
 */
export function engineDisplayName(id: string, storedName?: string | null): string {
  if (id === 'eng-nexus') return 'OPC-Nexus Worker';
  if (id === 'eng-hermes-cli') return 'Hermes Agent CLI Worker';
  return storedName?.trim() || '未命名执行引擎';
}

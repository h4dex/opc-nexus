import { isQuestVisibleEngine } from '@shared/engineVisibility';

type EngineIdentity = { id: string };

/**
 * Retired runtime identities can remain on historical records, but they are
 * never product-level choices or current execution adapters.
 */
export function isUserVisibleEngine(engine: EngineIdentity): boolean {
  return isQuestVisibleEngine(engine);
}

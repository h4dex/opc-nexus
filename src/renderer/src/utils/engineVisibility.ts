import { LEGACY_DSH_ENGINE_ID } from '@shared/types';

type EngineIdentity = { id: string };

/** Compatibility runtimes remain in snapshots so historical records still resolve. */
export function isUserVisibleEngine(engine: EngineIdentity): boolean {
  return engine.id !== LEGACY_DSH_ENGINE_ID;
}

import { DSH_MANAGED_ENGINE_ID, LEGACY_DSH_ENGINE_ID, type Engine } from '@shared/types';

const LOCAL_ENGINE_STATUSES = new Set<Engine['status']>([
  'HEALTHY',
  'SETUP_REQUIRED',
  'AUTH_REQUIRED'
]);

type SelectableEngine = Pick<Engine, 'id' | 'isDefault' | 'status'>;

export function isSelectableLocalEngine(engine: SelectableEngine): boolean {
  return engine.id !== DSH_MANAGED_ENGINE_ID
    && engine.id !== LEGACY_DSH_ENGINE_ID
    && LOCAL_ENGINE_STATUSES.has(engine.status);
}

export function selectDefaultLocalEngineId(engines: readonly SelectableEngine[]): string {
  const eligible = engines.filter(isSelectableLocalEngine);
  return eligible.find((engine) => engine.isDefault)?.id ?? eligible[0]?.id ?? '';
}

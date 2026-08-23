import type { Engine } from '@shared/types';
import { isQuestVisibleEngine } from '@shared/engineVisibility';

const LOCAL_ENGINE_STATUSES = new Set<Engine['status']>([
  'HEALTHY',
  'SETUP_REQUIRED',
  'AUTH_REQUIRED'
]);

type SelectableEngine = Pick<Engine, 'id' | 'isDefault' | 'status'>;

export function isSelectableLocalEngine(engine: SelectableEngine): boolean {
  return isQuestVisibleEngine(engine) && LOCAL_ENGINE_STATUSES.has(engine.status);
}

export function selectDefaultLocalEngineId(engines: readonly SelectableEngine[]): string {
  const eligible = engines.filter(isSelectableLocalEngine);
  return eligible.find((engine) => engine.isDefault)?.id ?? eligible[0]?.id ?? '';
}

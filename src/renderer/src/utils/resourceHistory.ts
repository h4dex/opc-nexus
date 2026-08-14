import type { ResourceSample, ServiceHealth } from '../../../shared/types';

export const MAX_RESOURCE_HISTORY = 300;

export interface ResourceState {
  history: ResourceSample[];
  health: ServiceHealth;
}

export interface ResourceUpdate {
  sample: ResourceSample;
  health: ServiceHealth;
}

export function appendResourceUpdate(current: ResourceState, update: ResourceUpdate): ResourceState {
  const last = current.history[current.history.length - 1];
  const history = last?.timestamp === update.sample.timestamp
    ? [...current.history.slice(0, -1), update.sample]
    : [...current.history, update.sample];

  return {
    history: history.slice(-MAX_RESOURCE_HISTORY),
    health: update.health
  };
}

export function mergeResourceHistory(initial: ResourceState, live: ResourceState): ResourceState {
  const samples = new Map<number, ResourceSample>();
  for (const sample of initial.history) samples.set(sample.timestamp, sample);
  for (const sample of live.history) samples.set(sample.timestamp, sample);
  return {
    history: [...samples.values()]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_RESOURCE_HISTORY),
    health: live.history.length > 0 ? live.health : initial.health
  };
}

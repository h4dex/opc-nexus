import type { ControlKernel, DispatchPlanDraft, KernelRequest } from './types.js';

/**
 * Compatibility guard for non-Quest ingress. Real Hermes planning runs inside
 * the project-scoped Hermes service. This kernel exists only so an old caller
 * cannot silently promote an execution adapter into the scheduler slot.
 */
export class HermesIngressKernel implements ControlKernel {
  readonly id = 'hermes' as const;

  isReady(): boolean {
    return false;
  }

  async plan(_request: KernelRequest): Promise<DispatchPlanDraft> {
    throw new Error('HERMES_PROJECT_REQUIRED: complex planning must enter the Quest Hermes project conversation');
  }
}

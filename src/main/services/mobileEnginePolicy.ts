import type { AgentKind } from '../../shared/types.js';

export const ANDROID_OPERATOR_ENGINE_ID = 'eng-hermes-cli';

export function androidOperatorEngineError(kind: AgentKind, engineId: string): string | null {
  if (kind !== 'android_operator' || engineId === ANDROID_OPERATOR_ENGINE_ID) return null;
  return `Android 手机操作员仅支持 Hermes Agent CLI（${ANDROID_OPERATOR_ENGINE_ID}）；当前配置为 ${engineId}。DeepSeek Harness 和其他执行引擎目前没有 Android 工具桥接。`;
}

export function assertAndroidOperatorEngine(kind: AgentKind, engineId: string): void {
  const error = androidOperatorEngineError(kind, engineId);
  if (error) throw new Error(error);
}

export function androidOperatorRuntimeUnavailableError(): string {
  return 'Android 手机操作员所需的 Hermes Agent CLI 当前不可用。手机任务不会降级到 DeepSeek Harness 或其他执行引擎，因为这些 Runtime 目前没有 Android 工具桥接。';
}

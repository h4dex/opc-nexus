import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnvironmentDiagnosticsView } from '@shared/types';
import { IconAlert, IconCheck, IconRefresh } from '../components/icons';
import { toast } from '../components/Toast';

interface ProviderItem {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  hasKey: boolean;
}

export interface QuestRuntimeSetupProps {
  workerCount: number;
  onRetry: () => void;
}

const NEW_PROVIDER = '__new__';

export function QuestRuntimeSetup({ workerCount, onRetry }: QuestRuntimeSetupProps) {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [selectedId, setSelectedId] = useState(NEW_PROVIDER);
  const [name, setName] = useState('DeepSeek');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [diagnostics, setDiagnostics] = useState<EnvironmentDiagnosticsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testPassed, setTestPassed] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const selectedIdRef = useRef(NEW_PROVIDER);
  const selectionInitializedRef = useRef(false);

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  );

  const applyProvider = useCallback((provider: ProviderItem | null) => {
    setName(provider?.name ?? 'DeepSeek');
    setBaseUrl(provider?.baseUrl ?? 'https://api.deepseek.com/v1');
    setModel(provider?.model ?? 'deepseek-chat');
    setApiKey('');
    setModels([]);
    setTestResult(null);
    setTestPassed(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProviders, nextDiagnostics] = await Promise.all([
        window.aibox.listProviders(),
        window.aibox.getEnvironmentDiagnostics()
      ]);
      setProviders(nextProviders);
      setDiagnostics(nextDiagnostics);
      const preferred = nextProviders.find((provider) => provider.isDefault) ?? nextProviders[0] ?? null;
      const current = selectedIdRef.current;
      const nextSelected = selectionInitializedRef.current
        ? (current === NEW_PROVIDER ? null : nextProviders.find((provider) => provider.id === current) ?? preferred)
        : preferred;
      selectionInitializedRef.current = true;
      selectedIdRef.current = nextSelected?.id ?? NEW_PROVIDER;
      setSelectedId(selectedIdRef.current);
      applyProvider(nextSelected);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取 Quest 运行环境');
    } finally {
      setLoading(false);
    }
  }, [applyProvider]);

  useEffect(() => { void load(); }, [load]);

  const changeProvider = (id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    applyProvider(id === NEW_PROVIDER ? null : providers.find((provider) => provider.id === id) ?? null);
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) {
      setError('Provider 名称、Base URL 和模型不能为空');
      return;
    }
    if (selectedId === NEW_PROVIDER && !apiKey.trim()) {
      setError('新 Provider 需要 API Key');
      return;
    }
    setBusy(true);
    setError(null);
    setTestResult(null);
    setTestPassed(false);
    try {
      let providerId: string;
      if (selected) {
        await window.aibox.updateProvider(selected.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
          isDefault: true
        });
        providerId = selected.id;
      } else {
        const created = await window.aibox.createProvider({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim(),
          isDefault: true
        });
        providerId = created.id;
      }
      await window.aibox.detectEngines();
      const verification = await window.aibox.testProviderById(providerId);
      setTestResult(verification.ok ? `连接正常 · ${verification.latencyMs}ms` : verification.error ?? '连接失败');
      setTestPassed(verification.ok);
      if (!verification.ok) {
        setError(`配置已保存，但模型验证失败：${verification.error ?? '未知错误'}`);
        return;
      }
      toast.ok('Quest 模型连接已验证');
      selectionInitializedRef.current = false;
      await load();
      onRetry();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Provider 保存失败');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    setTestPassed(false);
    try {
      const result = await window.aibox.testProviderById(selected.id);
      setTestResult(result.ok ? `连接正常 · ${result.latencyMs}ms` : result.error ?? '连接失败');
      setTestPassed(result.ok);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Provider 测试失败');
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    if (!selected) return;
    setFetchingModels(true);
    setError(null);
    try {
      const result = await window.aibox.fetchProviderModels(selected.id);
      if (!result.ok) {
        setError(`模型列表读取失败：${result.error ?? '上游未返回可用模型'}`);
        return;
      }
      if (result.models.length === 0) {
        setError('模型列表读取成功，但上游返回了空列表');
        return;
      }
      setModels(result.models);
      toast.ok(`已读取 ${result.models.length} 个上游模型`);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '模型列表读取失败');
    } finally {
      setFetchingModels(false);
    }
  };

  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.aibox.detectEngines();
      await load();
      onRetry();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : '运行环境检测失败');
    } finally {
      setBusy(false);
    }
  };

  const requiredMissing = diagnostics?.components.filter((component) => component.required && !component.ready) ?? [];

  return (
    <aside className="quest-runtime-setup" aria-label="Quest 连接设置">
      <div className="quest-runtime-setup-head">
        <div><strong>连接设置</strong><span>Hermes 与模型 Provider</span></div>
        <button type="button" disabled={busy} onClick={() => void repair()} title="重新检测并连接" aria-label="重新检测并连接">
          <IconRefresh size={14} />
        </button>
      </div>
      <div className="quest-runtime-setup-scroll" aria-busy={loading || busy}>
        <section className="quest-runtime-status">
          <span data-ready={diagnostics?.ready === true}><i />环境 {diagnostics?.ready ? '就绪' : '需检查'}</span>
          <span data-ready><i />Hermes 调度 已启用</span>
          <span data-ready={workerCount > 0}><i />执行员工 {workerCount} 名</span>
        </section>

        {error && <div className="quest-runtime-error"><IconAlert size={13} />{error}</div>}
        {requiredMissing.length > 0 && (
          <div className="quest-runtime-warning">
            <IconAlert size={13} />
            <span>{requiredMissing.map((component) => component.name).join('、')} 尚未就绪</span>
          </div>
        )}

        <section className="quest-runtime-provider">
          <header><span>模型 Provider</span><b>{providers.length} 个连接</b></header>
          <label>
            <span>配置</span>
            <select value={selectedId} onChange={(event) => changeProvider(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}{provider.isDefault ? ' · 默认' : ''}</option>
              ))}
              <option value={NEW_PROVIDER}>新增 Provider</option>
            </select>
          </label>
          <label><span>名称</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Base URL</span><input value={baseUrl} maxLength={500} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label><span>模型</span><input value={model} list="quest-provider-models" maxLength={160} onChange={(event) => setModel(event.target.value)} /></label>
          <datalist id="quest-provider-models">{models.map((item) => <option key={item} value={item} />)}</datalist>
          <label>
            <span>API Key{selected?.hasKey ? ' · 已安全保存' : ''}</span>
            <input
              type="password"
              value={apiKey}
              maxLength={1000}
              autoComplete="new-password"
              placeholder={selected?.hasKey ? '留空则保持原 Key' : '输入 API Key'}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {testResult && <p className="quest-runtime-test" data-ready={testPassed}><IconCheck size={12} />{testResult}</p>}
          <div className="quest-runtime-actions">
            <button className="btn small" type="button" disabled={busy || fetchingModels || !selected} onClick={() => void fetchModels()}>{fetchingModels ? '读取中…' : '读取模型'}</button>
            <button className="btn small" type="button" disabled={busy || !selected} onClick={() => void test()}>测试</button>
            <button className="btn small primary" type="button" disabled={busy || loading} onClick={() => void save()}>{busy ? '处理中…' : '保存并连接'}</button>
          </div>
        </section>
      </div>
    </aside>
  );
}

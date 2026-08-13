import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MobileAdbDevice,
  MobileApkInfo,
  MobileArtifact,
  MobileCommandLog,
  MobileDevice,
  MobileGatewayStatus,
  MobilePairingOffer,
  MobileScriptDefinition,
  MobileScriptStep,
  MobileToolCatalog,
  MobileToolName
} from '@shared/types';
import { Modal, formatBytes } from '../components/common';
import { toast } from '../components/Toast';
import {
  IconChevronLeft,
  IconCopy,
  IconDownload,
  IconHome,
  IconLayers,
  IconPhone,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconStop,
  IconTrash,
  IconUpload
} from '../components/icons';

type ViewKey = 'control' | 'scripts' | 'logs' | 'media' | 'install';

const VIEW_LABELS: { key: ViewKey; label: string }[] = [
  { key: 'control', label: '控制' },
  { key: 'scripts', label: '脚本' },
  { key: 'logs', label: '日志' },
  { key: 'media', label: '媒体' },
  { key: 'install', label: '安装' }
];

const PERMISSION_LABEL: Record<string, string> = {
  accessibility: '无障碍', screen_capture: '屏幕读取', media_projection: '屏幕投影', notification_access: '通知',
  location: '定位', contacts: '联系人', sms: '短信', phone: '电话', microphone: '麦克风', clipboard: '剪贴板', tts: '语音合成'
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function statusTag(status: string): string {
  if (['online', 'completed', 'device'].includes(status)) return 'green';
  if (['busy', 'running', 'queued'].includes(status)) return 'orange';
  if (['failed', 'error', 'permission_denied', 'restricted', 'offline', 'unauthorized'].includes(status)) return 'red';
  return 'gray';
}

export function Mobile() {
  const [gateway, setGateway] = useState<MobileGatewayStatus | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(18765);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [catalog, setCatalog] = useState<MobileToolCatalog | null>(null);
  const [view, setView] = useState<ViewKey>('control');
  const [pairing, setPairing] = useState<MobilePairingOffer | null>(null);
  const [busy, setBusy] = useState('');
  const [previewUri, setPreviewUri] = useState('');
  const [tree, setTree] = useState<Record<string, unknown> | null>(null);
  const [commands, setCommands] = useState<MobileCommandLog[]>([]);
  const [artifacts, setArtifacts] = useState<MobileArtifact[]>([]);
  const [scripts, setScripts] = useState<MobileScriptDefinition[]>([]);
  const [scriptEditor, setScriptEditor] = useState<MobileScriptDefinition | 'new' | null>(null);
  const [typeText, setTypeText] = useState('');
  const [packageName, setPackageName] = useState('');
  const [apk, setApk] = useState<MobileApkInfo | null>(null);
  const [adbDevices, setAdbDevices] = useState<MobileAdbDevice[]>([]);
  const observationInFlight = useRef(false);
  const activityInFlight = useRef(false);
  const activityPending = useRef<{ deviceId?: string; includeScripts: boolean } | null>(null);
  const activityTimer = useRef<number | null>(null);
  const treeSignature = useRef('');

  const selected = devices.find((device) => device.id === selectedId) ?? null;
  const readOnly = !selected || selected.status !== 'online';

  const loadGateway = useCallback(async () => {
    const [status, lan] = await Promise.all([window.aibox.getMobileStatus(), window.aibox.listMobileLanAddresses()]);
    setGateway(status);
    setAddresses(lan);
    setHost((current) => current || status.host || lan[0] || '');
    if (status.wssPort) setPort(status.wssPort);
  }, []);

  const loadDevices = useCallback(async () => {
    const next = await window.aibox.listMobileDevices();
    setDevices(next);
    setSelectedId((current) => current && next.some((device) => device.id === current) ? current : next[0]?.id ?? '');
  }, []);

  const loadActivity = useCallback(async (deviceId?: string, includeScripts = false) => {
    if (activityInFlight.current) {
      const pending = activityPending.current;
      activityPending.current = {
        deviceId: deviceId ?? pending?.deviceId,
        includeScripts: includeScripts || pending?.includeScripts === true
      };
      return;
    }
    activityInFlight.current = true;
    try {
      const activity = await Promise.all([
        window.aibox.listMobileCommands(deviceId),
        window.aibox.listMobileArtifacts(deviceId)
      ]);
      setCommands(activity[0]);
      setArtifacts(activity[1]);
      if (includeScripts) setScripts(await window.aibox.listMobileScripts());
    } finally {
      activityInFlight.current = false;
      const pending = activityPending.current;
      activityPending.current = null;
      if (pending) void loadActivity(pending.deviceId, pending.includeScripts).catch(() => {});
    }
  }, []);

  const loadScripts = useCallback(async () => {
    setScripts(await window.aibox.listMobileScripts());
  }, []);

  const scheduleActivityRefresh = useCallback((deviceId?: string) => {
    if (activityTimer.current !== null) window.clearTimeout(activityTimer.current);
    activityTimer.current = window.setTimeout(() => {
      activityTimer.current = null;
      void loadActivity(deviceId).catch(() => {});
    }, 600);
  }, [loadActivity]);

  useEffect(() => {
    void Promise.all([loadGateway(), loadDevices(), window.aibox.getMobileToolCatalog().then(setCatalog)])
      .catch((error) => toast.err(errorText(error, '手机控制台加载失败')));
    return window.aibox.onMobileEvent((event) => {
      if (event.type.startsWith('gateway_')) void loadGateway();
      if (event.type.startsWith('device_') || event.type === 'binding_changed' || event.type.startsWith('session_')) void loadDevices();
      if (event.type.startsWith('command_') || event.type === 'artifact_created') scheduleActivityRefresh(event.deviceId || undefined);
    });
  }, [loadDevices, loadGateway, scheduleActivityRefresh]);

  useEffect(() => {
    setPreviewUri('');
    setTree(null);
    treeSignature.current = '';
    if (selectedId) void loadActivity(selectedId, true).catch((error) => toast.err(errorText(error, '活动记录加载失败')));
  }, [loadActivity, selectedId]);

  useEffect(() => {
    if (selected?.status === 'online') return;
    setPreviewUri('');
    setTree(null);
    treeSignature.current = '';
  }, [selected?.status]);

  const refreshObservation = useCallback(async (notifyError = true) => {
    if (!selectedId || observationInFlight.current) return;
    const deviceId = selectedId;
    observationInFlight.current = true;
    try {
      const [uri, nextTree] = await Promise.all([
        window.aibox.refreshMobilePreview(deviceId),
        window.aibox.readMobileUiTree(deviceId)
      ]);
      if (deviceId !== selectedId) return;
      setPreviewUri((current) => current === uri ? current : uri);
      const signature = typeof nextTree.hash === 'string'
        ? nextTree.hash
        : `${String(nextTree.count ?? '')}:${JSON.stringify(nextTree).length}`;
      if (signature !== treeSignature.current) {
        treeSignature.current = signature;
        setTree(nextTree);
      }
    } catch (error) {
      if (notifyError) toast.err(errorText(error, '无法读取手机界面'));
    } finally {
      observationInFlight.current = false;
    }
  }, [selectedId]);

  useEffect(() => {
    if (view !== 'control' || !selected || selected.status !== 'online') return;
    void refreshObservation(false);
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshObservation(false);
    }, 1_800);
    return () => window.clearInterval(refreshTimer);
  }, [refreshObservation, selected, view]);

  useEffect(() => () => {
    if (activityTimer.current !== null) window.clearTimeout(activityTimer.current);
  }, []);

  const runTool = useCallback(async (toolName: MobileToolName, args: Record<string, unknown> = {}) => {
    if (!selectedId || readOnly) return;
    setBusy(toolName);
    try {
      await window.aibox.executeMobileTool({ deviceId: selectedId, toolName, args });
      await Promise.all([refreshObservation(false), loadActivity(selectedId)]);
    } catch (error) {
      toast.err(errorText(error, `${toolName} 执行失败`));
    } finally {
      setBusy('');
    }
  }, [loadActivity, readOnly, refreshObservation, selectedId]);

  const startGateway = async () => {
    if (!host) return toast.err('请选择局域网 IPv4 地址');
    setBusy('gateway');
    try {
      setGateway(await window.aibox.startMobileGateway(host, port));
      toast.ok('Mobile Gateway 已启动');
    } catch (error) { toast.err(errorText(error, 'Gateway 启动失败')); }
    finally { setBusy(''); }
  };

  const createPairing = async () => {
    setBusy('pairing');
    try { setPairing(await window.aibox.createMobilePairing()); }
    catch (error) { toast.err(errorText(error, '配对码生成失败')); }
    finally { setBusy(''); }
  };

  const refreshInstall = async () => {
    setBusy('adb');
    try {
      const [nextApk, nextDevices] = await Promise.all([window.aibox.getMobileApkInfo(), window.aibox.listMobileAdbDevices()]);
      setApk(nextApk);
      setAdbDevices(nextDevices);
    } catch (error) { toast.err(errorText(error, 'ADB 检测失败')); }
    finally { setBusy(''); }
  };

  useEffect(() => { if (view === 'install') void refreshInstall(); }, [view]);

  return (
    <div className="mobile-page">
      <div className="page-head">
        <h2>手机控制台</h2>
        <span className="desc">{devices.length} 台设备 · 协议 v{catalog?.protocolVersion ?? '-'}</span>
        <div className="right">
          {gateway?.running
            ? <button className="btn danger" disabled={busy === 'gateway'} onClick={() => void window.aibox.stopMobileGateway().then(loadGateway)}><IconStop size={14} />停止网关</button>
            : <button className="btn primary" disabled={busy === 'gateway' || !host} onClick={() => void startGateway()}><IconPlay size={14} />启动网关</button>}
          <button className="btn" disabled={!gateway?.running || busy === 'pairing'} onClick={() => void createPairing()}><IconPlus size={14} />配对手机</button>
        </div>
      </div>

      <div className="mobile-gateway-bar">
        <span className={`dot ${gateway?.running ? 'green' : 'gray'}`} />
        <select aria-label="局域网地址" value={host} disabled={gateway?.running} onChange={(event) => setHost(event.target.value)}>
          {addresses.length === 0 && <option value="">未发现 RFC1918 地址</option>}
          {addresses.map((address) => <option key={address} value={address}>{address}</option>)}
        </select>
        <input aria-label="网关端口" type="number" min={1024} max={65535} value={port} disabled={gateway?.running} onChange={(event) => setPort(Number(event.target.value))} />
        <span className="mobile-gateway-endpoint">{gateway?.running ? `wss://${gateway.host}:${gateway.wssPort}/v1/device` : '网关未运行'}</span>
        {gateway?.certificateFingerprint && <span className="mobile-fingerprint" title={gateway.certificateFingerprint}>{gateway.certificateFingerprint}</span>}
      </div>

      <div className="mobile-workspace">
        <aside className="mobile-device-rail">
          <div className="mobile-section-label">设备</div>
          {devices.map((device) => (
            <button key={device.id} className={`mobile-device-item ${device.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(device.id)}>
              <span className={`dot ${statusTag(device.status)}`} />
              <span className="mobile-device-copy">
                <b>{device.name || device.model}</b>
                <small>{device.model} · Android {device.androidVersion}</small>
              </span>
              {device.status === 'busy' && <span className="tag orange">任务中</span>}
            </button>
          ))}
          {devices.length === 0 && <div className="mobile-empty-rail"><IconPhone size={30} /><span>暂无已配对设备</span></div>}
          {selected && (
            <div className="mobile-device-meta">
              <div><span>地址</span><b>{selected.lastIp ?? '-'}</b></div>
              <div><span>API</span><b>{selected.apiLevel}</b></div>
              <div><span>Bridge</span><b>{selected.appVersion}</b></div>
              <div><span>员工</span><b>{selected.boundAgentId ? selected.boundAgentId.slice(0, 8) : '未绑定'}</b></div>
            </div>
          )}
        </aside>

        <section className="mobile-main-stage">
          <div className="mobile-view-tabs" role="tablist">
            {VIEW_LABELS.map((item) => <button role="tab" aria-selected={view === item.key} key={item.key} className={view === item.key ? 'active' : ''} onClick={() => setView(item.key)}>{item.label}</button>)}
          </div>
          {view === 'control' && <ControlView
            device={selected} previewUri={previewUri} tree={tree} disabled={readOnly || !!busy}
            typeText={typeText} setTypeText={setTypeText} packageName={packageName} setPackageName={setPackageName}
            refresh={() => void refreshObservation()} runTool={runTool}
          />}
          {view === 'scripts' && <ScriptsView
            scripts={scripts} device={selected} disabled={readOnly || !!busy}
            onNew={() => setScriptEditor('new')} onEdit={setScriptEditor}
            onRun={async (id) => {
              setBusy(`script:${id}`);
              try { const result = await window.aibox.runMobileScript(id); toast.ok(`脚本完成 ${result.completed} 步`); await loadActivity(selectedId, true); }
              catch (error) { toast.err(errorText(error, '脚本执行失败')); }
              finally { setBusy(''); }
            }}
            onDelete={async (id) => { await window.aibox.deleteMobileScript(id); await loadScripts(); }}
          />}
          {view === 'logs' && <LogsView commands={commands} />}
          {view === 'media' && <MediaView artifacts={artifacts} />}
          {view === 'install' && <InstallView apk={apk} devices={adbDevices} busy={busy === 'adb'} onRefresh={() => void refreshInstall()} onInstall={async (serial) => {
            setBusy('adb');
            try { const result = await window.aibox.installMobileApk(serial); toast.ok(result.message); }
            catch (error) { toast.err(errorText(error, 'APK 安装失败')); }
            finally { setBusy(''); }
          }} onExport={async () => {
            try { const result = await window.aibox.exportMobileApk(); if (result.ok) toast.ok(result.message); }
            catch (error) { toast.err(errorText(error, 'APK 导出失败')); }
          }} />}
        </section>

        <aside className="mobile-permission-rail">
          <div className="mobile-section-label">权限</div>
          {selected ? Object.entries(PERMISSION_LABEL).map(([key, label]) => {
            const value = selected.permissions[key as keyof typeof selected.permissions] ?? 'unknown';
            return <div key={key} className="mobile-permission-row"><span>{label}</span><span className={`tag ${value === 'granted' ? 'green' : value === 'denied' || value === 'restricted' ? 'red' : 'gray'}`}>{value}</span></div>;
          }) : <div className="mobile-muted">未选择设备</div>}
          {selected && <button className="btn danger mobile-emergency" onClick={() => void window.aibox.emergencyStopMobile(selected.id).then(() => toast.info('已停止该设备的控制会话'))}><IconStop size={14} />紧急停止</button>}
        </aside>
      </div>

      {pairing && <PairingModal offer={pairing} onClose={() => setPairing(null)} />}
      {scriptEditor && catalog && <ScriptEditor
        value={scriptEditor === 'new' ? null : scriptEditor} catalog={catalog} device={selected}
        onClose={() => setScriptEditor(null)} onSave={async (input, id) => {
          await window.aibox.saveMobileScript(input, id);
          setScriptEditor(null);
          await loadScripts();
          toast.ok('手机脚本已保存');
        }}
      />}
    </div>
  );
}

function ControlView({
  device, previewUri, tree, disabled, typeText, setTypeText, packageName, setPackageName, refresh, runTool
}: {
  device: MobileDevice | null;
  previewUri: string;
  tree: Record<string, unknown> | null;
  disabled: boolean;
  typeText: string;
  setTypeText: (value: string) => void;
  packageName: string;
  setPackageName: (value: string) => void;
  refresh: () => void;
  runTool: (name: MobileToolName, args?: Record<string, unknown>) => void;
}) {
  const nodes = Array.isArray(tree?.tree) ? tree.tree : [];
  const tapTreeNode = useCallback((nodeId: string) => {
    void runTool('android_tap', { node_id: nodeId });
  }, [runTool]);
  return (
    <div className="mobile-control-grid">
      <div className="mobile-phone-column">
        <div className="mobile-phone-frame">
          {previewUri ? <img src={previewUri} alt="Android 实时画面" onClick={(event) => {
            if (disabled) return;
            const image = event.currentTarget;
            const rect = image.getBoundingClientRect();
            const x = Math.round((event.clientX - rect.left) * image.naturalWidth / rect.width);
            const y = Math.round((event.clientY - rect.top) * image.naturalHeight / rect.height);
            runTool('android_tap', { x, y });
          }} /> : <div className="mobile-phone-empty"><IconPhone size={42} /><span>{device ? '等待画面' : '选择设备'}</span></div>}
        </div>
        <div className="mobile-nav-controls">
          <button className="icon-btn" disabled={disabled} title="返回" aria-label="返回" onClick={() => runTool('android_press_key', { key: 'back' })}><IconChevronLeft size={18} /></button>
          <button className="icon-btn" disabled={disabled} title="主屏幕" aria-label="主屏幕" onClick={() => runTool('android_press_key', { key: 'home' })}><IconHome size={17} /></button>
          <button className="icon-btn" disabled={disabled} title="最近任务" aria-label="最近任务" onClick={() => runTool('android_press_key', { key: 'recents' })}><IconLayers size={17} /></button>
          <button className="icon-btn" disabled={!device || device.status === 'offline'} title="刷新" aria-label="刷新" onClick={refresh}><IconRefresh size={17} /></button>
        </div>
      </div>
      <div className="mobile-control-side">
        <div className="mobile-quick-actions">
          <div className="mobile-inline-field"><input value={typeText} onChange={(event) => setTypeText(event.target.value)} placeholder="输入文字" /><button className="btn primary" disabled={disabled || !typeText} onClick={() => { runTool('android_type', { text: typeText }); setTypeText(''); }}>输入</button></div>
          <div className="mobile-inline-field"><input value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="应用包名" /><button className="btn" disabled={disabled || !packageName} onClick={() => runTool('android_open_app', { package: packageName })}>打开</button></div>
          <div className="mobile-swipe-grid">
            <button className="btn" disabled={disabled} onClick={() => runTool('android_swipe', { direction: 'up', distance: 'medium' })}>上滑</button>
            <button className="btn" disabled={disabled} onClick={() => runTool('android_swipe', { direction: 'down', distance: 'medium' })}>下滑</button>
            <button className="btn" disabled={disabled} onClick={() => runTool('android_swipe', { direction: 'left', distance: 'medium' })}>左滑</button>
            <button className="btn" disabled={disabled} onClick={() => runTool('android_swipe', { direction: 'right', distance: 'medium' })}>右滑</button>
          </div>
        </div>
        <div className="mobile-tree-panel">
          <div className="mobile-tree-head"><b>UI Tree</b><span>{typeof tree?.count === 'number' ? `${tree.count} nodes${tree.truncated ? ' · 部分显示' : ''}` : '-'}</span></div>
          <div className="mobile-tree" role="tree" aria-label="Android UI Tree">
            {nodes.length > 0 ? <TreeNodes nodes={nodes} disabled={disabled} onTap={tapTreeNode} /> : <div className="mobile-muted">暂无 UI 节点</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeNodes({ nodes, disabled, onTap }: { nodes: unknown[]; disabled: boolean; onTap: (nodeId: string) => void }) {
  const renderNode = (node: unknown, depth: number, key: string): React.ReactNode => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const value = node as Record<string, unknown>;
    const children = Array.isArray(value.children) ? value.children : [];
    const nodeId = typeof value.nodeId === 'string' ? value.nodeId : '';
    const text = [value.text, value.contentDescription].find((item) => typeof item === 'string' && item) as string | undefined;
    const className = typeof value.className === 'string' ? value.className.split('.').pop() : 'Node';
    return <div className="mobile-tree-branch" key={key}>
      <button disabled={disabled || !nodeId} className={value.clickable ? 'clickable' : ''} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => nodeId && onTap(nodeId)} title={nodeId}>
        <span>{text || className}</span>
        <small>{className}{value.clickable ? ' · clickable' : ''}</small>
      </button>
      {children.map((child, index) => renderNode(child, Math.min(depth + 1, 8), `${key}.${index}`))}
    </div>;
  };
  const rendered = nodes.map((node, index) => renderNode(node, 0, String(index)));
  return <>{rendered}</>;
}

function ScriptsView({ scripts, device, disabled, onNew, onEdit, onRun, onDelete }: {
  scripts: MobileScriptDefinition[];
  device: MobileDevice | null;
  disabled: boolean;
  onNew: () => void;
  onEdit: (script: MobileScriptDefinition) => void;
  onRun: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const visible = scripts.filter((script) => !device || !script.deviceId || script.deviceId === device.id);
  return <div className="mobile-list-view">
    <div className="mobile-list-toolbar"><b>控制脚本</b><button className="btn primary" onClick={onNew}><IconPlus size={14} />新建脚本</button></div>
    {visible.map((script) => <div key={script.id} className="mobile-list-row">
      <div><b>{script.name}</b><small>{script.description || `${script.steps.length} 个步骤`}</small></div>
      <span className="tag gray">{script.steps.length} 步</span>
      <button className="btn small" onClick={() => onEdit(script)}>编辑</button>
      <button className="icon-btn" title="运行" aria-label="运行" disabled={disabled} onClick={() => void onRun(script.id)}><IconPlay size={15} /></button>
      <button className="icon-btn" title="删除" aria-label="删除" onClick={() => void onDelete(script.id)}><IconTrash size={15} /></button>
    </div>)}
    {visible.length === 0 && <div className="empty">暂无手机脚本</div>}
  </div>;
}

function LogsView({ commands }: { commands: MobileCommandLog[] }) {
  return <div className="mobile-list-view">
    <div className="mobile-list-toolbar"><b>命令日志</b><span>{commands.length} 条</span></div>
    <div className="mobile-log-table">
      <div className="mobile-log-row head"><span>时间</span><span>工具</span><span>状态</span><span>耗时</span><span>摘要</span></div>
      {commands.map((command) => <div key={command.id} className="mobile-log-row">
        <span>{formatTime(command.startedAt)}</span><code>{command.toolName}</code><span><i className={`tag ${statusTag(command.status)}`}>{command.status}</i></span>
        <span>{command.endedAt ? `${command.endedAt - command.startedAt} ms` : '-'}</span>
        <span title={command.error ?? JSON.stringify(command.resultSummary)}>{command.error ?? JSON.stringify(command.resultSummary)}</span>
      </div>)}
      {commands.length === 0 && <div className="empty">暂无命令日志</div>}
    </div>
  </div>;
}

function MediaView({ artifacts }: { artifacts: MobileArtifact[] }) {
  return <div className="mobile-list-view">
    <div className="mobile-list-toolbar"><b>媒体产物</b><span>{artifacts.length} 项</span></div>
    <div className="mobile-media-grid">
      {artifacts.map((artifact) => <article key={artifact.id} className="mobile-media-item">
        <div className="mobile-media-preview">
          {artifact.kind === 'screenshot' && <img src={artifact.uri} alt={artifact.filename} />}
          {artifact.kind === 'screen_recording' && <video controls preload="metadata" src={artifact.uri} />}
          {artifact.kind === 'audio' && <audio controls preload="metadata" src={artifact.uri} />}
        </div>
        <div className="mobile-media-meta"><b>{artifact.filename}</b><small>{formatBytes(artifact.size)} · {formatTime(artifact.createdAt)}</small></div>
        <a className="icon-btn" href={artifact.uri} download={artifact.filename} title="下载" aria-label="下载"><IconDownload size={15} /></a>
      </article>)}
    </div>
    {artifacts.length === 0 && <div className="empty">暂无媒体产物</div>}
  </div>;
}

function InstallView({ apk, devices, busy, onRefresh, onInstall, onExport }: {
  apk: MobileApkInfo | null;
  devices: MobileAdbDevice[];
  busy: boolean;
  onRefresh: () => void;
  onInstall: (serial: string) => Promise<void>;
  onExport: () => Promise<void>;
}) {
  return <div className="mobile-install-view">
    <div className="mobile-apk-summary">
      <div><IconPhone size={28} /><span><b>OPC-Nexus 手机桥</b><small>{apk?.available ? `${apk.packageName} · v${apk.versionName}` : apk?.error ?? '正在检测 APK'}</small></span></div>
      <span className={`tag ${apk?.available ? 'green' : 'red'}`}>{apk?.available ? (apk.releaseSigned ? '生产签名' : '调试签名') : '不可用'}</span>
      <button className="btn" disabled={!apk?.available} onClick={() => void onExport()}><IconDownload size={14} />导出 APK</button>
      <button className="icon-btn" disabled={busy} title="刷新 ADB" aria-label="刷新 ADB" onClick={onRefresh}><IconRefresh size={16} /></button>
    </div>
    {apk?.available && <div className="mobile-apk-digests"><span>APK SHA-256</span><code>{apk.sha256}</code><span>签名证书</span><code>{apk.signerSha256}</code></div>}
    <div className="mobile-section-label">ADB 设备</div>
    {devices.map((device) => <div className="mobile-list-row" key={device.serial}>
      <div><b>{device.model || device.serial}</b><small>{device.serial} · {device.product || 'Android'}</small></div>
      <span className={`tag ${statusTag(device.state)}`}>{device.state}</span>
      <button className="btn primary" disabled={busy || !apk?.available || device.state !== 'device'} onClick={() => void onInstall(device.serial)}><IconUpload size={14} />安装</button>
    </div>)}
    {devices.length === 0 && <div className="empty">未发现 ADB 设备</div>}
  </div>;
}

function PairingModal({ offer, onClose }: { offer: MobilePairingOffer; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [copying, setCopying] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((offer.expiresAt - now) / 1_000));
  const endpoint = `wss://${offer.host}:${offer.port}/v1/device`;
  const copyConfig = async () => {
    setCopying(true);
    try {
      await window.aibox.copyMobilePairingConfig(offer.id);
      toast.ok('完整配对配置已复制');
    } catch (error) {
      toast.err(errorText(error, '复制配对配置失败'));
    } finally {
      setCopying(false);
    }
  };
  return <Modal title="配对 Android 手机" width={680} onClose={onClose} footer={<>
    <button className="btn" disabled={copying || seconds === 0} onClick={() => void copyConfig()}><IconCopy size={14} />{copying ? '复制中...' : '复制完整配置'}</button>
    <button className="btn primary" onClick={onClose}>完成</button>
  </>}>
    <div className="mobile-pairing">
      <img src={offer.qrUri} alt="OPC-Nexus 手机配对二维码" />
      <div className="mobile-pairing-meta">
        <div className="mobile-pairing-state"><span className={`tag ${seconds > 0 ? 'orange' : 'red'}`}>{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '已过期'}</span><span>一次性配置</span></div>
        <dl>
          <dt>协议</dt><dd>v{offer.protocolVersion}</dd>
          <dt>网关</dt><dd><code>{endpoint}</code></dd>
          <dt>配对 ID</dt><dd><code>{offer.id}</code></dd>
          <dt>SPKI</dt><dd><code>{offer.certificateFingerprint}</code></dd>
          <dt>过期时间</dt><dd>{formatTime(offer.expiresAt)}</dd>
        </dl>
      </div>
    </div>
  </Modal>;
}

function ScriptEditor({ value, catalog, device, onClose, onSave }: {
  value: MobileScriptDefinition | null;
  catalog: MobileToolCatalog;
  device: MobileDevice | null;
  onClose: () => void;
  onSave: (input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => Promise<void>;
}) {
  const tools = catalog.tools.filter((tool) => tool.name !== 'android_macro' && tool.name !== 'android_setup');
  const [name, setName] = useState(value?.name ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [steps, setSteps] = useState<MobileScriptStep[]>(value?.steps ?? [{ tool: 'android_ping', args: {}, delayAfterMs: 0, onFailure: 'stop' }]);
  const [argsText, setArgsText] = useState<string[]>(() => (value?.steps ?? [{ args: {} }]).map((step) => JSON.stringify(step.args)));
  const [saving, setSaving] = useState(false);
  const updateStep = (index: number, patch: Partial<MobileScriptStep>) => setSteps((current) => current.map((step, at) => at === index ? { ...step, ...patch } : step));
  return <Modal title={value ? '编辑手机脚本' : '新建手机脚本'} width={820} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || !name.trim()} onClick={async () => {
    setSaving(true);
    try {
      const parsed = steps.map((step, index) => ({ ...step, args: JSON.parse(argsText[index] || '{}') as Record<string, unknown> }));
      await onSave({ name: name.trim(), description: description.trim(), agentId: device?.boundAgentId ?? value?.agentId ?? null, deviceId: device?.id ?? value?.deviceId ?? null, steps: parsed }, value?.id);
    } catch (error) { toast.err(errorText(error, '脚本保存失败')); setSaving(false); }
  }}>{saving ? '保存中...' : '保存脚本'}</button></>}>
    <div className="field"><label>名称</label><input value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label>说明</label><input value={description} onChange={(event) => setDescription(event.target.value)} /></div>
    <div className="mobile-script-steps">
      {steps.map((step, index) => <div className="mobile-script-step" key={index}>
        <span className="mobile-step-index">{index + 1}</span>
        <select value={step.tool} onChange={(event) => updateStep(index, { tool: event.target.value as MobileScriptStep['tool'], args: {} })}>{tools.map((tool) => <option value={tool.name} key={tool.name}>{tool.name}</option>)}</select>
        <input value={argsText[index] ?? '{}'} onChange={(event) => setArgsText((current) => current.map((text, at) => at === index ? event.target.value : text))} aria-label={`步骤 ${index + 1} 参数 JSON`} />
        <input type="number" min={0} max={30000} value={step.delayAfterMs ?? 0} onChange={(event) => updateStep(index, { delayAfterMs: Number(event.target.value) })} title="步骤后延迟毫秒" />
        <select value={step.onFailure ?? 'stop'} onChange={(event) => updateStep(index, { onFailure: event.target.value as MobileScriptStep['onFailure'] })}><option value="stop">失败停止</option><option value="continue">失败继续</option></select>
        <button className="icon-btn" title="删除步骤" aria-label="删除步骤" disabled={steps.length === 1} onClick={() => { setSteps((current) => current.filter((_, at) => at !== index)); setArgsText((current) => current.filter((_, at) => at !== index)); }}><IconTrash size={14} /></button>
      </div>)}
    </div>
    <button className="btn" disabled={steps.length >= 100} onClick={() => { setSteps((current) => [...current, { tool: 'android_ping', args: {}, delayAfterMs: 0, onFailure: 'stop' }]); setArgsText((current) => [...current, '{}']); }}><IconPlus size={14} />添加步骤</button>
  </Modal>;
}

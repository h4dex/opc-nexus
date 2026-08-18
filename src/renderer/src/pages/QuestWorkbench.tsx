import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { TASK_STATUS_META } from '../components/common';
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFullscreen,
  IconHome,
  IconLayers,
  IconPhone,
  IconPlug,
  IconRefresh,
  IconSettings,
  IconTask,
  IconUser
} from '../components/icons';
import { toast } from '../components/Toast';
import { useApp } from '../store';
import { DSH_MANAGED_ENGINE_ID } from '@shared/types';
import type {
  DshCommunityPluginCatalogView,
  DshCommunityPluginView,
  DshPluginLifecycleAction,
  DshEmbeddedWorkbenchBounds,
  PermissionMode,
  PluginCatalogItemView,
  PluginCatalogView,
  Project,
  ProjectWorkbenchView,
  QuestProviderPreflightView,
  QuestSandbox,
  QuestSettings,
  Task
} from '@shared/types';
import './questWorkbench.css';
import { QuestMobileAccess } from './QuestMobileAccess';
import { QuestRuntimeSetup } from './QuestRuntimeSetup';
import { ProjectArtifactsPanel } from './ProjectArtifactsPanel';

export interface QuestWorkbenchProps {
  project: Project;
  onBack?: () => void;
  projects?: Project[];
  onProjectChange?: (projectId: string) => void;
  standalone?: boolean;
}

type EmbedPhase = 'idle' | 'opening' | 'ready' | 'error' | 'unavailable';

const DSH_EMBEDDED_MIN_WIDTH = 320;
const DSH_EMBEDDED_MIN_HEIGHT = 240;

const ACTIVE_TASK_STATUSES = new Set<Task['status']>([
  'RUNNING',
  'QUEUED',
  'WAITING_APPROVAL',
  'PAUSED'
]);

const PLUGIN_STATUS_LABELS: Record<DshCommunityPluginView['status'], string> = {
  available: '可安装',
  'update-available': '可更新',
  installed: '仅已安装',
  installing: '安装中',
  'restart-required': '重启后生效',
  blocked: '策略阻止',
  broken: '版本异常',
  missing: '不可用'
};

const BUILTIN_STATUS_LABELS: Record<DshCommunityPluginCatalogView['builtInCapabilities'][number]['status'], string> = {
  integrated: '已集成',
  available: '当前可用',
  unavailable: '当前不可用'
};

const PLUGIN_BOUNDARY_LABELS: Record<DshCommunityPluginView['runtimeBoundary'], string> = {
  'reviewed-profile': '已核验 Profile',
  'explicit-profile-permission': '需显式授权',
  'main-adapter-required': '需宿主适配',
  'standalone-only': '独立运行',
  blocked: '策略阻止'
};

const PLUGIN_COMPATIBILITY_LABELS: Record<DshCommunityPluginView['compatibility'], string> = {
  verified: '已验证',
  unverified: '待验证',
  incompatible: '不兼容',
  'identity-conflict': '包身份冲突'
};

const PROFILE_STATUS_LABELS: Record<DshCommunityPluginCatalogView['profile'], string> = {
  running: 'Profile 运行中',
  stopped: 'Profile 已停止',
  unavailable: 'Profile 不可用',
  unknown: 'Profile 状态未知'
};

const PLUGIN_SOURCE_LABELS: Record<PluginCatalogItemView['source'], string> = {
  host: '宿主',
  dsh: 'DSH',
  mcp: 'MCP',
  skill: '技能',
  cli: 'CLI',
  acp: 'ACP',
  a2a: 'A2A'
};

const REQUIRED_PROJECT_PLUGIN_IDS = new Set(['host:opc-nexus-governance']);
const WORKER_PLUGIN_SOURCES = new Set<PluginCatalogItemView['source']>(['cli', 'acp', 'a2a']);

const PLUGIN_REASON_LABELS: Record<string, string> = {
  NOT_A_CORDIS_PLUGIN: '不是 Cordis 插件',
  MANAGED_POLICY_CONFLICT: '与托管沙箱冲突',
  AGGREGATE_PRIVILEGE_ESCALATION: '聚合包权限过宽',
  COMMUNITY_ENHANCEMENTS_NOT_BUILT_IN: '社区增强未内置',
  EXPLICIT_PERMISSION_REQUIRED: '需要目录或进程授权',
  NATIVE_PTY: '包含原生终端',
  FILESYSTEM_WRITE: '需要文件写入',
  MAIN_ADAPTER_REQUIRED: '需要宿主安全适配',
  VISION_CREDENTIAL_PROXY_REQUIRED: '需要视觉凭据代理',
  RUNTIME_INSTALL_DISABLED: '运行时安装已关闭',
  STANDALONE_ONLY: '只能独立运行',
  PACKAGE_IDENTITY_CONFLICT: '包身份存在冲突',
  BROWSER_NETWORK_WRITE_PERMISSION: '需要浏览器网络写权限',
  DSH_RC6_INCOMPATIBLE: '与 DSH rc.6 不兼容',
  RUNTIME_AUTHORING_DISABLED: '动态运行时编排已关闭',
  CHAT_HISTORY_SCOPE_REQUIRED: '需要聊天历史目录授权',
  SESSION_WRITE: '会写入会话',
  NETWORK_PROXY_REQUIRED: '需要受控网络代理',
  UNTRUSTED_INSTALL_COMMAND_OUTPUT: '发现结果含未治理安装命令',
  INSTALLED_OUTSIDE_APPROVED_BOUNDARY: '已安装但未获运行授权',
  VERSION_UPDATE_AVAILABLE: '存在固定版本更新',
  BUNDLE_PATCH_INVALID: 'Bundle 补丁无效',
  VERSION_MISMATCH: '安装版本不匹配'
};

function sameBounds(left: DshEmbeddedWorkbenchBounds | null, right: DshEmbeddedWorkbenchBounds): boolean {
  return left !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function visibleBounds(element: HTMLElement): DshEmbeddedWorkbenchBounds {
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, Math.floor(rect.left));
  const y = Math.max(0, Math.floor(rect.top));
  const right = Math.min(window.innerWidth, Math.ceil(rect.right));
  const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom));
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  };
}

export function isUsableDshEmbeddedBounds(bounds: DshEmbeddedWorkbenchBounds): boolean {
  return bounds.width >= DSH_EMBEDDED_MIN_WIDTH && bounds.height >= DSH_EMBEDDED_MIN_HEIGHT;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatUpdatedAt(value: number): string {
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

export function QuestWorkbench({ project, onBack, projects = [project], onProjectChange, standalone = false }: QuestWorkbenchProps) {
  const { snapshot } = useApp();
  const embeddedHostRef = useRef<HTMLDivElement>(null);
  const activeProjectIdRef = useRef(project.id);
  activeProjectIdRef.current = project.id;
  const openedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const settingsSaveRequestRef = useRef(0);
  const pluginCatalogRequestRef = useRef(0);
  const reportFrameRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<DshEmbeddedWorkbenchBounds | null>(null);
  const lastVisibleRef = useRef<boolean | null>(null);
  const [workbench, setWorkbench] = useState<ProjectWorkbenchView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<QuestSettings | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const settingsDirtyRef = useRef(false);
  const [workbenchLoading, setWorkbenchLoading] = useState(true);
  const [resolvedProjectId, setResolvedProjectId] = useState<string | null>(null);
  const [workbenchError, setWorkbenchError] = useState<string | null>(null);
  const [embedPhase, setEmbedPhase] = useState<EmbedPhase>('idle');
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [providerPreflight, setProviderPreflight] = useState<QuestProviderPreflightView | null>(null);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [mobileRunning, setMobileRunning] = useState(false);
  const [pluginCatalog, setPluginCatalog] = useState<DshCommunityPluginCatalogView | null>(null);
  const [unifiedPluginCatalog, setUnifiedPluginCatalog] = useState<PluginCatalogView | null>(null);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null);
  const [popupOpening, setPopupOpening] = useState(false);
  const [embedRevision, setEmbedRevision] = useState(0);

  const projectTasks = useMemo(
    () => (snapshot?.tasks ?? [])
      .filter((task) => task.projectId === project.id)
      .sort((left, right) => {
        const activeDelta = Number(ACTIVE_TASK_STATUSES.has(right.status)) - Number(ACTIVE_TASK_STATUSES.has(left.status));
        return activeDelta || right.createdAt - left.createdAt;
      }),
    [project.id, snapshot?.tasks]
  );
  const agentsById = useMemo(
    () => new Map((snapshot?.agentCards ?? []).map((card) => [card.agent.id, card.agent])),
    [snapshot?.agentCards]
  );
  const dshAgents = useMemo(
    () => (snapshot?.agentCards ?? []).filter((card) => (
      !card.agent.archived && card.agent.engineId === DSH_MANAGED_ENGINE_ID
    )),
    [snapshot?.agentCards]
  );
  const workerAgents = useMemo(
    () => (snapshot?.agentCards ?? []).filter((card) => (
      !card.agent.archived && card.agent.engineId !== DSH_MANAGED_ENGINE_ID
    )),
    [snapshot?.agentCards]
  );
  const agentId = useMemo(() => {
    if (workbench?.rootSession?.agentId) return workbench.rootSession.agentId;
    return dshAgents[0]?.agent.id ?? '';
  }, [dshAgents, workbench?.rootSession?.agentId]);
  const agentName = agentsById.get(agentId)?.name
    ?? workbench?.rootSession?.agentName
    ?? 'DSH / Cordis';

  useEffect(() => {
    const previous = document.documentElement.dataset.questFocus;
    document.documentElement.dataset.questFocus = 'true';
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.questFocus;
      else document.documentElement.dataset.questFocus = previous;
    };
  }, []);

  const loadWorkbench = useCallback(async (initial = false) => {
    const requestId = ++loadRequestRef.current;
    if (initial) {
      settingsSaveRequestRef.current += 1;
      setWorkbenchLoading(true);
      setResolvedProjectId(null);
      setWorkbench((current) => current?.project.id === project.id ? current : null);
      setSettingsDraft(null);
      setSettingsDirty(false);
      setSettingsSaving(false);
      settingsDirtyRef.current = false;
    }
    try {
      const value = await window.aibox.getProjectWorkbench(project.id);
      if (requestId !== loadRequestRef.current) return;
      setWorkbench(value);
      if (!settingsDirtyRef.current) setSettingsDraft({ ...value.settings, mode: 'quest' });
      setWorkbenchError(null);
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      setWorkbenchError(error instanceof Error ? error.message : '项目治理数据加载失败');
    } finally {
      if (requestId === loadRequestRef.current) {
        setResolvedProjectId(project.id);
        if (initial) setWorkbenchLoading(false);
      }
    }
  }, [project.id]);

  useEffect(() => {
    void loadWorkbench(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadWorkbench();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadWorkbench]);

  useEffect(() => {
    if (standalone) return;
    return window.aibox.onQuestWindowClosed(() => {
      setEmbedRevision((value) => value + 1);
    });
  }, [standalone]);

  const reportEmbeddedGeometry = useCallback(() => {
    if (reportFrameRef.current !== null) return;
    reportFrameRef.current = window.requestAnimationFrame(() => {
      reportFrameRef.current = null;
      const element = embeddedHostRef.current;
      if (!element || !openedRef.current) return;

      const bounds = visibleBounds(element);
      const visible = document.visibilityState === 'visible'
        && element.isConnected
        && isUsableDshEmbeddedBounds(bounds);
      const api = window.aibox;

      // A native WebContentsView always sits above Renderer DOM. When a drawer
      // collapses this host, hide the old native rectangle instead of sending
      // bounds that Main correctly rejects and leaving the drawer covered.
      if (visible && !sameBounds(lastBoundsRef.current, bounds)) {
        lastBoundsRef.current = bounds;
        void api.setEmbeddedDshWorkbenchBounds(bounds).catch(() => undefined);
      }
      if (lastVisibleRef.current !== visible) {
        lastVisibleRef.current = visible;
        void api.setEmbeddedDshWorkbenchVisible(visible).catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => {
    const element = embeddedHostRef.current;
    if (!element) return;
    const observer = new ResizeObserver(reportEmbeddedGeometry);
    observer.observe(element);
    window.addEventListener('resize', reportEmbeddedGeometry);
    window.addEventListener('scroll', reportEmbeddedGeometry, true);
    document.addEventListener('visibilitychange', reportEmbeddedGeometry);
    reportEmbeddedGeometry();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportEmbeddedGeometry);
      window.removeEventListener('scroll', reportEmbeddedGeometry, true);
      document.removeEventListener('visibilitychange', reportEmbeddedGeometry);
      if (reportFrameRef.current !== null) {
        window.cancelAnimationFrame(reportFrameRef.current);
        reportFrameRef.current = null;
      }
    };
  }, [reportEmbeddedGeometry]);

  useEffect(() => {
    if (workbenchLoading || resolvedProjectId !== project.id) return;
    if (!agentId) {
      setEmbedPhase('unavailable');
      setEmbedError(null);
      return;
    }
    const element = embeddedHostRef.current;
    if (!element) return;

    const api = window.aibox;
    const bounds = visibleBounds(element);
    let active = true;
    let statusTimer: number | null = null;
    setEmbedPhase('opening');
    setEmbedError(null);
    setProviderPreflight(null);
    lastBoundsRef.current = bounds;
    lastVisibleRef.current = null;

    void (async () => {
      const preflight = await api.preflightQuestProvider(project.id, agentId);
      if (!active) return;
      setProviderPreflight(preflight);
      if (!preflight.ready) {
        setEmbedPhase('error');
        setEmbedError(preflight.error ?? '模型 Provider 尚未就绪');
        return;
      }

      const status = await api.openEmbeddedDshWorkbench({
        projectId: project.id,
        agentId,
        sessionId: workbench?.rootSession?.sessionId ?? null,
        bounds
      });
      if (!active) return;
      openedRef.current = true;
      setEmbedPhase(status.loading ? 'opening' : status.attached ? 'ready' : 'error');
      reportEmbeddedGeometry();

      if (status.loading) {
        statusTimer = window.setInterval(() => {
          void api.getEmbeddedDshWorkbenchStatus().then((next) => {
            if (!active) return;
            setEmbedPhase(next.loading ? 'opening' : next.attached ? 'ready' : 'error');
            if (!next.loading && statusTimer !== null) {
              window.clearInterval(statusTimer);
              statusTimer = null;
            }
          }).catch(() => undefined);
        }, 750);
      }
    })().catch((error) => {
      if (!active) return;
      openedRef.current = false;
      setEmbedPhase('error');
      setEmbedError(error instanceof Error ? error.message : 'DSH 工作区打开失败');
    });

    return () => {
      active = false;
      openedRef.current = false;
      lastBoundsRef.current = null;
      lastVisibleRef.current = null;
      if (statusTimer !== null) window.clearInterval(statusTimer);
      // React runs the previous effect cleanup before opening the next project.
      // Dispatch close immediately so the old teardown cannot arrive after the
      // next project's open request and destroy its newly attached native View.
      void api.closeEmbeddedDshWorkbench().catch(() => undefined);
    };
    // Workspace changes bump embedRevision explicitly. Keeping the root id out
    // avoids reopening the same View when an initial null binding is persisted.
  }, [agentId, embedRevision, project.id, reportEmbeddedGeometry, resolvedProjectId, workbenchLoading]);

  const openPopup = async () => {
    if (!agentId || popupOpening) return;
    setPopupOpening(true);
    try {
      await window.aibox.openQuestWindow({ projectId: project.id });
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '无法在独立窗口打开 Quest');
    } finally {
      setPopupOpening(false);
    }
  };

  const openMainConsole = async () => {
    try {
      await window.aibox.openMainSurface();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '主控制台打开失败');
    }
  };

  const loadPluginCatalog = useCallback(async () => {
    const requestId = ++pluginCatalogRequestRef.current;
    setPluginsLoading(true);
    try {
      const [communityResult, unifiedResult] = await Promise.allSettled([
        agentId
          ? window.aibox.getDshCommunityPluginCatalog(agentId)
          : Promise.reject(new Error('没有可用的 DSH 数字员工')),
        window.aibox.getPluginCatalog()
      ]);
      if (requestId !== pluginCatalogRequestRef.current) return;
      setPluginCatalog(communityResult.status === 'fulfilled' ? communityResult.value : null);
      setUnifiedPluginCatalog(unifiedResult.status === 'fulfilled' ? unifiedResult.value : null);
      const errors = [communityResult, unifiedResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      setPluginsError(errors.length > 0 ? errors.join('；') : null);
    } finally {
      if (requestId === pluginCatalogRequestRef.current) setPluginsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (pluginsOpen) void loadPluginCatalog();
  }, [loadPluginCatalog, pluginsOpen]);

  useEffect(() => {
    let active = true;
    void window.aibox.getDshLanGatewayStatus().then((status) => {
      if (active) setMobileRunning(status.gateway.running);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const installCommunityPlugin = async (plugin: DshCommunityPluginView) => {
    if (!agentId || pluginBusyId || !plugin.installable) return;
    setPluginBusyId(plugin.id);
    try {
      const confirmation = await window.aibox.prepareDshCommunityPluginInstall(agentId, plugin.id);
      const accepted = window.confirm(
        `确认安装 ${plugin.name}？\n\n${confirmation.summary}\n运行边界：${PLUGIN_BOUNDARY_LABELS[plugin.runtimeBoundary]}\n版本：${plugin.version}`
      );
      if (!accepted) return;
      const result = await window.aibox.installDshCommunityPlugin({
        agentId,
        pluginId: plugin.id,
        confirmationToken: confirmation.token
      });
      if (result.ok) toast.ok(result.message || `${plugin.name} 已安装`);
      else toast.err(result.message || `${plugin.name} 安装失败`);
      await loadPluginCatalog();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : 'DSH 插件安装失败');
    } finally {
      setPluginBusyId(null);
    }
  };

  const applyCommunityPluginLifecycle = async (
    plugin: DshCommunityPluginView,
    action: Exclude<DshPluginLifecycleAction, 'install'>
  ) => {
    const allowed = action === 'uninstall'
      ? plugin.installedVersion !== null && plugin.status !== 'installing' && plugin.status !== 'missing'
      : plugin.installable && (plugin.status === 'update-available' || plugin.status === 'broken');
    if (!agentId || pluginBusyId || !allowed) return;
    setPluginBusyId(plugin.id);
    const actionLabel = action === 'uninstall' ? '卸载' : '更新';
    try {
      const confirmation = await window.aibox.prepareDshCommunityPluginLifecycle(agentId, plugin.id, action);
      const accepted = window.confirm(
        `确认${actionLabel} ${plugin.name}？\n\n${confirmation.summary}\n当前版本：${plugin.installedVersion ?? '未知'}\n目标版本：${plugin.version}`
      );
      if (!accepted) return;
      const result = await window.aibox.applyDshCommunityPluginLifecycle({
        agentId,
        pluginId: plugin.id,
        action,
        confirmationToken: confirmation.token
      });
      if (result.ok) toast.ok(result.message || `${plugin.name} 已${actionLabel}`);
      else toast.err(result.message || `${plugin.name} ${actionLabel}失败`);
      await loadPluginCatalog();
    } catch (error) {
      toast.err(error instanceof Error ? error.message : `DSH 插件${actionLabel}失败`);
    } finally {
      setPluginBusyId(null);
    }
  };

  const toggleGovernance = () => {
    const next = !governanceOpen;
    setGovernanceOpen(next);
    if (next) {
      setPluginsOpen(false);
      setSetupOpen(false);
      setMobileOpen(false);
      setArtifactsOpen(false);
    }
  };

  const togglePlugins = () => {
    const next = !pluginsOpen;
    setPluginsOpen(next);
    if (next) {
      setGovernanceOpen(false);
      setSetupOpen(false);
      setMobileOpen(false);
      setArtifactsOpen(false);
    }
  };

  const toggleSetup = () => {
    const next = !setupOpen;
    setSetupOpen(next);
    if (next) {
      setGovernanceOpen(false);
      setPluginsOpen(false);
      setMobileOpen(false);
      setArtifactsOpen(false);
    }
  };

  const toggleMobile = () => {
    const next = !mobileOpen;
    setMobileOpen(next);
    if (next) {
      setGovernanceOpen(false);
      setPluginsOpen(false);
      setSetupOpen(false);
      setArtifactsOpen(false);
    }
  };

  const toggleArtifacts = () => {
    const next = !artifactsOpen;
    setArtifactsOpen(next);
    if (next) {
      setGovernanceOpen(false);
      setPluginsOpen(false);
      setSetupOpen(false);
      setMobileOpen(false);
    }
  };

  const retryEmbed = useCallback(() => {
    setEmbedError(null);
    setEmbedRevision((revision) => revision + 1);
  }, []);

  const openProjectDirectory = async () => {
    try {
      const result = await window.aibox.openProjectWorkspace(project.id);
      if (!result.ok) toast.err(result.message || '无法打开项目目录');
      else if (result.workspaceChanged || embedPhase === 'error' || embedPhase === 'unavailable') {
        await loadWorkbench();
        setEmbedRevision((value) => value + 1);
      }
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '无法打开项目目录');
    }
  };

  const openTaskDirectory = async (taskId: string) => {
    try {
      const result = await window.aibox.openTaskWorkspace(taskId);
      if (!result.ok) toast.err(result.message || '无法打开任务目录');
    } catch (error) {
      toast.err(error instanceof Error ? error.message : '无法打开任务目录');
    }
  };

  const updateSettings = (patch: Partial<QuestSettings>) => {
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((current) => current ? { ...current, ...patch, mode: 'quest' } : current);
  };

  const saveSettings = async () => {
    if (!settingsDraft || settingsSaving) return;
    const requestId = ++settingsSaveRequestRef.current;
    const projectId = project.id;
    setSettingsSaving(true);
    try {
      const saved = await window.aibox.saveQuestSettings(projectId, { ...settingsDraft, mode: 'quest' });
      if (requestId !== settingsSaveRequestRef.current || projectId !== activeProjectIdRef.current) return;
      const normalized = { ...saved, mode: 'quest' as const };
      settingsDirtyRef.current = false;
      setSettingsDirty(false);
      setSettingsDraft(normalized);
      setWorkbench((current) => current ? { ...current, settings: normalized } : current);
      toast.ok('Quest 运行设置已保存');
    } catch (error) {
      if (requestId !== settingsSaveRequestRef.current || projectId !== activeProjectIdRef.current) return;
      toast.err(error instanceof Error ? error.message : 'Quest 运行设置保存失败');
    } finally {
      if (requestId === settingsSaveRequestRef.current) setSettingsSaving(false);
    }
  };

  const activeTasks = projectTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const teamSize = workbench
    ? workbench.team.fixed.length + workbench.team.elastic.length + workbench.team.external.length
    : 0;
  const pluginPack = pluginCatalog?.questDefaultPack ?? null;
  const pluginPackMembers = pluginPack
    ? [...pluginPack.members].sort((left, right) => (left.questPart ?? 99) - (right.questPart ?? 99))
    : [];
  const builtInCapabilities = pluginCatalog?.builtInCapabilities ?? [];
  const integratedBuiltInCount = builtInCapabilities.filter((capability) => capability.status !== 'unavailable').length;
  const projectPlugins = (unifiedPluginCatalog?.items ?? [])
    .filter((plugin) => !REQUIRED_PROJECT_PLUGIN_IDS.has(plugin.id) && !WORKER_PLUGIN_SOURCES.has(plugin.source))
    .sort((left, right) => `${PLUGIN_SOURCE_LABELS[left.source]}:${left.name}`.localeCompare(`${PLUGIN_SOURCE_LABELS[right.source]}:${right.name}`, 'zh-CN'));
  const selectedProjectPluginCount = settingsDraft?.pluginIds.filter((id) => projectPlugins.some((plugin) => plugin.id === id)).length ?? 0;
  const phaseLabel = embedPhase === 'ready'
    ? '已连接'
    : embedPhase === 'opening'
      ? '连接中'
      : embedPhase === 'unavailable'
        ? '未配置'
        : embedPhase === 'error'
          ? providerPreflight && !providerPreflight.ready ? '模型不可用' : '连接失败'
          : '准备中';

  return (
    <section
      className={`quest-workbench${governanceOpen ? ' governance-open' : ''}${pluginsOpen ? ' plugins-open' : ''}${setupOpen ? ' setup-open' : ''}${mobileOpen ? ' mobile-open' : ''}${artifactsOpen ? ' artifacts-open' : ''}`}
      style={{ '--quest-project-color': project.color } as CSSProperties}
      aria-label={`${project.name} Quest 工作区`}
    >
      <header className="quest-workbench-toolbar">
        {onBack && (
          <button className="quest-toolbar-icon" type="button" onClick={onBack} title="返回项目" aria-label="返回项目">
            <IconChevronLeft size={17} />
          </button>
        )}
        <span className="quest-project-mark" />
        <div className="quest-project-heading">
          {onProjectChange && projects.length > 1 ? (
            <select
              value={project.id}
              onChange={(event) => onProjectChange(event.target.value)}
              aria-label="Quest 项目上下文"
              title="切换项目上下文"
            >
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : <strong>{project.name}</strong>}
          <span>{agentName}</span>
        </div>
        <span
          className={`quest-embed-status is-${embedPhase}`}
          title={providerPreflight?.ready
            ? `${providerPreflight.providerName ?? 'Provider'} · ${providerPreflight.model ?? '默认模型'} · ${providerPreflight.latencyMs}ms`
            : providerPreflight?.error ?? undefined}
        ><i />{phaseLabel}</span>
        <div className="quest-toolbar-actions">
          {standalone && (
            <button
              className="quest-toolbar-icon"
              type="button"
              onClick={() => void openMainConsole()}
              title="打开主控制台"
              aria-label="打开主控制台"
            >
              <IconHome size={15} />
            </button>
          )}
          {!standalone && (
            <button
              className="quest-toolbar-icon"
              type="button"
              disabled={!agentId || popupOpening}
              onClick={() => void openPopup()}
              title="在独立窗口打开 Quest"
              aria-label="在独立窗口打开 Quest"
            >
              <IconFullscreen size={15} />
            </button>
          )}
          <button
            className={`quest-toolbar-icon${setupOpen ? ' active' : ''}`}
            type="button"
            onClick={toggleSetup}
            title={setupOpen ? '收起连接设置' : '打开连接设置'}
            aria-label={setupOpen ? '收起 Quest 连接设置' : '打开 Quest 连接设置'}
            aria-expanded={setupOpen}
          >
            <IconSettings size={15} />
          </button>
          <button
            className={`quest-toolbar-icon${pluginsOpen ? ' active' : ''}`}
            type="button"
            onClick={togglePlugins}
            title={pluginsOpen ? '收起默认插件包' : '打开默认插件包'}
            aria-label={pluginsOpen ? '收起 Quest 默认插件包' : '打开 Quest 默认插件包'}
            aria-expanded={pluginsOpen}
          >
            <IconPlug size={15} />
          </button>
          <button
            className={`quest-toolbar-icon${artifactsOpen ? ' active' : ''}`}
            type="button"
            onClick={toggleArtifacts}
            title={artifactsOpen ? '收起项目产物' : '打开项目产物'}
            aria-label={artifactsOpen ? '收起项目产物' : '打开项目产物'}
            aria-expanded={artifactsOpen}
          >
            <IconFile size={15} />
          </button>
          <button
            className={`quest-toolbar-icon${governanceOpen ? ' active' : ''}`}
            type="button"
            onClick={toggleGovernance}
            title={governanceOpen ? '收起项目治理' : '展开项目治理'}
            aria-label={governanceOpen ? '收起项目治理' : '展开项目治理'}
            aria-expanded={governanceOpen}
          >
            {governanceOpen ? <IconChevronRight size={16} /> : <IconLayers size={15} />}
          </button>
        </div>
      </header>

      <div className="quest-workbench-body">
        <div className="quest-embedded-column">
          <div
            ref={embeddedHostRef}
            className={`quest-embedded-host is-${embedPhase}`}
            aria-busy={embedPhase === 'opening'}
          >
            {embedPhase === 'opening' && <div className="quest-embedded-state"><span className="quest-state-spinner" />正在启动 DSH 工作区</div>}
            {embedPhase === 'unavailable' && <div className="quest-embedded-state"><IconAlert size={20} /><strong>没有可用的 DSH 数字员工</strong><button className="btn small" type="button" onClick={toggleSetup}>打开连接设置</button></div>}
            {embedPhase === 'error' && <div className="quest-embedded-state error"><IconAlert size={20} /><strong>{providerPreflight && !providerPreflight.ready ? '模型连接不可用' : 'DSH 工作区连接失败'}</strong><span>{embedError}</span><div className="quest-embedded-state-actions"><button className="btn small" type="button" onClick={() => retryEmbed()}><IconRefresh size={13} />重试</button><button className="btn small" type="button" onClick={toggleSetup}>连接设置</button></div></div>}
          </div>
          <footer className="quest-embedded-footer">
            <button
              className={mobileOpen ? 'active' : ''}
              data-running={mobileRunning}
              type="button"
              onClick={toggleMobile}
              title={mobileOpen ? '收起手机 Web' : mobileRunning ? '手机 Web 已共享' : '连接手机 Web'}
              aria-label={mobileOpen ? '收起 Quest 手机 Web' : '连接 Quest 手机 Web'}
              aria-expanded={mobileOpen}
            >
              <IconPhone size={17} />
              <span className="quest-mobile-indicator" aria-hidden="true" />
            </button>
          </footer>
        </div>

        {mobileOpen && <QuestMobileAccess projectName={project.name} onRunningChange={setMobileRunning} />}

        {artifactsOpen && (
          <ProjectArtifactsPanel
            projectId={project.id}
            projectName={project.name}
            onChooseWorkspace={openProjectDirectory}
          />
        )}

        {setupOpen && (
          <QuestRuntimeSetup
            agentId={agentId}
            engineStatus={snapshot?.engines.find((engine) => engine.id === DSH_MANAGED_ENGINE_ID)?.status ?? null}
            onRetry={retryEmbed}
          />
        )}

        {governanceOpen && (
          <aside className="quest-governance" aria-label="项目治理">
            <div className="quest-governance-head">
              <div><strong>项目治理</strong><span>{workbench?.deliveryBoard.completionRate ?? 0}% 已完成</span></div>
              <button type="button" onClick={() => void openProjectDirectory()} title="打开项目目录" aria-label="打开项目目录"><IconFolder size={14} /></button>
              <button type="button" onClick={() => void loadWorkbench()} title="刷新治理数据" aria-label="刷新治理数据"><IconRefresh size={14} /></button>
            </div>

            <div className="quest-governance-scroll">
              {workbenchError && <div className="quest-governance-error"><IconAlert size={13} />{workbenchError}</div>}
              <div className="quest-governance-kpis">
                <div><span>活跃任务</span><strong>{activeTasks.length}</strong></div>
                <div><span>运行会话</span><strong>{workbench?.activeRuns.length ?? 0}</strong></div>
                <div><span>协作成员</span><strong>{teamSize}</strong></div>
                <div><span>Token</span><strong>{formatTokens(workbench?.usage.totalTokens ?? 0)}</strong></div>
              </div>

              {settingsDraft && (
                <section className="quest-governance-section quest-governance-settings">
                  <header>
                    <span>Quest 运行设置</span>
                    <button
                      type="button"
                      className={settingsDirty ? 'is-dirty' : ''}
                      disabled={!settingsDirty || settingsSaving}
                      onClick={() => void saveSettings()}
                      title="保存 Quest 运行设置"
                      aria-label="保存 Quest 运行设置"
                    >
                      <IconCheck size={13} />
                    </button>
                  </header>
                  <div className="quest-governance-settings-grid">
                    <label><span>模式</span><strong>Quest</strong></label>
                    <label>
                      <span>沙箱</span>
                      <select value={settingsDraft.sandbox} onChange={(event) => updateSettings({ sandbox: event.target.value as QuestSandbox })}>
                        <option value="strict">只读</option>
                        <option value="workspace">项目目录</option>
                        <option value="host">宿主机</option>
                      </select>
                    </label>
                    <label>
                      <span>权限</span>
                      <select value={settingsDraft.permissionMode} onChange={(event) => updateSettings({ permissionMode: event.target.value as PermissionMode })}>
                        <option value="readonly">只读</option>
                        <option value="standard">标准</option>
                        <option value="trusted">信任</option>
                        <option value="autonomous">项目自主（默认）</option>
                      </select>
                    </label>
                    <label>
                      <span>模型</span>
                      <input
                        value={settingsDraft.model ?? ''}
                        maxLength={160}
                        placeholder="DSH 默认"
                        onChange={(event) => updateSettings({ model: event.target.value || null })}
                      />
                    </label>
                    <label>
                      <span>并发</span>
                      <input
                        type="number"
                        min={1}
                        max={16}
                        value={settingsDraft.maxParallel}
                        onChange={(event) => updateSettings({ maxParallel: Math.max(1, Math.min(16, Number(event.target.value) || 1)) })}
                      />
                    </label>
                    <div className="quest-governance-toggle">
                      <span>计划确认后项目目录内持续执行，不再逐步打断</span>
                    </div>
                  </div>
                  {workerAgents.length > 0 && (
                    <div className="quest-governance-workers">
                      <span>优先调度固定员工</span>
                      {workerAgents.map((card) => (
                        <label key={card.agent.id}>
                          <input
                            type="checkbox"
                            checked={settingsDraft.workerAgentIds.includes(card.agent.id)}
                            onChange={(event) => updateSettings({
                              workerAgentIds: event.target.checked
                                ? [...new Set([...settingsDraft.workerAgentIds, card.agent.id])]
                                : settingsDraft.workerAgentIds.filter((id) => id !== card.agent.id)
                            })}
                          />
                          <span>{card.agent.name}<small>{card.agent.role || card.agent.engineId}</small></span>
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="quest-governance-section">
                <header><span><IconTask size={14} />任务推进</span><b>{projectTasks.length}</b></header>
                <div className="quest-governance-task-list">
                  {projectTasks.length === 0 && <span className="quest-governance-empty">暂无项目任务</span>}
                  {projectTasks.slice(0, 8).map((task) => (
                    <article key={task.id}>
                      <div>
                        <strong>{task.title}</strong>
                        <span><i className={`is-${TASK_STATUS_META[task.status].tag}`} />{TASK_STATUS_META[task.status].label}{task.stage ? ` · ${task.stage}` : ''}</span>
                      </div>
                      <b>{task.progress}%</b>
                      <button type="button" onClick={() => void openTaskDirectory(task.id)} title="打开任务目录" aria-label={`打开 ${task.title} 的目录`}><IconFolder size={12} /></button>
                    </article>
                  ))}
                </div>
              </section>

              {(workbench?.risks.length ?? 0) > 0 && (
                <section className="quest-governance-section quest-governance-risks">
                  <header><span><IconAlert size={14} />风险与阻塞</span><b>{workbench?.risks.length}</b></header>
                  {workbench?.risks.slice(0, 5).map((risk) => (
                    <article key={risk.id} data-severity={risk.severity}>
                      <i />
                      <div><strong>{risk.title}</strong><span>{risk.detail}</span></div>
                    </article>
                  ))}
                </section>
              )}

              <section className="quest-governance-section">
                <header><span><IconUser size={14} />当前团队</span><b>{teamSize}</b></header>
                <div className="quest-governance-team">
                  {workbench && [...workbench.team.fixed, ...workbench.team.elastic, ...workbench.team.external].slice(0, 8).map((member) => (
                    <div key={`${member.kind}:${member.agentId}`}>
                      <span><strong>{member.name}</strong><small>{member.role || member.engineId}</small></span>
                      <b>{member.activeRuns > 0 ? `${member.activeRuns} 运行中` : member.kind === 'elastic' ? '弹性' : member.kind === 'external' ? 'A2A' : '固定'}</b>
                    </div>
                  ))}
                  {!workbenchLoading && teamSize === 0 && <span className="quest-governance-empty">团队将在派工后显示</span>}
                </div>
              </section>

              {(workbench?.recentEvents.length ?? 0) > 0 && (
                <section className="quest-governance-section quest-governance-activity">
                  <header><span>最近活动</span></header>
                  {workbench?.recentEvents.slice(0, 6).map((event, index) => (
                    <div key={`${event.sessionId}:${event.createdAt}:${index}`}>
                      <i />
                      <span><strong>{event.summary || event.type}</strong><small>{formatUpdatedAt(event.createdAt)}</small></span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </aside>
        )}

        {pluginsOpen && (
          <aside className="quest-plugin-drawer" aria-label="Quest 能力与社区候选">
            <div className="quest-plugin-head">
              <div>
                <strong>Quest 能力</strong>
                <span>内置集成与社区候选分开核验</span>
              </div>
              <button
                type="button"
                disabled={pluginsLoading || !agentId}
                onClick={() => void loadPluginCatalog()}
                title="刷新插件状态"
                aria-label="刷新插件状态"
              >
                <IconRefresh size={14} />
              </button>
            </div>

            <div className="quest-plugin-scroll" aria-busy={pluginsLoading}>
              <div className="quest-plugin-summary">
                <span className={`is-${pluginCatalog?.profile ?? 'unknown'}`}>
                  {PROFILE_STATUS_LABELS[pluginCatalog?.profile ?? 'unknown']}
                </span>
                <b>社区候选 · 安装 {pluginPack?.installedCount ?? 0}/{pluginPack?.totalCount ?? 10} · 运行 {pluginPack?.liveCount ?? 0}/{pluginPack?.totalCount ?? 10}</b>
              </div>
              <section className="quest-plugin-builtins" aria-label="已接入的内置能力">
                <header>
                  <span>内置能力</span>
                  <b>{integratedBuiltInCount}/{builtInCapabilities.length} 已集成</b>
                </header>
                {builtInCapabilities.map((capability) => (
                  <div key={capability.id} data-status={capability.status}>
                    <IconCheck size={12} />
                    <span><strong>{capability.name}</strong><small>{capability.description}</small></span>
                    <b>{BUILTIN_STATUS_LABELS[capability.status]}</b>
                  </div>
                ))}
              </section>

              <section className="quest-project-plugins" aria-label="项目启用能力">
                <header>
                  <span>项目启用能力</span>
                  <div>
                    <b>{selectedProjectPluginCount}/{projectPlugins.length}</b>
                    <button
                      type="button"
                      className={settingsDirty ? 'is-dirty' : ''}
                      disabled={!settingsDirty || settingsSaving}
                      onClick={() => void saveSettings()}
                      title="保存项目能力选择"
                      aria-label="保存项目能力选择"
                    >
                      <IconCheck size={12} />
                    </button>
                  </div>
                </header>
                <div className="quest-project-plugin-required">
                  <IconCheck size={12} />
                  <span><strong>项目治理与安全宿主</strong><small>计划确认、目录边界、审计和交付投影</small></span>
                  <b>必需</b>
                </div>
                {projectPlugins.map((plugin) => {
                  const available = plugin.enabled && plugin.status === 'ready' && plugin.lifecycle === 'live';
                  return (
                    <label key={plugin.id} data-available={available ? 'true' : 'false'}>
                      <input
                        type="checkbox"
                        disabled={!available || !settingsDraft}
                        checked={settingsDraft?.pluginIds.includes(plugin.id) ?? false}
                        onChange={(event) => {
                          if (!settingsDraft) return;
                          updateSettings({
                            pluginIds: event.target.checked
                              ? [...new Set([...settingsDraft.pluginIds, plugin.id])]
                              : settingsDraft.pluginIds.filter((id) => id !== plugin.id)
                          });
                        }}
                      />
                      <span><strong>{plugin.name}</strong><small>{PLUGIN_SOURCE_LABELS[plugin.source]} · {plugin.kind}</small></span>
                      <b>{available ? '可用' : plugin.lifecycle === 'missing' ? '未安装' : '未就绪'}</b>
                    </label>
                  );
                })}
                {!pluginsLoading && projectPlugins.length === 0 && (
                  <div className="quest-plugin-empty">统一插件目录中暂无可选项目能力。</div>
                )}
              </section>

              {pluginsError && <div className="quest-plugin-error"><IconAlert size={13} />{pluginsError}</div>}
              {pluginsLoading && !pluginPack && (
                <div className="quest-plugin-loading"><span className="quest-state-spinner" />正在读取插件治理状态</div>
              )}
              {!pluginsLoading && !pluginsError && !pluginPack && (
                <div className="quest-plugin-empty">当前 DSH Profile 未提供 Quest 默认能力包。</div>
              )}

              {pluginPackMembers.length > 0 && (
                <div className="quest-plugin-list">
                  {pluginPackMembers.map((plugin) => {
                    const officialWebUiActive = plugin.reasonCodes.includes('OFFICIAL_DSH_WEB_UI_ACTIVE');
                    const reasons = plugin.reasonCodes
                      .map((code) => PLUGIN_REASON_LABELS[code])
                      .filter((label): label is string => Boolean(label));
                    return (
                      <article key={plugin.id} data-boundary={plugin.runtimeBoundary}>
                        <div className="quest-plugin-title-row">
                          <span className="quest-plugin-part">PART {String(plugin.questPart ?? 0).padStart(2, '0')}</span>
                          <strong>{plugin.name}</strong>
                          <code>v{plugin.version}</code>
                        </div>
                        <div className="quest-plugin-labels">
                          <span className={`is-${plugin.compatibility}`}>{PLUGIN_COMPATIBILITY_LABELS[plugin.compatibility]}</span>
                          <span className={`is-${plugin.runtimeBoundary}`}>{PLUGIN_BOUNDARY_LABELS[plugin.runtimeBoundary]}</span>
                          <span className={`is-${plugin.status}`}>{PLUGIN_STATUS_LABELS[plugin.status]}</span>
                          <span className={plugin.activation.live ? 'is-live' : plugin.installedVersion ? 'is-not-probed' : 'is-candidate'}>
                            {plugin.activation.live ? '运行已验证' : plugin.installedVersion ? '未验证运行' : '社区候选'}
                          </span>
                        </div>
                        {officialWebUiActive && <p className="quest-plugin-official">官方基础 UI 已集成；社区增强包仍需独立核验</p>}
                        {reasons.length > 0 && <p className="quest-plugin-reasons">{[...new Set(reasons)].slice(0, 3).join(' · ')}</p>}
                        <div className="quest-plugin-foot">
                          <span title={plugin.source.packageName}>{plugin.source.packageName}</span>
                          <div className="quest-plugin-actions">
                          {plugin.installable && plugin.status === 'available' && (
                            <button
                              type="button"
                              disabled={pluginBusyId !== null || pluginCatalog?.busy}
                              onClick={() => void installCommunityPlugin(plugin)}
                            >
                              {pluginBusyId === plugin.id ? '安装中…' : '安装'}
                            </button>
                          )}
                          {plugin.installable && (plugin.status === 'update-available' || plugin.status === 'broken') && (
                            <button
                              type="button"
                              disabled={pluginBusyId !== null || pluginCatalog?.busy}
                              onClick={() => void applyCommunityPluginLifecycle(plugin, 'update')}
                            >
                              {pluginBusyId === plugin.id ? '处理中…' : '更新'}
                            </button>
                          )}
                          {plugin.installedVersion !== null && plugin.status !== 'installing' && plugin.status !== 'missing' && (
                            <button
                              className="danger"
                              type="button"
                              disabled={pluginBusyId !== null || pluginCatalog?.busy}
                              onClick={() => void applyCommunityPluginLifecycle(plugin, 'uninstall')}
                            >
                              {pluginBusyId === plugin.id ? '处理中…' : '卸载'}
                            </button>
                          )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

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
import type {
  EmbeddedWorkbenchBounds,
  HermesRuntimeStatus,
  PermissionMode,
  PluginCatalogItemView,
  PluginCatalogView,
  Project,
  ProjectWorkbenchView,
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
  initialConversationId?: string | null;
  active?: boolean;
}

type EmbedPhase = 'idle' | 'opening' | 'ready' | 'error' | 'unavailable';

const HERMES_EMBEDDED_MIN_WIDTH = 320;
const HERMES_EMBEDDED_MIN_HEIGHT = 240;

const ACTIVE_TASK_STATUSES = new Set<Task['status']>([
  'RUNNING',
  'QUEUED',
  'WAITING_APPROVAL',
  'PAUSED'
]);

const PLUGIN_SOURCE_LABELS: Record<PluginCatalogItemView['source'], string> = {
  host: '宿主',
  mcp: 'MCP',
  skill: '技能',
  cli: 'CLI',
  acp: 'ACP',
  a2a: 'A2A'
};

const REQUIRED_PROJECT_PLUGIN_IDS = new Set(['host:opc-nexus-governance']);
const WORKER_PLUGIN_SOURCES = new Set<PluginCatalogItemView['source']>(['cli', 'acp', 'a2a']);
const HERMES_PROJECT_CAPABILITY_SOURCES = new Set<PluginCatalogItemView['source']>(['mcp', 'skill']);

function sameBounds(left: EmbeddedWorkbenchBounds | null, right: EmbeddedWorkbenchBounds): boolean {
  return left !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function visibleBounds(element: HTMLElement): EmbeddedWorkbenchBounds {
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

export function isUsableHermesEmbeddedBounds(bounds: EmbeddedWorkbenchBounds): boolean {
  return bounds.width >= HERMES_EMBEDDED_MIN_WIDTH && bounds.height >= HERMES_EMBEDDED_MIN_HEIGHT;
}

export function isSupersededHermesWorkbenchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Quest embedded Workbench request was superseded/i.test(message);
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

function hermesTaskIntent(task: Task): 'execution' | 'status_inquiry' | 'validation' {
  const match = /^Task intent: (execution|status_inquiry|validation)$/m.exec(task.content ?? '');
  return (match?.[1] ?? 'execution') as 'execution' | 'status_inquiry' | 'validation';
}

function hermesValidationVerdict(task: Task): 'PASS' | 'FAIL' | 'BLOCKED' | null {
  if (hermesTaskIntent(task) !== 'validation' || task.status !== 'COMPLETED' || typeof task.result !== 'string') return null;
  const match = /^\s*(?:\*\*(PASS|FAIL|BLOCKED)\*\*|__(PASS|FAIL|BLOCKED)__|`(PASS|FAIL|BLOCKED)`|(PASS|FAIL|BLOCKED))(?=$|[\s:：.,，。;；!?！？])/i.exec(task.result);
  const verdict = match?.slice(1).find(Boolean);
  return verdict ? verdict.toUpperCase() as 'PASS' | 'FAIL' | 'BLOCKED' : 'BLOCKED';
}

function hermesRelatedTaskCount(task: Task): number {
  if (hermesTaskIntent(task) !== 'validation') return 0;
  const marker = 'Related project tasks:';
  const start = (task.content ?? '').indexOf(marker);
  if (start < 0) return 0;
  const block = (task.content ?? '').slice(start + marker.length).split(/\r?\n\s*\r?\n/, 1)[0] ?? '';
  return block.split(/\r?\n/).map((value) => value.trim()).filter((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value)).length;
}

export function QuestWorkbench({ project, onBack, projects = [project], onProjectChange, standalone = false, initialConversationId = null, active = true }: QuestWorkbenchProps) {
  const { snapshot, theme, setRoute } = useApp();
  const embeddedHostRef = useRef<HTMLDivElement>(null);
  const activeProjectIdRef = useRef(project.id);
  activeProjectIdRef.current = project.id;
  const initialConversationIdRef = useRef(initialConversationId);
  initialConversationIdRef.current = initialConversationId;
  const openedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const settingsSaveRequestRef = useRef(0);
  const pluginCatalogRequestRef = useRef(0);
  const reportFrameRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<EmbeddedWorkbenchBounds | null>(null);
  const lastVisibleRef = useRef<boolean | null>(null);
  const mobileOpenRef = useRef(false);
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
  const [runtimeStatus, setRuntimeStatus] = useState<HermesRuntimeStatus | null>(null);
  const [contextOpen, setContextOpen] = useState(true);
  const [governanceOpen, setGovernanceOpen] = useState(true);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [mobileRunning, setMobileRunning] = useState(false);
  const [unifiedPluginCatalog, setUnifiedPluginCatalog] = useState<PluginCatalogView | null>(null);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [popupOpening, setPopupOpening] = useState(false);
  const [embedRevision, setEmbedRevision] = useState(0);
  mobileOpenRef.current = mobileOpen;

  const projectTasks = useMemo(
    () => (snapshot?.tasks ?? [])
      .filter((task) => task.projectId === project.id)
      .sort((left, right) => {
        const activeDelta = Number(ACTIVE_TASK_STATUSES.has(right.status)) - Number(ACTIVE_TASK_STATUSES.has(left.status));
        return activeDelta || right.createdAt - left.createdAt;
      }),
    [project.id, snapshot?.tasks]
  );
  const workerAgents = useMemo(
    () => (snapshot?.agentCards ?? []).filter((card) => (
      !card.agent.archived
    )),
    [snapshot?.agentCards]
  );
  const projectTeam = useMemo(() => {
    const cards = new Map(workerAgents.map((card) => [card.agent.id, card]));
    const members = new Map<string, {
      agentId: string;
      name: string;
      role: string;
      engineId: string;
      activeTasks: number;
      totalTasks: number;
    }>();
    for (const task of projectTasks) {
      const card = cards.get(task.agentId);
      const member = members.get(task.agentId) ?? {
        agentId: task.agentId,
        name: card?.agent.name ?? task.agentId,
        role: card?.agent.role ?? '',
        engineId: card?.agent.engineId ?? task.engineOverride ?? '',
        activeTasks: 0,
        totalTasks: 0
      };
      member.totalTasks += 1;
      if (ACTIVE_TASK_STATUSES.has(task.status)) member.activeTasks += 1;
      members.set(task.agentId, member);
    }
    return [...members.values()].sort((left, right) => (
      right.activeTasks - left.activeTasks || right.totalTasks - left.totalTasks || left.name.localeCompare(right.name, 'zh-CN')
    ));
  }, [projectTasks, workerAgents]);
  const recentProjectTasks = useMemo(() => [...projectTasks]
    .sort((left, right) => (
      (right.endedAt ?? right.startedAt ?? right.createdAt) - (left.endedAt ?? left.startedAt ?? left.createdAt)
    )), [projectTasks]);

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
    if (!active || project.status === 'archived') return;
    // Start the project-scoped Hermes service while governance data and the
    // embedded WebContentsView are still being prepared. The Main process
    // coalesces this with the later open request, so entering Quest no longer
    // serializes project loading and Python runtime startup.
    void window.aibox.startHermesProject(project.id).catch(() => undefined);
  }, [active, project.id, project.status]);

  useEffect(() => {
    if (standalone) return;
    return window.aibox.onQuestWindowClosed(() => {
      setEmbedRevision((value) => value + 1);
    });
  }, [standalone]);

  useEffect(() => {
    let active = true;
    let checking = false;
    const checkRuntime = async () => {
      if (checking || (embedPhase !== 'opening' && embedPhase !== 'ready')) return;
      checking = true;
      try {
        const runtime = await window.aibox.getHermesRuntimeStatus(project.id);
        if (!active || activeProjectIdRef.current !== project.id) return;
        setRuntimeStatus(runtime);
        if (runtime.state !== 'error' && runtime.state !== 'stopped') return;
        if (embedPhase !== 'ready') return;
        openedRef.current = false;
        lastBoundsRef.current = null;
        lastVisibleRef.current = null;
        await window.aibox.closeEmbeddedHermesWorkbench().catch(() => undefined);
        if (!active || activeProjectIdRef.current !== project.id) return;
        setEmbedPhase(runtime.state === 'error' ? 'error' : 'unavailable');
        setEmbedError(runtime.lastError || (runtime.state === 'error'
          ? 'Hermes 项目运行时已停止'
          : 'Hermes 项目服务未运行'));
      } catch {
        // The embedded open flow owns initial connection errors. Runtime
        // polling only reacts to an authoritative stopped/error state.
      } finally {
        checking = false;
      }
    };
    void checkRuntime();
    const timer = window.setInterval(() => { void checkRuntime(); }, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [embedPhase, project.id]);

  const reportEmbeddedGeometry = useCallback(() => {
    if (reportFrameRef.current !== null) return;
    reportFrameRef.current = window.requestAnimationFrame(() => {
      reportFrameRef.current = null;
      const element = embeddedHostRef.current;
      if (!element || !openedRef.current) return;

      const bounds = visibleBounds(element);
      const visible = document.visibilityState === 'visible'
        && element.isConnected
        && !mobileOpenRef.current
        && isUsableHermesEmbeddedBounds(bounds);
      const api = window.aibox;

      // A native WebContentsView always sits above Renderer DOM. When a drawer
      // collapses this host, hide the old native rectangle instead of sending
      // bounds that Main correctly rejects and leaving the drawer covered.
      if (visible && !sameBounds(lastBoundsRef.current, bounds)) {
        lastBoundsRef.current = bounds;
        void api.setEmbeddedHermesWorkbenchBounds(bounds).catch(() => undefined);
      }
      if (lastVisibleRef.current !== visible) {
        lastVisibleRef.current = visible;
        void api.setEmbeddedHermesWorkbenchVisible(visible).catch(() => undefined);
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
    reportEmbeddedGeometry();
  }, [mobileOpen, reportEmbeddedGeometry]);

  useEffect(() => {
    if (!active || workbenchLoading || resolvedProjectId !== project.id) return;
    const element = embeddedHostRef.current;
    if (!element) return;

    const api = window.aibox;
    const bounds = visibleBounds(element);
    let alive = true;
    let statusTimer: number | null = null;
    setEmbedPhase('opening');
    setEmbedError(null);
    setRuntimeStatus(null);
    lastBoundsRef.current = bounds;
    lastVisibleRef.current = null;

    void (async () => {
      const status = await api.openEmbeddedHermesWorkbench({
        projectId: project.id,
        bounds,
        theme,
        ...(initialConversationIdRef.current ? { conversationId: initialConversationIdRef.current } : {})
      });
      if (!alive) return;
      openedRef.current = true;
      setEmbedPhase(status.loading ? 'opening' : status.attached ? 'ready' : 'error');
      reportEmbeddedGeometry();

      if (status.loading) {
        statusTimer = window.setInterval(() => {
          void api.getEmbeddedHermesWorkbenchStatus().then((next) => {
            if (!alive) return;
            setEmbedPhase(next.loading ? 'opening' : next.attached ? 'ready' : 'error');
            if (!next.loading && statusTimer !== null) {
              window.clearInterval(statusTimer);
              statusTimer = null;
            }
          }).catch(() => undefined);
        }, 750);
      }
    })().catch((error) => {
      if (!alive) return;
      if (isSupersededHermesWorkbenchError(error)) return;
      openedRef.current = false;
      setEmbedPhase('error');
      setEmbedError(error instanceof Error ? error.message : 'Hermes 工作区打开失败');
    });

    return () => {
      alive = false;
      openedRef.current = false;
      lastBoundsRef.current = null;
      lastVisibleRef.current = null;
      if (statusTimer !== null) window.clearInterval(statusTimer);
      void api.setEmbeddedHermesWorkbenchVisible(false).catch(() => undefined);
    };
    // Workspace changes bump embedRevision explicitly. Keeping the root id out
    // avoids reopening the same View when an initial null binding is persisted.
  }, [active, embedRevision, project.id, reportEmbeddedGeometry, resolvedProjectId, theme, workbenchLoading]);

  useEffect(() => () => {
    void window.aibox.closeEmbeddedHermesWorkbench().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active || !initialConversationId || embedPhase !== 'ready' || workbenchLoading || resolvedProjectId !== project.id) return;
    const element = embeddedHostRef.current;
    if (!element) return;
    const bounds = visibleBounds(element);
    if (!isUsableHermesEmbeddedBounds(bounds)) return;
    void window.aibox.openEmbeddedHermesWorkbench({
      projectId: project.id,
      bounds,
      theme,
      conversationId: initialConversationId
    }).catch((error) => {
      if (isSupersededHermesWorkbenchError(error)) return;
      setEmbedError(error instanceof Error ? error.message : '员工会话切换失败');
    });
  }, [active, embedPhase, initialConversationId, project.id, resolvedProjectId, theme, workbenchLoading]);

  const openPopup = async () => {
    if (popupOpening) return;
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
    setPluginsError(null);
    try {
      const unifiedResult = await window.aibox.getPluginCatalog();
      if (requestId !== pluginCatalogRequestRef.current) return;
      setUnifiedPluginCatalog(unifiedResult);
    } catch (error) {
      if (requestId !== pluginCatalogRequestRef.current) return;
      setUnifiedPluginCatalog(null);
      setPluginsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === pluginCatalogRequestRef.current) setPluginsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pluginsOpen) void loadPluginCatalog();
  }, [loadPluginCatalog, pluginsOpen]);

  useEffect(() => {
    let active = true;
    void window.aibox.getHermesMobileAccessStatus(project.id).then((status) => {
      if (active) setMobileRunning(status.running);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [project.id]);

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
    } else {
      setGovernanceOpen(true);
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
    } else {
      setGovernanceOpen(true);
    }
  };

  const toggleMobile = () => {
    setMobileOpen((value) => !value);
  };

  const toggleArtifacts = () => {
    const next = !artifactsOpen;
    setArtifactsOpen(next);
    if (next) {
      setGovernanceOpen(false);
      setPluginsOpen(false);
      setSetupOpen(false);
      setMobileOpen(false);
    } else {
      setGovernanceOpen(true);
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
    const currentSettings = workbench?.settings;
    const reconnectHermes = Boolean(currentSettings) && (
      settingsDraft.model !== currentSettings?.model
      || settingsDraft.workerAgentIds.join('\u0000') !== currentSettings?.workerAgentIds.join('\u0000')
      || settingsDraft.pluginIds.join('\u0000') !== currentSettings?.pluginIds.join('\u0000')
    );
    setSettingsSaving(true);
    try {
      const saved = await window.aibox.saveQuestSettings(projectId, { ...settingsDraft, mode: 'quest' });
      if (requestId !== settingsSaveRequestRef.current || projectId !== activeProjectIdRef.current) return;
      const normalized = { ...saved, mode: 'quest' as const };
      settingsDirtyRef.current = false;
      setSettingsDirty(false);
      setSettingsDraft(normalized);
      setWorkbench((current) => current ? { ...current, settings: normalized } : current);
      if (reconnectHermes) setEmbedRevision((value) => value + 1);
      toast.ok('Quest 运行设置已保存');
    } catch (error) {
      if (requestId !== settingsSaveRequestRef.current || projectId !== activeProjectIdRef.current) return;
      toast.err(error instanceof Error ? error.message : 'Quest 运行设置保存失败');
    } finally {
      if (requestId === settingsSaveRequestRef.current) setSettingsSaving(false);
    }
  };

  const activeTasks = projectTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const validationTasks = projectTasks.filter((task) => hermesTaskIntent(task) === 'validation');
  const latestValidationTask = validationTasks[0] ?? null;
  const validationVerdict = latestValidationTask ? hermesValidationVerdict(latestValidationTask) : null;
  const validationLabel = latestValidationTask
    ? latestValidationTask.status === 'COMPLETED'
      ? validationVerdict === 'PASS' ? '验收通过' : validationVerdict === 'FAIL' ? '验收未通过' : '验收被阻塞'
      : `验收${TASK_STATUS_META[latestValidationTask.status].label}`
    : '主秘书尚未派发独立验收';
  const validationTone = latestValidationTask?.status === 'COMPLETED' && validationVerdict === 'PASS'
    ? 'accepted'
    : latestValidationTask?.status === 'COMPLETED'
      ? 'rejected'
      : latestValidationTask
        ? 'pending'
        : 'muted';
  const teamSize = projectTeam.length;
  const projectPlugins = (unifiedPluginCatalog?.items ?? [])
    .filter((plugin) => HERMES_PROJECT_CAPABILITY_SOURCES.has(plugin.source)
      && !REQUIRED_PROJECT_PLUGIN_IDS.has(plugin.id)
      && !WORKER_PLUGIN_SOURCES.has(plugin.source))
    .sort((left, right) => `${PLUGIN_SOURCE_LABELS[left.source]}:${left.name}`.localeCompare(`${PLUGIN_SOURCE_LABELS[right.source]}:${right.name}`, 'zh-CN'));
  const selectedProjectPluginCount = settingsDraft?.pluginIds.filter((id) => projectPlugins.some((plugin) => plugin.id === id)).length ?? 0;
  const startupLabel = runtimeStatus?.startupPhase === 'preparing'
    ? '准备运行环境'
    : runtimeStatus?.startupPhase === 'starting-dashboard'
      ? '启动对话界面'
      : runtimeStatus?.startupPhase === 'starting-gateway'
        ? '启动执行引擎'
        : '启动 Hermes';
  const phaseLabel = embedPhase === 'ready'
    ? runtimeStatus?.state === 'starting' ? '界面可用 · 引擎启动中' : '已连接'
    : embedPhase === 'opening'
      ? startupLabel
      : embedPhase === 'unavailable'
        ? '未配置'
        : embedPhase === 'error'
          ? '连接失败'
          : '准备中';

  return (
    <section
      className={`quest-workbench${standalone ? ' is-standalone' : ''}${contextOpen ? ' context-open' : ''}${governanceOpen ? ' governance-open' : ''}${pluginsOpen ? ' plugins-open' : ''}${setupOpen ? ' setup-open' : ''}${artifactsOpen ? ' artifacts-open' : ''}`}
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
          <span>Hermes 调度</span>
        </div>
        <span
          className={`quest-embed-status is-${embedPhase}`}
        ><i />{phaseLabel}</span>
        <div className="quest-toolbar-actions">
          <button
            className={`quest-toolbar-icon${contextOpen ? ' active' : ''}`}
            type="button"
            onClick={() => setContextOpen((value) => !value)}
            title={contextOpen ? '收起项目上下文' : '展开项目上下文'}
            aria-label={contextOpen ? '收起 Quest 项目上下文' : '展开 Quest 项目上下文'}
            aria-expanded={contextOpen}
          >
            {contextOpen ? <IconChevronLeft size={15} /> : <IconChevronRight size={15} />}
          </button>
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
              disabled={popupOpening}
              onClick={() => void openPopup()}
              title="在独立窗口打开 Quest"
              aria-label="在独立窗口打开 Quest"
            >
              <IconFullscreen size={15} />
            </button>
          )}
          <button
            className={`quest-toolbar-icon${mobileOpen ? ' active' : ''}`}
            data-running={mobileRunning}
            type="button"
            onClick={toggleMobile}
            title={mobileOpen ? '关闭手机 Hermes 对话' : mobileRunning ? '手机 Hermes 对话已共享' : '连接手机 Hermes 对话'}
            aria-label={mobileOpen ? '关闭手机 Hermes 对话' : '连接手机 Hermes 对话'}
            aria-expanded={mobileOpen}
          >
            <IconPhone size={15} />
            <span className="quest-mobile-indicator" aria-hidden="true" />
          </button>
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
        {contextOpen && (
          <aside className="quest-context" aria-label="Quest 项目与员工上下文">
            <section className="quest-context-section quest-context-projects">
              <header><span>项目</span><b>{projects.length}</b></header>
              <div>
                {projects.map((item) => (
                  <button
                    key={item.id}
                    className={item.id === project.id ? 'active' : ''}
                    type="button"
                    disabled={!onProjectChange || item.id === project.id}
                    onClick={() => onProjectChange?.(item.id)}
                    title={item.objective || item.name}
                  >
                    <i style={{ background: item.color }} />
                    <span><strong>{item.name}</strong><small>{item.status === 'active' ? '进行中' : item.status === 'planning' ? '规划中' : item.status === 'paused' ? '已暂停' : '已完成'}</small></span>
                  </button>
                ))}
              </div>
            </section>

            <section className="quest-context-section quest-context-sessions">
              <header><span>当前任务</span><b>{projectTasks.length}</b></header>
              <div>
                {projectTasks.slice(0, 8).map((task) => {
                  const worker = workerAgents.find((card) => card.agent.id === task.agentId)?.agent;
                  return <div key={task.id}>
                    <IconTask size={13} />
                    <span><strong>{task.title}</strong><small>{worker?.name ?? task.agentId} · {TASK_STATUS_META[task.status].label}</small></span>
                  </div>;
                })}
                {!workbenchLoading && projectTasks.length === 0 && <p>Hermes 派工后，真实任务会显示在这里</p>}
              </div>
            </section>

            <section className="quest-context-section quest-context-employees">
              <header><span>数字员工</span><b>{workerAgents.length}</b></header>
              <div>
                {workerAgents.slice(0, 10).map((card) => {
                  const fixed = settingsDraft?.workerAgentIds.includes(card.agent.id) ?? false;
                  return (
                    <div key={card.agent.id} data-fixed={fixed ? 'true' : 'false'}>
                      <span className="quest-context-avatar">{card.agent.name.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{card.agent.name}</strong><small>{card.agent.role || card.agent.engineId}</small></span>
                      <b>{fixed ? '固定' : '可调度'}</b>
                    </div>
                  );
                })}
                {workerAgents.length === 0 && <p>暂无可用数字员工</p>}
              </div>
            </section>

            <footer className={`quest-context-footer${standalone ? ' is-standalone' : ''}`}>
              {standalone ? (
                <button className="quest-main-console-button" type="button" onClick={() => void openMainConsole()}>
                  <IconHome size={13} />
                  <span><strong>主控制台</strong><small>打开全部功能菜单</small></span>
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setRoute('projects')}><IconFolder size={13} />项目中心</button>
                  <button type="button" onClick={() => setRoute('agents')}><IconUser size={13} />数字员工</button>
                </>
              )}
            </footer>
          </aside>
        )}

        <div className="quest-embedded-column">
          <div
            ref={embeddedHostRef}
            className={`quest-embedded-host is-${embedPhase}`}
            aria-busy={embedPhase === 'opening'}
          >
            {embedPhase === 'opening' && <div className="quest-embedded-state"><span className="quest-state-spinner" />{startupLabel}</div>}
            {embedPhase === 'unavailable' && <div className="quest-embedded-state"><IconAlert size={20} /><strong>Hermes 项目服务不可用</strong><button className="btn small" type="button" onClick={toggleSetup}>打开连接设置</button></div>}
            {embedPhase === 'error' && <div className="quest-embedded-state error"><IconAlert size={20} /><strong>Hermes 工作区连接失败</strong><span>{embedError}</span><div className="quest-embedded-state-actions"><button className="btn small" type="button" onClick={() => retryEmbed()}><IconRefresh size={13} />重试</button><button className="btn small" type="button" onClick={toggleSetup}>连接设置</button></div></div>}
          </div>
        </div>

        {mobileOpen && (
          <div className="quest-mobile-modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMobileOpen(false);
          }}>
            <div className="quest-mobile-modal" role="dialog" aria-modal="true" aria-label="手机 Hermes 对话">
              <QuestMobileAccess
                projectId={project.id}
                projectName={project.name}
                onRunningChange={setMobileRunning}
                onClose={() => setMobileOpen(false)}
              />
            </div>
          </div>
        )}

        {artifactsOpen && (
          <ProjectArtifactsPanel
            projectId={project.id}
            projectName={project.name}
            onChooseWorkspace={openProjectDirectory}
          />
        )}

        {setupOpen && (
          <QuestRuntimeSetup
            workerCount={workerAgents.length}
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
                <div><span>已完成</span><strong>{projectTasks.filter((task) => task.status === 'COMPLETED').length}</strong></div>
                <div><span>协作成员</span><strong>{teamSize}</strong></div>
                <div><span>Token</span><strong>{formatTokens(workbench?.usage.totalTokens ?? 0)}</strong></div>
              </div>

              {!standalone && (
                <section className="quest-governance-section quest-governance-shortcuts">
                  <header><span>业务入口</span></header>
                  <div>
                    <button type="button" onClick={() => setRoute('tasks')}><IconTask size={13} /><span>任务</span></button>
                    <button type="button" onClick={() => setRoute('deliverables')}><IconFile size={13} /><span>成果</span></button>
                    <button type="button" onClick={() => setRoute('plugins')}><IconPlug size={13} /><span>插件</span></button>
                    <button type="button" onClick={() => setRoute('channels')}><IconPhone size={13} /><span>渠道</span></button>
                  </div>
                </section>
              )}

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
                        placeholder="Hermes 默认"
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
                      <span>固定员工池（不选择则由主 Agent 动态组队）</span>
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

              <section className="quest-governance-section quest-governance-acceptance" data-nexus-acceptance-status>
                <header><span><IconCheck size={14} />主秘书验收</span><b className={`is-${validationTone}`}>{validationLabel}</b></header>
                {latestValidationTask ? (
                  <div className="quest-governance-acceptance-detail">
                    <strong>{latestValidationTask.title}</strong>
                    <span>{latestValidationTask.agentId} · {hermesRelatedTaskCount(latestValidationTask)} 项实现任务</span>
                    <small>{validationVerdict ? `权威结论：${validationVerdict}` : '等待独立验收员工返回权威结论'}</small>
                  </div>
                ) : (
                  <p className="quest-governance-empty">复杂交付完成后，主秘书必须让未参与实现的子 Agent 独立验收；没有 PASS 不会正式交付。</p>
                )}
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
                  {projectTeam.slice(0, 8).map((member) => (
                    <div key={member.agentId}>
                      <span><strong>{member.name}</strong><small>{member.role || member.engineId}</small></span>
                      <b>{member.activeTasks > 0 ? `${member.activeTasks} 项进行中` : `${member.totalTasks} 项任务`}</b>
                    </div>
                  ))}
                  {!workbenchLoading && teamSize === 0 && <span className="quest-governance-empty">团队将在派工后显示</span>}
                </div>
              </section>

              {recentProjectTasks.length > 0 && (
                <section className="quest-governance-section quest-governance-activity">
                  <header><span>最近活动</span></header>
                  {recentProjectTasks.slice(0, 6).map((task) => (
                    <div key={task.id}>
                      <i />
                      <span><strong>{task.title} · {TASK_STATUS_META[task.status].label}</strong><small>{formatUpdatedAt(task.endedAt ?? task.startedAt ?? task.createdAt)}</small></span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </aside>
        )}

        {pluginsOpen && (
          <aside className="quest-plugin-drawer" aria-label="Quest 项目能力">
            <div className="quest-plugin-head">
              <div>
                <strong>Quest 能力</strong>
                <span>选择已真实接入 Hermes 的 MCP 与技能</span>
              </div>
              <button
                type="button"
                disabled={pluginsLoading}
                onClick={() => void loadPluginCatalog()}
                title="刷新插件状态"
                aria-label="刷新插件状态"
              >
                <IconRefresh size={14} />
              </button>
            </div>

            <div className="quest-plugin-scroll" aria-busy={pluginsLoading}>
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
              {pluginsLoading && (
                <div className="quest-plugin-loading"><span className="quest-state-spinner" />正在读取统一插件目录</div>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Activity, AlertCircle, ArrowDown, AtSign, Bot, BrainCircuit, ChevronRight, CircleStop, ExternalLink, FileUp, Paperclip, Plus, RefreshCw, RotateCcw, Send, UserRound, Users, Wrench, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number | null;
  activities: ChatActivity[];
};

type ChatActivity = {
  id: string;
  kind: "reasoning" | "tool_call" | "tool_result" | "system";
  title: string;
  status: "running" | "completed" | "failed" | "cancelled";
  toolName: string | null;
  detail: string | null;
  startedAt: number | null;
  updatedAt: number | null;
};

type History = {
  projectId: string;
  conversationId: string | null;
  hermesSessionId: string | null;
  messages: Message[];
};

type Clarification = {
  clarifyId: string;
  conversationId: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowOther: boolean;
};

type Conversation = {
  conversationId: string;
  title: string;
  employee: Employee | null;
  hasSession: boolean;
  updatedAt: number;
};

type Employee = {
  id: string;
  name: string;
  role: string;
  engineId: string;
  memoryMode: "long_term" | "short_term" | "none";
};

type ProjectPlugin = {
  id: string;
  name: string;
  kind: "skill" | "mcp";
  status: "ready" | "blocked";
  tools: Array<{ name: string; description: string }>;
};

type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string | null;
};

type UploadedAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  url: string;
};

type QueueItem = {
  id: string;
  projectId: string;
  conversationId: string;
  message: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  queuePosition: number | null;
  attempts: number;
  partialContent: string;
  activities: ChatActivity[];
  error: string | null;
  cancelRequestedAt: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

type QueueEvent = {
  type: "chat.queue.updated" | "chat.queue.delta" | "project.events.ready" | "project.state.updated";
  queueId?: string;
  conversationId?: string;
  item?: QueueItem;
  delta?: string;
};

type ProjectTask = {
  taskId: string;
  title: string;
  status: string;
  progress: number;
  intent: "execution" | "status_inquiry" | "validation";
  validationVerdict: "PASS" | "FAIL" | "BLOCKED" | null;
  relatedTaskIds: string[];
  worker: { id: string; name: string; role: string; engineId: string };
};

type ProjectState = {
  runtimeState: string;
  clarifications: Clarification[];
  employees: Employee[];
  plugins: ProjectPlugin[];
  plans: Array<{ draftId: string; status: string; version: number }>;
  tasks: ProjectTask[];
  orchestration: {
    scheduler: "Hermes";
    workerSelectionMode: "dynamic" | "restricted";
    workerAgentIds: string[];
    maxParallel: number;
    permissionMode: string;
    sandbox: string;
  };
};
type Envelope<T> = { ok: true; result: T } | { ok: false; error: string };

const TERMINAL_TASK_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const SLASH_COMMANDS = [
  { command: "/help", description: "查看 Quest 命令" },
  { command: "/new", description: "新建 Hermes 会话" },
  { command: "/agent ", description: "指定数字员工执行任务" },
  { command: "/mode ", description: "选择 auto / plan / execute / research" },
  { command: "/skill ", description: "调用当前项目已启用技能" },
  { command: "/mcp ", description: "调用当前项目已启用 MCP 工具" },
  { command: "/plan ", description: "以计划模式执行一次任务" },
  { command: "/execute ", description: "以执行模式执行一次任务" },
  { command: "/research ", description: "联网检索并核验来源" },
];

type SlashSuggestion = {
  key: string;
  value: string;
  label: string;
  description: string;
  kind: "command" | "mode" | "agent" | "skill" | "mcp";
};

function searchable(value: string): string {
  return value.toLocaleLowerCase("zh-CN");
}

function pluginTarget(plugin: ProjectPlugin): string {
  const prefix = `${plugin.kind}:`;
  return plugin.id.startsWith(prefix) ? plugin.id.slice(prefix.length) : plugin.id;
}

function buildSlashSuggestions(
  draft: string,
  employees: readonly Employee[],
  plugins: readonly ProjectPlugin[],
): SlashSuggestion[] {
  if (!draft.startsWith("/") || draft.includes("\n")) return [];
  const commandMatch = /^\/([a-z]*)$/i.exec(draft);
  if (commandMatch) {
    const query = `/${commandMatch[1]!.toLowerCase()}`;
    return SLASH_COMMANDS
      .filter((item) => item.command.trim().startsWith(query))
      .map((item) => ({
        key: item.command,
        value: item.command,
        label: item.command,
        description: item.description,
        kind: "command" as const,
      }));
  }

  const targetMatch = /^\/(mode|agent|skill|mcp)\s+([^\s]*)$/i.exec(draft);
  if (!targetMatch) return [];
  const command = targetMatch[1]!.toLowerCase();
  const query = searchable(targetMatch[2] ?? "");
  if (command === "mode") {
    return [
      { value: "auto", description: "由 Hermes 判断是否需要计划和派工" },
      { value: "plan", description: "先形成计划和边界，再等待批准" },
      { value: "execute", description: "按已明确的要求直接执行" },
      { value: "research", description: "联网检索并核验来源" },
    ].filter((item) => item.value.startsWith(query)).map((item) => ({
      key: `mode:${item.value}`,
      value: `/mode ${item.value} `,
      label: item.value,
      description: item.description,
      kind: "mode" as const,
    }));
  }
  if (command === "agent") {
    return employees.filter((employee) => [employee.id, employee.name, employee.role]
      .some((value) => searchable(value).includes(query)))
      .slice(0, 16)
      .map((employee) => ({
        key: `agent:${employee.id}`,
        value: `/agent ${employee.id} `,
        label: employee.name,
        description: `${employee.role} · ${employee.memoryMode === "long_term" ? "长期记忆" : employee.memoryMode === "none" ? "无记忆" : "当前会话"}`,
        kind: "agent" as const,
      }));
  }
  if (command === "skill") {
    return plugins.filter((plugin) => plugin.kind === "skill" && plugin.status === "ready")
      .filter((plugin) => [plugin.id, plugin.name].some((value) => searchable(value).includes(query)))
      .slice(0, 16)
      .map((plugin) => ({
        key: plugin.id,
        value: `/skill ${pluginTarget(plugin)} `,
        label: plugin.name,
        description: "当前项目已启用 Skill",
        kind: "skill" as const,
      }));
  }

  const suggestions: SlashSuggestion[] = [];
  for (const plugin of plugins.filter((item) => item.kind === "mcp" && item.status === "ready" && item.tools.length > 0)) {
    const target = pluginTarget(plugin);
    const serverSearch = searchable(`${target} ${plugin.id} ${plugin.name}`);
    if (serverSearch.includes(query)) {
      suggestions.push({
        key: plugin.id,
        value: `/mcp ${target} `,
        label: plugin.name,
        description: `${plugin.tools.length} 个可用工具，由 Hermes 选择`,
        kind: "mcp",
      });
    }
    for (const tool of plugin.tools) {
      if (!searchable(`${target}/${tool.name} ${plugin.name} ${tool.description}`).includes(query)) continue;
      suggestions.push({
        key: `${plugin.id}/${tool.name}`,
        value: `/mcp ${target}/${tool.name} `,
        label: `${plugin.name} / ${tool.name}`,
        description: tool.description || "当前项目可用 MCP 工具",
        kind: "mcp",
      });
    }
  }
  return suggestions.slice(0, 24);
}

/** Fast UX guard only. Main repeats strict parsing and owns authorization. */
function slashDraftError(message: string): string | null {
  if (!message.startsWith("/")) return null;
  if (message === "/") return "Quest 命令无效：请输入完整命令，例如 /plan 创建官网";
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/u.exec(message);
  if (!match) return "Quest 命令无效：命令格式不正确";
  const command = match[1]!.toLowerCase();
  const rest = match[2]?.trim() ?? "";
  if (command === "help" || command === "new") {
    return rest ? `Quest 命令无效：/${command} 不接受额外参数` : null;
  }
  if (!["mode", "plan", "execute", "research", "agent", "skill", "mcp"].includes(command)) {
    return `Quest 命令无效：不支持 /${command}`;
  }
  if (["plan", "execute", "research"].includes(command)) {
    return rest ? null : `Quest 命令无效：/${command} 后还需要任务描述`;
  }
  if (!rest) return `Quest 命令无效：/${command} 后还需要目标和任务描述`;

  if (command === "mode") {
    const modeMatch = /^(\S+)(?:\s+([\s\S]*\S))$/u.exec(rest);
    if (!modeMatch) return "Quest 命令无效：/mode 后还需要任务描述";
    if (!["auto", "plan", "execute", "research"].includes(modeMatch[1]!.toLowerCase())) {
      return "Quest 命令无效：/mode 只支持 auto、plan、execute 或 research";
    }
    return null;
  }

  const targetAndTask = /^(?:"(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+'|\S+)\s+[\s\S]*\S$/u;
  return targetAndTask.test(rest)
    ? null
    : `Quest 命令无效：/${command} 后还需要目标和任务描述`;
}

function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const fromItems = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  const files = fromItems.length > 0 ? fromItems : Array.from(transfer.files ?? []);
  return files.filter((file, index) => files.findIndex((candidate) => (
    candidate.name === file.name
    && candidate.size === file.size
    && candidate.lastModified === file.lastModified
  )) === index);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    APPROVED: "已批准",
    CANCELLED: "已取消",
    COMPLETED: "已完成",
    DISPATCHED: "已派工",
    ERROR: "异常",
    FAILED: "失败",
    HEALTHY: "在线",
    IDLE: "空闲",
    INTERRUPTED: "已中断",
    PAUSED: "已暂停",
    PENDING_APPROVAL: "待批准",
    QUEUED: "排队中",
    READY: "就绪",
    RUNNING: "执行中",
    STARTING: "启动中",
    STOPPED: "已停止",
    WAITING_APPROVAL: "待批准",
  };
  return labels[status.toUpperCase()] ?? status;
}

function statusTone(status: string): string {
  const normalized = status.toUpperCase();
  if (["FAILED", "ERROR", "INTERRUPTED"].includes(normalized)) return "text-destructive";
  if (["RUNNING", "STARTING", "QUEUED"].includes(normalized)) return "text-primary";
  if (["COMPLETED", "HEALTHY", "READY", "IDLE", "DISPATCHED"].includes(normalized)) return "text-success";
  return "text-warning";
}

function activityStatusLabel(status: ChatActivity["status"]): string {
  return {
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status];
}

function ActivityDisclosure({ activity }: { activity: ChatActivity }) {
  const [open, setOpen] = useState(activity.status === "running");
  const tone = activity.status === "failed"
    ? "text-destructive"
    : activity.status === "running"
      ? "text-primary"
      : activity.status === "cancelled"
        ? "text-warning"
        : "text-text-secondary";
  return (
    <details
      className="nexus-activity overflow-hidden border border-current/15 bg-background-base/45"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-nexus-activity={activity.kind}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-primary/5">
        {activity.kind === "reasoning"
          ? <BrainCircuit className="size-3.5 shrink-0 text-primary" />
          : <Wrench className="size-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={activity.title}>{activity.title}</span>
        <span className={cn("shrink-0", tone)}>{activityStatusLabel(activity.status)}</span>
        <ChevronRight className="nexus-activity-chevron size-3.5 shrink-0 text-text-secondary transition-transform" />
      </summary>
      {activity.detail && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-current/10 px-3 py-2 text-xs leading-relaxed text-text-secondary"><code>{activity.detail}</code></pre>
      )}
    </details>
  );
}

function ActivityList({ activities }: { activities: ChatActivity[] }) {
  if (activities.length === 0) return null;
  return (
    <div className="my-2 space-y-1.5" aria-label="思考与执行过程" data-nexus-activity-list>
      {activities.map((activity) => <ActivityDisclosure key={activity.id} activity={activity} />)}
    </div>
  );
}

function HistoryMessage({ message, assistantLabel }: { message: Message; assistantLabel: string }) {
  if ((message.role === "system" || message.role === "tool") && !message.content) {
    return <div className="mr-auto w-full max-w-[94%] sm:max-w-[88%]"><ActivityList activities={message.activities} /></div>;
  }
  return (
    <article
      className={cn(
        "max-w-[94%] rounded-lg border px-4 py-3 shadow-sm sm:max-w-[88%]",
        message.role === "user"
          ? "ml-auto border-primary/30 bg-primary/10"
          : "mr-auto border-current/15 bg-secondary/20",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-secondary">
        <span className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full",
          message.role === "user" ? "bg-primary/15 text-primary" : "bg-current/10 text-text-primary",
        )}>
          {message.role === "user" ? <UserRound className="size-3" /> : <Bot className="size-3" />}
        </span>
        <span>{message.role === "user" ? "老板" : message.role === "assistant" ? assistantLabel : message.role}</span>
      </div>
      <ActivityList activities={message.activities} />
      {message.content && <Markdown content={message.content} />}
    </article>
  );
}

/**
 * A running queue item is an optimistic projection of the owner message.
 * Hermes persists that same message before streaming the assistant response,
 * so rendering both projections makes one send look duplicated. Match only a
 * very recent, same-content user message so two intentional identical sends
 * remain visible as separate turns.
 */
function queueMessageAlreadyInHistory(item: QueueItem, history: History | null): boolean {
  const message = item.message.trim();
  if (!message || !history) return false;
  return history.messages.some((candidate) => {
    if (candidate.role !== "user" || candidate.content.trim() !== message) return false;
    return candidate.timestamp !== null && candidate.timestamp >= item.createdAt - 1_000;
  });
}

async function projectRequest<T>(operation: string, payload?: unknown): Promise<T> {
  const csrf = payload === undefined
    ? null
    : document.cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("__Host-opc_hermes_csrf="));
  const csrfValue = csrf ? decodeURIComponent(csrf.slice(csrf.indexOf("=") + 1)) : null;
  const response = await fetch(`/__opc_nexus/project/${operation}`, {
    method: payload === undefined ? "GET" : "POST",
    credentials: "include",
    headers: payload === undefined ? undefined : {
      "content-type": "application/json",
      ...(csrfValue ? { "x-opc-csrf": csrfValue } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(operation === "chat-history" ? 12_000 : 30_000),
  });
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.ok) {
    throw new Error("error" in body ? body.error : `Request failed (${response.status})`);
  }
  return body.result;
}

export default function NexusChatPage({ isActive = true }: { isActive?: boolean }) {
  const canPopout = window.__OPC_NEXUS_PROJECT_MODE__ === "desktop";
  const isMobileOperator = window.__OPC_NEXUS_PROJECT_MODE__ === "mobile-operator";
  const showEmbeddedOrchestration = isMobileOperator;
  const [history, setHistory] = useState<History | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [closedTabs, setClosedTabs] = useState<Set<string>>(() => new Set());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get("conversationId")
  ));
  const [clarifications, setClarifications] = useState<Clarification[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachmentsByConversation, setAttachmentsByConversation] = useState<Record<string, PendingAttachment[]>>({});
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [draggingAttachment, setDraggingAttachment] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [retryConfirmationId, setRetryConfirmationId] = useState<string | null>(null);
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [slashHelpOpen, setSlashHelpOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const activeConversationRef = useRef(activeConversationId);
  const conversationRequestRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const projectStateRef = useRef<ProjectState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsByConversationRef = useRef<Record<string, PendingAttachment[]>>({});

  const conversationStateKey = activeConversationId ?? "__new_conversation__";
  const draft = drafts[conversationStateKey] ?? "";
  const pendingAttachments = attachmentsByConversation[conversationStateKey] ?? [];
  const setDraft = useCallback((value: string | ((current: string) => string)) => {
    setDrafts((current) => {
      const previous = current[conversationStateKey] ?? "";
      const next = typeof value === "function" ? value(previous) : value;
      if (next === previous) return current;
      return { ...current, [conversationStateKey]: next };
    });
  }, [conversationStateKey]);
  const applySlashSuggestion = useCallback((value: string) => {
    setDraft(value);
    window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(value.length, value.length);
    });
  }, [setDraft]);
  const setPendingAttachments = useCallback((value: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])) => {
    setAttachmentsByConversation((current) => {
      const previous = current[conversationStateKey] ?? [];
      const next = typeof value === "function" ? value(previous) : value;
      if (next === previous) return current;
      return { ...current, [conversationStateKey]: next };
    });
  }, [conversationStateKey]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const trackHistoryScroll = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const atLatest = distance <= 96;
    followLatestRef.current = atLatest;
    setShowJumpToLatest(!atLatest);
  }, []);

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
    if (activeConversationId) document.documentElement.dataset.nexusConversationId = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    attachmentsByConversationRef.current = attachmentsByConversation;
  }, [attachmentsByConversation]);

  useEffect(() => {
    projectStateRef.current = projectState;
  }, [projectState]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 192)}px`;
  }, [activeConversationId, draft]);

  useEffect(() => () => {
    for (const attachments of Object.values(attachmentsByConversationRef.current)) {
      for (const pending of attachments) {
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
      }
    }
  }, []);

  const refreshProjectState = useCallback(async (): Promise<ProjectState | null> => {
    try {
      const state = await projectRequest<ProjectState>("state");
      projectStateRef.current = state;
      setClarifications(state.clarifications);
      setEmployees(state.employees);
      setProjectState(state);
      return state;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Hermes project state is unavailable");
      return projectStateRef.current;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const requestId = ++conversationRequestRef.current;
    // Runtime health is an independent Main-owned fact. Start this request
    // outside the conversation sequence so a slow history/queue response or
    // a tab switch cannot discard HEALTHY and leave the composer disabled.
    const statePromise = refreshProjectState();
    try {
      const [nextConversations, nextQueue] = await Promise.all([
        projectRequest<Conversation[]>("conversations"),
        projectRequest<QueueItem[]>("chat-queue"),
      ]);
      const visible = nextConversations.filter((item) => !closedTabs.has(item.conversationId));
      if (requestId !== conversationRequestRef.current) return;
      const requested = activeConversationRef.current;
      const selected = requested && visible.some((item) => item.conversationId === requested)
        ? requested
        : visible[0]?.conversationId ?? null;
      if (selected !== activeConversationRef.current) {
        activeConversationRef.current = selected;
        setActiveConversationId(selected);
      }
      if (requestId !== conversationRequestRef.current || selected !== activeConversationRef.current) return;
      setConversations(nextConversations);
      setHistory((current) => (
        current?.conversationId === selected
          ? current
          : { projectId: "", conversationId: selected, hermesSessionId: null, messages: [] }
      ));
      setQueue(nextQueue);
      setError(null);

      // The dashboard becomes available before the execution Gateway on a
      // cold start. History is Gateway-backed, so asking for it while Main
      // honestly reports STARTING would turn normal startup into a fatal
      // banner. Once Main reports HEALTHY, refresh history without blocking
      // the state/queue projection above.
      const state = await statePromise;
      if (selected && state?.runtimeState === "healthy") {
        const nextHistory = await projectRequest<History>("chat-history", { conversationId: selected });
        if (requestId !== conversationRequestRef.current || selected !== activeConversationRef.current) return;
        setHistory(nextHistory);
      }
    } catch (reason) {
      if (requestId !== conversationRequestRef.current) return;
      setError(reason instanceof Error ? reason.message : "Hermes project conversation is unavailable");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [closedTabs, refreshProjectState]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [isActive, refresh]);

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/__opc_nexus/project/events`);
      socket.addEventListener("message", (event) => {
        let frame: QueueEvent;
        try { frame = JSON.parse(String(event.data)) as QueueEvent; }
        catch { return; }
        if (frame.type === "project.events.ready") {
          void refreshProjectState();
          void refresh();
          return;
        }
        if (frame.type === "project.state.updated") {
          void refreshProjectState();
          return;
        }
        if (frame.type === "chat.queue.delta" && frame.queueId && frame.delta) {
          setQueue((items) => items.map((item) => item.id === frame.queueId
            ? { ...item, status: "RUNNING", partialContent: `${item.partialContent}${frame.delta}` }
            : item));
          return;
        }
        if (frame.type === "chat.queue.updated" && frame.item) {
          setQueue((items) => {
            const remaining = items.filter((item) => item.id !== frame.item!.id);
            return frame.item!.status === "COMPLETED"
              ? remaining
              : [...remaining, frame.item!].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
          });
          if (frame.item.status === "COMPLETED") void refresh();
        }
      });
      socket.addEventListener("close", () => {
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [isActive, refresh, refreshProjectState]);

  useEffect(() => {
    if (!isActive) return;
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    const frame = window.requestAnimationFrame(() => scrollToLatest("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, isActive, scrollToLatest]);

  useEffect(() => {
    if (!isActive) return;
    if (!followLatestRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => scrollToLatest("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [history?.messages.length, isActive, queue, scrollToLatest]);

  const send = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (sendInFlightRef.current) return;
    const message = draft.trim();
    if (!message && pendingAttachments.length === 0) return;
    scrollToLatest("smooth");
    if (message === "/help") {
      setDraft("");
      setSlashHelpOpen(true);
      return;
    }
    if (message === "/new" && pendingAttachments.length > 0) {
      setError("/new 不能携带附件；请先新建会话，再添加附件。");
      return;
    }
    if (message === "/new") {
      setDraft("");
      setSlashHelpOpen(false);
      try {
        const created = await projectRequest<Conversation>("create-conversation");
        conversationRequestRef.current += 1;
        setConversations((items) => [created, ...items.filter((item) => item.conversationId !== created.conversationId)]);
        setActiveConversationId(created.conversationId);
        activeConversationRef.current = created.conversationId;
        setHistory({ projectId: "", conversationId: created.conversationId, hermesSessionId: null, messages: [] });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "无法创建会话");
      }
      return;
    }
    const commandError = slashDraftError(message);
    if (commandError) {
      setError(commandError);
      return;
    }
    if (projectState?.runtimeState !== "healthy") {
      setError("Hermes 执行引擎仍在启动，请稍候再发送。输入内容已保留。");
      return;
    }
    // This guard only covers the short request/upload window. Once the queue
    // item is accepted, the composer is available for the next instruction.
    sendInFlightRef.current = true;
    setSendInFlight(true);
    setSlashHelpOpen(false);
    setDraft("");
    setError(null);
    try {
      let conversationId = activeConversationId ?? history?.conversationId ?? null;
      if (!conversationId) {
        const created = await projectRequest<Conversation>("create-conversation");
        conversationId = created.conversationId;
        conversationRequestRef.current += 1;
        setConversations((items) => [created, ...items.filter((item) => item.conversationId !== created.conversationId)]);
        setActiveConversationId(created.conversationId);
        activeConversationRef.current = created.conversationId;
        setHistory({ projectId: "", conversationId: created.conversationId, hermesSessionId: null, messages: [] });
      }
      const files = pendingAttachments;
      setUploadingAttachments(files.length > 0);
      const uploaded: UploadedAttachment[] = [];
      for (const pending of files) {
        const response = await fetch("/__opc_nexus/project/upload-attachment", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": pending.file.type || "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(pending.file.name)}`,
            "x-conversation-id": conversationId,
          },
          body: pending.file,
        });
        const body = await response.json() as Envelope<UploadedAttachment>;
        if (!response.ok || !body.ok) throw new Error("error" in body ? body.error : `附件上传失败 (${response.status})`);
        uploaded.push(body.result);
      }
      const result = await projectRequest<QueueItem>("enqueue-chat-turn", {
        message: message || "请分析我附加的文件。",
        conversationId,
        ...(uploaded.length > 0 ? { attachmentIds: uploaded.map((attachment) => attachment.id) } : {}),
      });
      setActiveConversationId(result.conversationId);
      activeConversationRef.current = result.conversationId;
      setClosedTabs((items) => {
        const next = new Set(items);
        next.delete(result.conversationId);
        return next;
      });
      setHistory((current) => current ? { ...current, conversationId: result.conversationId } : current);
      setQueue((items) => [...items.filter((item) => item.id !== result.id), result]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
      for (const pending of files) {
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
      }
      setPendingAttachments((current) => current.filter((pending) => !files.some((file) => file.id === pending.id)));
      void refresh();
    } catch (reason) {
      setDraft((current) => current.trim() ? current : message);
      setError(reason instanceof Error ? reason.message : "Hermes 无法接收这条任务");
    } finally {
      sendInFlightRef.current = false;
      setSendInFlight(false);
      setUploadingAttachments(false);
    }
  }, [activeConversationId, draft, history?.conversationId, pendingAttachments, projectState?.runtimeState, refresh, scrollToLatest]);

  const chooseAttachments = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const candidates = Array.from(files);
    const valid = candidates.filter((file) => file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES);
    const room = Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length);
    const next = valid.slice(0, room);
    if (valid.length < candidates.length) {
      setAttachmentNotice("已忽略空文件或超过 32 MB 的文件");
    } else if (next.length < valid.length) {
      setAttachmentNotice(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件`);
    } else {
      setAttachmentNotice(null);
    }
    if (next.length === 0) return;
    setPendingAttachments((current) => [
      ...current,
      ...next.map((file) => ({
        id: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
        file,
        previewUrl: file.type.startsWith("image/") || file.type.startsWith("video/")
          ? URL.createObjectURL(file)
          : null,
      }))
    ].slice(0, MAX_ATTACHMENTS));
  }, [pendingAttachments.length, setPendingAttachments]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const selectConversation = useCallback(async (conversationId: string) => {
    const requestId = ++conversationRequestRef.current;
    setActiveConversationId(conversationId);
    activeConversationRef.current = conversationId;
    setError(null);
    try {
      const nextHistory = await projectRequest<History>("chat-history", { conversationId });
      if (requestId !== conversationRequestRef.current || conversationId !== activeConversationRef.current) return;
      setHistory(nextHistory);
    } catch (reason) {
      if (requestId !== conversationRequestRef.current) return;
      setError(reason instanceof Error ? reason.message : "无法打开会话");
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const activate = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: unknown }>).detail;
      const conversationId = typeof detail?.conversationId === "string" ? detail.conversationId.trim() : "";
      if (!conversationId) return;
      document.documentElement.dataset.nexusConversationId = conversationId;
      if (conversationId === activeConversationRef.current) return;
      conversationRequestRef.current += 1;
      activeConversationRef.current = conversationId;
      setActiveConversationId(conversationId);
      setClosedTabs((items) => {
        const next = new Set(items);
        next.delete(conversationId);
        return next;
      });
      setError(null);
      void Promise.all([
        projectRequest<Conversation[]>("conversations"),
        projectRequest<History>("chat-history", { conversationId }),
      ]).then(([nextConversations, nextHistory]) => {
        if (activeConversationRef.current !== conversationId) return;
        if (!nextConversations.some((item) => item.conversationId === conversationId)) {
          throw new Error("The selected employee conversation is unavailable");
        }
        setConversations(nextConversations);
        setHistory(nextHistory);
      }).catch((reason) => {
        if (activeConversationRef.current !== conversationId) return;
        setError(reason instanceof Error ? reason.message : "无法切换员工会话");
      });
    };
    window.addEventListener("opc-nexus-conversation-change", activate);
    return () => window.removeEventListener("opc-nexus-conversation-change", activate);
  }, [isActive]);

  const createConversation = useCallback(async (employee?: Employee) => {
    if (creatingConversation) return;
    setCreatingConversation(true);
    setNewTabOpen(false);
    setError(null);
    try {
      const created = await projectRequest<Conversation>("create-conversation", employee ? { employeeId: employee.id } : {});
      conversationRequestRef.current += 1;
      setConversations((items) => [created, ...items.filter((item) => item.conversationId !== created.conversationId)]);
      setClosedTabs((items) => {
        const next = new Set(items);
        next.delete(created.conversationId);
        return next;
      });
      setActiveConversationId(created.conversationId);
      activeConversationRef.current = created.conversationId;
      setHistory({ projectId: "", conversationId: created.conversationId, hermesSessionId: null, messages: [] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建会话");
    } finally {
      setCreatingConversation(false);
    }
  }, [creatingConversation]);

  const closeConversation = useCallback((conversationId: string) => {
    const visible = conversations.filter((item) => item.conversationId !== conversationId && !closedTabs.has(item.conversationId));
    for (const attachment of attachmentsByConversationRef.current[conversationId] ?? []) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    setDrafts((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setAttachmentsByConversation((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setClosedTabs((items) => new Set(items).add(conversationId));
    if (activeConversationRef.current !== conversationId) return;
    const nextId = visible[0]?.conversationId ?? null;
    conversationRequestRef.current += 1;
    setActiveConversationId(nextId);
    activeConversationRef.current = nextId;
    if (nextId) void selectConversation(nextId);
    else setHistory({ projectId: "", conversationId: null, hermesSessionId: null, messages: [] });
  }, [closedTabs, conversations, selectConversation]);

  const popoutConversation = useCallback(async (conversationId: string) => {
    try { await projectRequest("popout-conversation", { conversationId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法弹出会话窗口"); }
  }, []);

  const answer = useCallback(async (clarifyId: string, value: string) => {
    const clean = value.trim();
    if (!clean || answering) return;
    setAnswering(clarifyId);
    setError(null);
    try {
      await projectRequest("answer-clarify", { clarifyId, answer: clean });
      setClarifications((items) => items.filter((item) => item.clarifyId !== clarifyId));
      setOtherAnswers((items) => ({ ...items, [clarifyId]: "" }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The clarification answer was not accepted");
    } finally {
      setAnswering(null);
    }
  }, [answering, refresh]);

  const retryQueueItem = useCallback(async (queueId: string) => {
    setError(null);
    try {
      const item = await projectRequest<QueueItem>("retry-chat-message", {
        queueId,
        confirmation: "retry-failed-turn",
      });
      setQueue((items) => [...items.filter((candidate) => candidate.id !== queueId), item]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
      setRetryConfirmationId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法重试这条任务");
    }
  }, []);

  const cancelQueueItem = useCallback(async (queueId: string) => {
    setError(null);
    try {
      const item = await projectRequest<QueueItem>("cancel-chat-message", { queueId });
      setQueue((items) => [...items.filter((candidate) => candidate.id !== queueId), item]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法取消这条任务");
    }
  }, []);

  const mention = (() => {
    const match = /(?:^|[\s(（[【{])@([^\s,，。.!！?？:：;；、)）\]}】]*)$/u.exec(draft);
    if (!match) return null;
    const query = match[1].toLocaleLowerCase("zh-CN");
    const start = draft.lastIndexOf("@");
    const matches = employees.filter((employee) => (
      employee.name.toLocaleLowerCase("zh-CN").includes(query)
      || employee.role.toLocaleLowerCase("zh-CN").includes(query)
    )).slice(0, 8);
    return { start, matches };
  })();

  const insertMention = useCallback((employee: Employee) => {
    if (!mention) return;
    setDraft((current) => `${current.slice(0, mention.start)}@${employee.name} `);
  }, [mention]);

  const visibleConversations = conversations.filter((item) => !closedTabs.has(item.conversationId));
  const activeConversation = visibleConversations.find((item) => item.conversationId === activeConversationId) ?? null;
  const assistantLabel = activeConversation?.employee?.name ?? "Hermes";
  const composerPlaceholder = `给 ${assistantLabel} 下达任务`;
  const slashSuggestions = buildSlashSuggestions(draft, employees, projectState?.plugins ?? []);
  const visibleClarifications = clarifications.filter((item) => (
    !activeConversationId || item.conversationId === activeConversationId
  ));
  const visibleQueue = queue.filter((item) => item.conversationId === activeConversationId);
  const activeTasks = (projectState?.tasks ?? []).filter((task) => (
    !TERMINAL_TASK_STATES.has(task.status)
  ));
  const validationTasks = projectState?.tasks.filter((task) => task.intent === "validation") ?? [];
  const activeValidationTasks = validationTasks.filter((task) => !TERMINAL_TASK_STATES.has(task.status));
  const latestValidationTask = validationTasks[0] ?? null;
  const validationLabel = latestValidationTask
    ? latestValidationTask.status === "COMPLETED"
      ? latestValidationTask.validationVerdict === "PASS" ? "验收通过" : latestValidationTask.validationVerdict === "FAIL" ? "验收未通过" : "验收被阻塞"
      : `验收${statusLabel(latestValidationTask.status)}`
    : "主秘书尚未派发独立验收";
  const validationTone = latestValidationTask?.status === "COMPLETED" && latestValidationTask.validationVerdict === "PASS"
    ? "text-success"
    : latestValidationTask?.status === "COMPLETED" && latestValidationTask.validationVerdict !== "PASS"
      ? "text-destructive"
      : latestValidationTask
        ? "text-primary"
        : "text-text-secondary";
  const completedTaskCount = (projectState?.tasks ?? []).filter((task) => task.status === "COMPLETED").length;
  const activePlans = (projectState?.plans ?? []).filter((plan) => (
    !["DISPATCHED", "REJECTED", "PROJECTION_FAILED"].includes(plan.status)
  ));
  const orchestrationPhase = visibleClarifications.length > 0
    ? "等待老板澄清"
    : activePlans.some((plan) => plan.status === "PROJECTED")
      ? "等待计划批准"
      : activeTasks.length > 0
        ? "Hermes 派工执行"
        : completedTaskCount > 0
          ? "汇总交付"
          : "等待老板下令";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex h-10 shrink-0 items-end gap-1 border-b border-current/15 bg-secondary/20 pt-1">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pl-2" data-nexus-conversation-tabs>
          {visibleConversations.map((conversation) => (
            <div
              key={conversation.conversationId}
              className={cn(
                "group flex h-9 min-w-32 max-w-56 shrink-0 items-center gap-2 border border-b-0 px-3 text-xs",
                activeConversationId === conversation.conversationId
                  ? "border-current/20 bg-background-base text-text-primary"
                  : "border-transparent text-text-secondary hover:bg-background-base/60",
              )}
              onContextMenu={canPopout ? (event) => {
                event.preventDefault();
                void popoutConversation(conversation.conversationId);
              } : undefined}
              title={canPopout ? "右键在独立窗口打开" : undefined}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => void selectConversation(conversation.conversationId)}
              >
                {conversation.employee ? `@${conversation.employee.name}` : conversation.title}
              </button>
              <button
                type="button"
                className="shrink-0 opacity-60 hover:opacity-100"
                aria-label="关闭会话标签"
                title="关闭标签"
                onClick={() => closeConversation(conversation.conversationId)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="relative mb-1 shrink-0">
          <Button ghost size="icon" aria-label="新建会话" title="新建会话" onClick={() => setNewTabOpen((open) => !open)}>
            <Plus />
          </Button>
          {newTabOpen && (
            <div className="absolute right-0 top-full z-[100] mt-1 max-h-72 w-64 overflow-y-auto border border-current/20 bg-background-base shadow-xl" data-nexus-new-tab-menu>
              <button type="button" className="flex w-full items-center gap-2 border-b border-current/10 px-3 py-2 text-left text-sm hover:bg-primary/10" onClick={() => void createConversation()}>
                <Plus className="size-4 text-primary" />Hermes 主会话
              </button>
              {employees.map((employee) => (
                <button key={employee.id} type="button" className="flex w-full items-start gap-2 border-b border-current/10 px-3 py-2 text-left last:border-b-0 hover:bg-primary/10" onClick={() => void createConversation(employee)}>
                  <AtSign className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0"><strong className="block truncate text-sm">{employee.name}</strong><small className="block truncate text-text-secondary">{employee.role}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
        {canPopout && activeConversationId && (
          <Button ghost size="icon" className="mb-1 mr-2 shrink-0" aria-label="独立窗口打开" title="独立窗口打开" onClick={() => void popoutConversation(activeConversationId)}>
            <ExternalLink />
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button ghost size="icon" aria-label="Retry" title="Retry" onClick={() => void refresh()}>
            <RefreshCw />
          </Button>
        </div>
      )}
      {!error && projectState && projectState.runtimeState !== "healthy" && (
        <div className="flex items-center gap-2 border-b border-primary/25 bg-primary/5 px-4 py-2 text-sm text-text-secondary" data-nexus-runtime-starting>
          <RefreshCw className="size-4 shrink-0 animate-spin text-primary" />
          <span>Hermes 对话界面已打开，执行引擎仍在启动。可以先输入，发送会在引擎就绪后启用。</span>
        </div>
      )}
      {slashHelpOpen && (
        <section className="shrink-0 border-b border-primary/30 bg-primary/5 px-4 py-3 text-xs" aria-label="Quest 斜杠命令">
          <div className="mb-2 flex items-center justify-between font-semibold text-text-primary">
            <span>Quest 命令</span>
            <button type="button" className="text-text-secondary hover:text-text-primary" onClick={() => setSlashHelpOpen(false)} aria-label="关闭命令帮助"><X className="size-3.5" /></button>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {SLASH_COMMANDS.map((item) => <button key={item.command} type="button" className="flex items-center gap-3 border border-current/10 px-2 py-1.5 text-left hover:bg-primary/10" onClick={() => { applySlashSuggestion(item.command); setSlashHelpOpen(false); }}><code className="text-primary">{item.command || "/"}</code><span className="text-text-secondary">{item.description}</span></button>)}
          </div>
        </section>
      )}

      {projectState && showEmbeddedOrchestration && (
        <details className="group shrink-0 border-b border-current/15 bg-secondary/10" aria-label="Hermes 调度运行状态" data-nexus-mobile-orchestration>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-text-secondary">
            <Activity className="size-4 shrink-0 text-primary" />
            <span className="font-semibold text-text-primary">Hermes {statusLabel(projectState.runtimeState)}</span>
            <span className="ml-auto whitespace-nowrap">{activeTasks.length} 项进行中 · {completedTaskCount} 项完成</span>
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mx-auto grid max-h-[45dvh] w-full max-w-5xl gap-3 overflow-y-auto border-t border-current/10 px-3 py-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
            <div className="min-w-0 border-l-2 border-primary px-3 py-1">
              <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-text-primary">
                <Activity className="size-4 shrink-0 text-primary" />
                <span>Hermes 调度</span>
                <span className={cn("ml-auto truncate font-normal", statusTone(projectState.runtimeState))}>
                  {statusLabel(projectState.runtimeState)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                <span>{projectState.orchestration.workerSelectionMode === "dynamic" ? "动态组团" : "限定员工"}</span>
                <span>并行 {projectState.orchestration.maxParallel}</span>
                <span>{projectState.orchestration.permissionMode}</span>
                <span>{projectState.orchestration.sandbox}</span>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-2 text-xs">
                <span className="shrink-0 text-text-secondary">当前流程</span>
                <span className="min-w-0 truncate text-text-primary" title={orchestrationPhase}>{orchestrationPhase}</span>
              </div>
              <div className="mt-2 text-xs text-text-secondary">
                {activePlans.length > 0
                  ? activePlans.map((plan) => `Hermes 计划 · v${plan.version} · ${statusLabel(plan.status)}`).join("  /  ")
                  : "当前没有待执行计划"}
              </div>
            </div>

            <div className="min-w-0 border-l border-current/15 px-3 py-1">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Users className="size-4 shrink-0 text-primary" />
                <span>数字员工 / Worker</span>
                <span className="ml-auto font-normal text-text-secondary">{activeTasks.length} 项进行中 · {completedTaskCount} 项已完成</span>
              </div>
              {activeTasks.length === 0 ? (
                <div className="text-xs text-text-secondary">尚未分配执行任务</div>
              ) : (
                <div className="max-h-28 space-y-2 overflow-y-auto pr-1">
                  {activeTasks.map((task) => (
                    <div key={task.taskId} className="min-w-0 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-text-primary" title={task.title}>{task.title}</span>
                        <span className="shrink-0 text-text-secondary">{task.worker.name}</span>
                        <span className={cn("shrink-0", statusTone(task.status))}>{statusLabel(task.status)}</span>
                        <span className="w-8 shrink-0 text-right tabular-nums text-text-secondary">{task.progress}%</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1 min-w-0 flex-1 overflow-hidden bg-current/10">
                          <div className="h-full bg-primary transition-[width]" style={{ width: `${task.progress}%` }} />
                        </div>
                        <span className="max-w-28 shrink-0 truncate text-text-secondary" title={task.worker.engineId}>
                          {task.worker.engineId || "未指定引擎"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 border-t border-current/10 pt-2 text-xs" data-nexus-acceptance-status>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-semibold text-text-primary">主秘书验收</span>
                  <span className={cn("min-w-0 truncate", validationTone)}>{validationLabel}</span>
                  {latestValidationTask && <span className="ml-auto shrink-0 text-text-secondary">{latestValidationTask.worker.name}</span>}
                </div>
                <div className="mt-1 text-text-secondary">
                  {latestValidationTask
                    ? `${latestValidationTask.relatedTaskIds.length} 项实现任务由独立员工复核${activeValidationTasks.length > 0 ? "中" : ""}`
                    : "复杂交付完成后，Hermes 主秘书必须询问未参与实现的子 Agent；没有 PASS 不会正式交付"}
                </div>
              </div>
            </div>

          </div>
        </details>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollViewportRef}
          className="h-full overflow-y-auto px-3 py-5 sm:px-6"
          onScroll={trackHistoryScroll}
          data-nexus-chat-scroll
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            {history?.messages.map((message) => (
              <HistoryMessage key={message.id} message={message} assistantLabel={assistantLabel} />
            ))}

          {!history?.messages.length && visibleQueue.length === 0 && !error && (
            <div className="py-16 text-center text-sm text-text-secondary">向 {assistantLabel} 下达任务</div>
          )}

          {visibleQueue.map((item) => (
            <div key={item.id} className="flex flex-col gap-3">
              {(() => {
                const ownerMessageVisible = !queueMessageAlreadyInHistory(item, history);
                return <>
              {ownerMessageVisible && <article className="ml-auto max-w-[94%] rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 shadow-sm sm:max-w-[88%]">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-secondary">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"><UserRound className="size-3" /></span>
                  <span>老板</span>
                  <span className={cn("font-normal", statusTone(item.status))}>
                    {item.status === "RUNNING" && item.cancelRequestedAt !== null
                      ? "正在取消"
                      : item.status === "QUEUED" && item.queuePosition
                      ? `排队中 · 第 ${item.queuePosition} 位`
                      : statusLabel(item.status)}
                  </span>
                  {(item.status === "QUEUED" || (item.status === "RUNNING" && item.cancelRequestedAt === null)) && (
                    <Button
                      ghost
                      size="icon"
                      className="ml-auto size-7"
                      aria-label="取消任务"
                      title="取消任务"
                      onClick={() => void cancelQueueItem(item.id)}
                    >
                      <CircleStop />
                    </Button>
                  )}
                </div>
                <Markdown content={item.message} />
              </article>
              }

              {(item.status === "RUNNING" || item.partialContent || item.activities.length > 0) && (
                <article className="mr-auto max-w-[94%] rounded-lg border border-current/15 bg-secondary/20 px-4 py-3 shadow-sm sm:max-w-[88%]">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-secondary">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-current/10 text-text-primary"><Bot className="size-3" /></span>
                    <span>{assistantLabel}</span>
                    {item.status === "RUNNING" && <RefreshCw className="size-3.5 animate-spin text-primary" />}
                    {!ownerMessageVisible && (item.status === "QUEUED" || (item.status === "RUNNING" && item.cancelRequestedAt === null)) && (
                      <Button
                        ghost
                        size="icon"
                        className="ml-auto size-7"
                        aria-label="取消任务"
                        title="取消任务"
                        onClick={() => void cancelQueueItem(item.id)}
                      >
                        <CircleStop />
                      </Button>
                    )}
                    <span className="font-normal">
                      {item.cancelRequestedAt !== null
                        ? `正在取消，等待 ${assistantLabel} 停止当前执行`
                        : item.partialContent ? "流式回复中" : "正在思考"}
                    </span>
                  </div>
                  <ActivityList activities={item.activities.length > 0 ? item.activities : item.status === "RUNNING" ? [{
                    id: `${item.id}:waiting`,
                    kind: "reasoning",
                    title: "等待 Hermes 首个执行事件",
                    status: "running",
                    toolName: null,
                    detail: null,
                    startedAt: item.startedAt,
                    updatedAt: item.updatedAt,
                  }] : []} />
                  {item.partialContent && <Markdown content={item.partialContent} streaming={item.status === "RUNNING"} />}
                </article>
              )}

              {item.status === "FAILED" && (
                <div className="mr-auto flex max-w-[92%] items-start gap-2 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{item.error || "Hermes 执行失败"}</span>
                  {retryConfirmationId === item.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button type="button" outlined size="sm" onClick={() => setRetryConfirmationId(null)}>取消</Button>
                      <Button type="button" size="sm" onClick={() => void retryQueueItem(item.id)}>确认重新执行</Button>
                    </div>
                  ) : (
                    <Button type="button" ghost size="icon" aria-label="重试任务" title="重试任务" onClick={() => setRetryConfirmationId(item.id)}>
                      <RotateCcw />
                    </Button>
                  )}
                </div>
              )}

              {item.status === "CANCELLED" && (
                <div className="mr-auto flex max-w-[92%] items-center gap-2 border border-current/20 bg-secondary/20 px-4 py-2 text-sm text-text-secondary">
                  <CircleStop className="size-4 shrink-0" />
                  <span>已由老板取消；{assistantLabel} 不会继续执行这条指令。</span>
                </div>
              )}
                </>;
              })()}
            </div>
          ))}

          {visibleClarifications.map((item) => (
            <section key={item.clarifyId} className="border-y border-warning/40 bg-warning/5 px-4 py-4">
              <div className="mb-3 text-sm font-semibold text-text-primary">{item.prompt}</div>
              {item.options.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {item.options.map((option) => (
                    <Button
                      key={option.id}
                      outlined
                      size="sm"
                      disabled={answering !== null}
                      onClick={() => void answer(item.clarifyId, option.label)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
              {item.allowOther && (
                <form
                  className="flex min-w-0 gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void answer(item.clarifyId, otherAnswers[item.clarifyId] ?? "");
                  }}
                >
                  <input
                    value={otherAnswers[item.clarifyId] ?? ""}
                    onChange={(event) => setOtherAnswers((answers) => ({ ...answers, [item.clarifyId]: event.target.value }))}
                    className="h-9 min-w-0 flex-1 border border-current/20 bg-background-base px-3 text-sm outline-none focus:border-primary"
                    placeholder="输入回答"
                    maxLength={8_000}
                  />
                  <Button type="submit" size="sm" disabled={answering !== null || !(otherAnswers[item.clarifyId] ?? "").trim()}>
                    提交
                  </Button>
                </form>
              )}
            </section>
          ))}
            <div ref={endRef} />
          </div>
        </div>
        {showJumpToLatest && (
          <Button
            type="button"
            className="absolute bottom-4 right-4 z-20 gap-1.5 shadow-lg"
            size="sm"
            aria-label="回到最新消息"
            title="回到最新消息"
            onClick={() => scrollToLatest("smooth")}
            data-nexus-jump-latest
          >
            <ArrowDown className="size-4" />最新消息
          </Button>
        )}
      </div>

      <form onSubmit={send} className="border-t border-current/15 bg-secondary/10 px-2.5 py-2.5 sm:px-6 sm:py-3.5">
        <div className="relative mx-auto w-full max-w-4xl">
          {mention && mention.matches.length > 0 && (
            <div className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-64 overflow-y-auto border border-current/20 bg-background-base shadow-xl">
              {mention.matches.map((employee) => (
                <button
                  key={employee.id}
                  type="button"
                  className="flex w-full items-start gap-3 border-b border-current/10 px-3 py-2 text-left last:border-b-0 hover:bg-primary/10"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertMention(employee)}
                >
                  <AtSign className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm text-text-primary">{employee.name}</strong>
                    <span className="block truncate text-xs text-text-secondary">{employee.role}</span>
                  </span>
                  <span className="shrink-0 text-xs text-text-secondary">{employee.memoryMode === "long_term" ? "长期记忆" : employee.memoryMode === "none" ? "无记忆" : "当前会话"}</span>
                </button>
              ))}
            </div>
          )}
          {slashSuggestions.length > 0 && (
            <div className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto border border-current/20 bg-background-base shadow-xl" data-nexus-slash-menu>
              {slashSuggestions.map((item) => (
                <button key={item.key} type="button" className="flex w-full items-center gap-3 border-b border-current/10 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-primary/10" onMouseDown={(event) => event.preventDefault()} onClick={() => applySlashSuggestion(item.value)}>
                  {item.kind === "agent" ? <AtSign className="size-4 shrink-0 text-primary" /> : item.kind === "mode" ? <Bot className="size-4 shrink-0 text-primary" /> : item.kind === "skill" || item.kind === "mcp" ? <Wrench className="size-4 shrink-0 text-primary" /> : null}
                  <span className="min-w-0 flex-1"><strong className="block truncate font-mono font-medium text-primary">{item.label}</strong><span className="block truncate text-xs text-text-secondary">{item.description}</span></span>
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              chooseAttachments(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <div
            className={cn(
              "relative overflow-hidden rounded-lg border bg-background-base shadow-sm transition-[border-color,box-shadow,background-color]",
              draggingAttachment
                ? "border-primary bg-primary/5 shadow-md"
                : "border-current/20 focus-within:border-primary/70 focus-within:shadow-md",
            )}
            data-nexus-composer
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDraggingAttachment(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDraggingAttachment(false);
            }}
            onDrop={(event) => {
              setDraggingAttachment(false);
              const files = filesFromTransfer(event.dataTransfer);
              if (files.length === 0) return;
              event.preventDefault();
              chooseAttachments(files);
            }}
          >
            {draggingAttachment && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-background-base/90" data-nexus-drop-overlay>
                <div className="flex items-center gap-2 text-sm font-medium text-primary">
                  <FileUp className="size-5" />
                  <span>添加到当前消息</span>
                </div>
              </div>
            )}
            <div className="flex min-h-9 min-w-0 items-center gap-2 border-b border-current/10 px-3 py-1.5 text-xs">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-primary"><Bot className="size-3.5" /></span>
              <strong className="min-w-0 truncate font-medium text-text-primary">{assistantLabel}</strong>
              {activeConversation?.employee?.role && (
                <span className="min-w-0 truncate text-text-secondary">{activeConversation.employee.role}</span>
              )}
              <span
                className={cn("ml-auto flex shrink-0 items-center gap-1.5", statusTone(projectState?.runtimeState ?? "starting"))}
                data-nexus-runtime-state={projectState?.runtimeState ?? "loading"}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {projectState === null ? "同步中" : projectState.runtimeState === "healthy" ? "就绪" : statusLabel(projectState.runtimeState)}
              </span>
            </div>
            {pendingAttachments.length > 0 && (
              <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto border-b border-current/10 p-2.5" data-nexus-attachment-tray>
                {pendingAttachments.map((pending) => (
                  <div key={pending.id} className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-current/15 bg-background-base px-2 py-1.5 text-xs shadow-sm">
                    {pending.previewUrl && pending.file.type.startsWith("image/")
                      ? <img src={pending.previewUrl} alt="" className="size-9 shrink-0 rounded object-cover" />
                      : pending.previewUrl && pending.file.type.startsWith("video/")
                        ? <video src={pending.previewUrl} muted className="size-9 shrink-0 rounded object-cover" />
                        : <span className="grid size-9 shrink-0 place-items-center rounded bg-primary/10"><FileUp className="size-4 text-primary" /></span>}
                    <span className="min-w-0 max-w-52">
                      <strong className="block truncate font-medium text-text-primary" title={pending.file.name}>{pending.file.name || "剪贴板文件"}</strong>
                      <small className="block text-text-secondary">{formatFileSize(pending.file.size)}</small>
                    </span>
                    <button type="button" className="grid size-6 shrink-0 place-items-center rounded text-text-secondary hover:bg-destructive/10 hover:text-destructive" aria-label={`移除附件 ${pending.file.name}`} title="移除附件" onClick={() => removeAttachment(pending.id)}>
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={composerInputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                const files = filesFromTransfer(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                chooseAttachments(files);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              maxLength={128_000}
              className="max-h-48 min-h-16 w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 pt-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-secondary/75"
              placeholder={composerPlaceholder}
            />
            <div className="flex min-h-11 items-center gap-1 px-2 py-1.5">
              <Button type="button" ghost size="icon" className="shrink-0" aria-label="添加图片、视频或文件" title="添加图片、视频或文件" onClick={() => fileInputRef.current?.click()}>
                <Paperclip />
              </Button>
              <Button type="button" ghost size="icon" className="shrink-0" aria-label="选择数字员工" title="选择数字员工" onClick={() => setDraft((current) => `${current}@`)}>
                <AtSign />
              </Button>
              <button type="button" className="grid size-9 shrink-0 place-items-center rounded-md font-mono text-base text-text-secondary hover:bg-primary/10 hover:text-text-primary" aria-label="打开 Quest 命令" title="打开 Quest 命令" onClick={() => setDraft((current) => current || "/")}>/</button>
              <span className="ml-auto min-w-0 truncate text-xs text-text-secondary">
                {uploadingAttachments ? "正在上传" : pendingAttachments.length > 0 ? `${pendingAttachments.length} 个附件` : ""}
              </span>
              <Button
                type="submit"
                size="icon"
                className="ml-1 shrink-0"
                aria-label="发送"
                title={sendInFlight
                  ? "正在提交任务"
                  : projectState === null
                  ? "正在同步 Hermes 状态"
                  : projectState.runtimeState === "healthy" ? "发送" : `Hermes ${statusLabel(projectState.runtimeState)}`}
                disabled={projectState?.runtimeState !== "healthy" || sendInFlight || uploadingAttachments || (!draft.trim() && pendingAttachments.length === 0)}
              >
                {sendInFlight || uploadingAttachments ? <RefreshCw className="animate-spin" /> : <Send />}
              </Button>
            </div>
          </div>
          {attachmentNotice && <div className="mt-1.5 px-1 text-xs text-warning">{attachmentNotice}</div>}
        </div>
      </form>
    </div>
  );
}

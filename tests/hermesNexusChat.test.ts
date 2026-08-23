import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Hermes Nexus chat source contract', () => {
  const source = readFileSync(join(
    process.cwd(), 'vendor', 'hermes-agent', 'web', 'src', 'pages', 'NexusChatPage.tsx'
  ), 'utf8');

  it('keeps input available while Main drains each conversation queue', () => {
    expect(source).toContain('projectRequest<QueueItem>("enqueue-chat-turn"');
    expect(source).toContain('/__opc_nexus/project/events');
    expect(source).toContain('frame.type === "chat.queue.delta"');
    expect(source).toContain('frame.type === "project.state.updated"');
    expect(source).toContain('pendingAttachments.length === 0');
    expect(source).toContain('uploadingAttachments ||');
    expect(source).toContain('projectState?.runtimeState !== "healthy"');
    expect(source).toContain('执行引擎仍在启动');
    expect(source).toContain('selected && state?.runtimeState === "healthy"');
    expect(source).toContain('const refreshProjectState = useCallback');
    expect(source).toContain('const projectStateRef = useRef<ProjectState | null>(null);');
    expect(source).toContain('const statePromise = refreshProjectState();');
    expect(source).toContain('Runtime health is an independent Main-owned fact');
    expect(source.indexOf('setProjectState(state);')).toBeLessThan(source.indexOf('projectRequest<History>("chat-history"'));
    expect(source).toContain('data-nexus-runtime-starting');
    expect(source).toContain('data-nexus-runtime-state={projectState?.runtimeState ?? "loading"}');
    expect(source).toContain('projectState === null ? "同步中"');
    expect(source).toContain('Hermes 对话界面已打开，执行引擎仍在启动');
    expect(source).not.toContain('disabled={busy}');
    expect(source).not.toContain('disabled={busy || !draft.trim()}');
  });

  it('prevents double-submit and does not render a persisted owner message twice', () => {
    expect(source).toContain('const sendInFlightRef = useRef(false);');
    expect(source).toContain('if (sendInFlightRef.current) return;');
    expect(source).toContain('sendInFlightRef.current = true;');
    expect(source).toContain('sendInFlightRef.current = false;');
    expect(source).toContain('function queueMessageAlreadyInHistory');
    expect(source).toContain('const ownerMessageVisible = !queueMessageAlreadyInHistory(item, history);');
    expect(source).toContain('sendInFlight || uploadingAttachments');
  });

  it('shows actual Hermes scheduling, worker assignments, and progress without legacy session duplication', () => {
    expect(source).toContain('aria-label="Hermes 调度运行状态"');
    expect(source).toContain('data-nexus-mobile-orchestration');
    expect(source).toContain('<details className="group');
    expect(source).toContain('{activeTasks.length} 项进行中 · {completedTaskCount} 项完成');
    expect(source).toContain('当前流程');
    expect(source).toContain('projectState.orchestration.workerSelectionMode');
    expect(source).toContain('activeTasks.map((task)');
    expect(source).toContain('{task.worker.name}');
    expect(source).toContain('{task.worker.engineId || "未指定引擎"}');
    expect(source).toContain('style={{ width: `${task.progress}%` }}');
    expect(source).not.toContain('projectState.workerSessions');
    expect(source).not.toContain('Worker / 子 Agent 会话');
    expect(source).toContain('item.partialContent');
    expect(source).toContain('retryQueueItem(item.id)');
    expect(source).toContain('confirmation: "retry-failed-turn"');
    expect(source).toContain('确认重新执行');
    expect(source).toContain('retryConfirmationId === item.id');
    expect(source).toContain('projectRequest<QueueItem>("cancel-chat-message"');
    expect(source).toContain('正在取消，等待 ${assistantLabel} 停止当前执行');
    expect(source).toContain('item.cancelRequestedAt === null');
    expect(source).toContain('已由老板取消；{assistantLabel} 不会继续执行这条指令。');
    expect(source).toContain('cancelQueueItem(item.id)');
    expect(source).toContain('aria-label="取消任务"');
  });

  it('exposes the secretary independent-acceptance state instead of implying execution completion is delivery', () => {
    expect(source).toContain('data-nexus-acceptance-status');
    expect(source).toContain('主秘书验收');
    expect(source).toContain('主秘书尚未派发独立验收');
    expect(source).toContain('validationVerdict');
    expect(source).toContain('relatedTaskIds.length');
    expect(source).toContain('没有 PASS 不会正式交付');
  });

  it('leaves authoritative scheduling detail to the OPC-Nexus right rail when embedded on desktop', () => {
    expect(source).toContain('const isMobileOperator = window.__OPC_NEXUS_PROJECT_MODE__ === "mobile-operator";');
    expect(source).toContain('const showEmbeddedOrchestration = isMobileOperator;');
    expect(source).toContain('{projectState && showEmbeddedOrchestration && (');
  });

  it('keeps desktop popout controls off the mobile Web surface', () => {
    expect(source).toContain('const canPopout = window.__OPC_NEXUS_PROJECT_MODE__ === "desktop"');
    expect(source).toContain('onContextMenu={canPopout ?');
    expect(source).toContain('{canPopout && activeConversationId && (');
  });

  it('keeps the new-conversation menu outside the horizontally clipped tab strip', () => {
    expect(source).toContain('data-nexus-conversation-tabs');
    expect(source).toContain('data-nexus-new-tab-menu');
    expect(source).toContain('absolute right-0 top-full z-[100]');
    expect(source).not.toContain('items-end gap-1 overflow-x-auto border-b');
  });

  it('rejects late history responses after the user switches employee tabs', () => {
    expect(source).toContain('const conversationRequestRef = useRef(0);');
    expect(source).toContain('const requestId = ++conversationRequestRef.current;');
    expect(source).toContain('requestId !== conversationRequestRef.current || selected !== activeConversationRef.current');
    expect(source).toContain('requestId !== conversationRequestRef.current || conversationId !== activeConversationRef.current');
  });

  it('bounds and serializes project history refreshes through the mobile gateway', () => {
    expect(source).toContain('const refreshInFlightRef = useRef(false);');
    expect(source).toContain('if (refreshInFlightRef.current) return;');
    expect(source).toContain('refreshInFlightRef.current = false;');
    expect(source).toContain('AbortSignal.timeout(operation === "chat-history" ? 12_000 : 30_000)');
    expect(source).toContain('"x-opc-csrf": csrfValue');
    expect(source).toContain('__Host-opc_hermes_csrf=');
    expect(source).not.toContain('__Host-opc_dsh_csrf=');
  });

  it('scopes drafts, attachments, and visible composer identity to each employee tab', () => {
    expect(source).toContain('const [drafts, setDrafts] = useState<Record<string, string>>({});');
    expect(source).toContain('const [attachmentsByConversation, setAttachmentsByConversation]');
    expect(source).toContain('const conversationStateKey = activeConversationId ?? "__new_conversation__";');
    expect(source).toContain('const composerPlaceholder = `给 ${assistantLabel} 下达任务`;');
    expect(source).toContain('placeholder={composerPlaceholder}');
    expect(source).toContain('向 {assistantLabel} 下达任务');
    expect(source).not.toContain('placeholder="给 Hermes 下达任务"');
    expect(source).toContain('window.addEventListener("opc-nexus-conversation-change", activate);');
    expect(source).toContain('document.documentElement.dataset.nexusConversationId = conversationId;');
    expect(source).toContain('projectRequest<History>("chat-history", { conversationId })');
    expect(source).toContain('onPaste={(event) => {');
    expect(source).toContain('filesFromTransfer(event.clipboardData)');
    expect(source).toContain('filesFromTransfer(event.dataTransfer)');
    expect(source).toContain('data-nexus-composer');
    expect(source).toContain('data-nexus-attachment-tray');
    expect(source).toContain('data-nexus-drop-overlay');
    expect(source).toContain('const composerInputRef = useRef<HTMLTextAreaElement | null>(null);');
    expect(source).toContain('input.style.height = `${Math.min(input.scrollHeight, 192)}px`;');
    expect(source).toContain('{formatFileSize(pending.file.size)}');
    expect(source).not.toContain('<code className="text-primary">{item.command}</code>');
  });

  it('offers only Main-projected employees, ready skills, and real MCP tools for slash commands', () => {
    expect(source).toContain('plugins: ProjectPlugin[];');
    expect(source).toContain('{ command: "/research ", description: "联网检索并核验来源" }');
    expect(source).toContain('function buildSlashSuggestions');
    expect(source).toContain('plugin.status === "ready"');
    expect(source).toContain('item.status === "ready" && item.tools.length > 0');
    expect(source).toContain('value: `/agent ${employee.id} `');
    expect(source).toContain('value: `/skill ${pluginTarget(plugin)} `');
    expect(source).toContain('value: `/mcp ${target}/${tool.name} `');
    expect(source).toContain('const slashSuggestions = buildSlashSuggestions(draft, employees, projectState?.plugins ?? []);');
    expect(source).toContain('slashSuggestions.length > 0');
    expect(source).toContain('input.setSelectionRange(value.length, value.length);');
    expect(source).not.toContain('setDraft(`/agent ${employee.name} `)');
  });

  it('rejects malformed slash commands before uploading retained attachments', () => {
    expect(source).toContain('function slashDraftError(message: string)');
    expect(source).toContain('const commandError = slashDraftError(message);');
    expect(source).toContain('setError(commandError);');
    expect(source).toContain('"/new 不能携带附件；请先新建会话，再添加附件。"');
    const sendBody = source.slice(source.indexOf('const send = useCallback'), source.indexOf('const chooseAttachments'));
    expect(sendBody.indexOf('const commandError = slashDraftError(message);')).toBeGreaterThan(-1);
    expect(sendBody.indexOf('const commandError = slashDraftError(message);')).toBeLessThan(sendBody.indexOf('setUploadingAttachments(files.length > 0);'));
  });

  it('pauses automatic following while the owner reads history and offers an explicit jump to latest', () => {
    expect(source).toContain('const followLatestRef = useRef(true);');
    expect(source).toContain('const scrollViewportRef = useRef<HTMLDivElement | null>(null);');
    expect(source).toContain('const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;');
    expect(source).toContain('followLatestRef.current = atLatest;');
    expect(source).toContain('if (!followLatestRef.current)');
    expect(source).toContain('data-nexus-chat-scroll');
    expect(source).toContain('data-nexus-jump-latest');
    expect(source).toContain('回到最新消息');
    expect(source).not.toContain('endRef.current?.scrollIntoView({ block: "end" })');
  });

  it('renders safe Hermes reasoning and tool execution as collapsible activity blocks', () => {
    expect(source).toContain('function ActivityDisclosure');
    expect(source).toContain('<details');
    expect(source).toContain('className="nexus-activity');
    expect(source).toContain('open={open}');
    expect(source).toContain('onToggle={(event) => setOpen(event.currentTarget.open)}');
    expect(source).toContain('aria-label="思考与执行过程"');
    expect(source).toContain('data-nexus-activity-list');
    expect(source).toContain('<ActivityList activities={message.activities} />');
    expect(source).toContain('item.activities.length > 0');
  });
});

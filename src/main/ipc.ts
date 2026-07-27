/**
 * IPC 白名单（PRD 12.2：不允许 Renderer 透传任意命令）
 * Renderer 仅能调用此处显式注册的方法；密钥操作只通过 safeStorage 句柄。
 */
import { BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { Database } from './services/database.js';
import type { Orchestrator } from './services/orchestrator.js';
import type { ExecutorRegistry } from './services/executor/index.js';
import type { EngineManager } from './services/engineManager.js';
import type { ChannelManager } from './services/channelManager.js';
import type { FeishuChannel } from './services/channels/feishuChannel.js';
import type { WecomChannel } from './services/channels/wecomChannel.js';
import type { WeixinChannel } from './services/channels/wechatChannel.js';
import type { Scheduler } from './services/scheduler.js';
import type { ApprovalBroker } from './services/approvalBroker.js';
import type { ResourceMonitor } from './services/resourceMonitor.js';
import type { McpManager } from './services/mcpManager.js';
import type { SkillManager } from './services/skillManager.js';
import type { ProviderManager } from './services/providerManager.js';
import type { WorkflowEngine } from './services/workflowEngine.js';
import type { WfPlatformManager } from './services/wfPlatformManager.js';
import type { TeamEngine } from './services/teamEngine.js';
import type { ProjectManager } from './services/projectManager.js';
import type { DeliverableManager } from './services/deliverableManager.js';
import type { CollabManager } from './services/collabManager.js';
import { importFromHermes, exportToHermes } from './services/hermesSync.js';
import { getProviderConfig, saveProviderConfig, testProvider } from './services/provider.js';
import { loadConfig, saveConfig } from './services/config.js';
import type {
  AppConfig, CreateAgentInput, DeliverableMetaPatch, DeliverableReviewInput, DeliverableVersionInput,
  ProjectInput, ProjectPatch, ScheduleInput, SystemInfo, TodoItem, AgentPersonaPatch, WfNode, WfEdge
} from '../shared/types.js';
import { hostname, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** 轻量级运行时参数校验（防御异常/恶意输入穿透） */
function assertString(v: unknown, field: string, min = 1, max = 500): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    throw new Error(`参数 ${field} 无效（需 ${min}-${max} 字符）`);
  }
  return v;
}
function assertId(v: unknown, field = 'id'): string {
  return assertString(v, field, 1, 100);
}

function safeFileSegment(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
  return safe || 'deliverable';
}

export interface IpcDeps {
  db: Database;
  orchestrator: Orchestrator;
  executors: ExecutorRegistry;
  engines: EngineManager;
  channels: ChannelManager;
  feishu: FeishuChannel;
  wecom: WecomChannel;
  weixin: WeixinChannel;
  scheduler: Scheduler;
  broker: ApprovalBroker;
  monitor: ResourceMonitor;
  mcp: McpManager;
  skills: SkillManager;
  providers: ProviderManager;
  workflows: WorkflowEngine;
  projects: ProjectManager;
  deliverables: DeliverableManager;
  teams: TeamEngine;
  wfPlatforms: WfPlatformManager;
  collab: CollabManager;
  ocr: import('./services/ocrService.js').OcrService;
  apiBridge: import('./services/apiBridge.js').ApiBridge;
  webServer: import('./services/webServer.js').WebServer;
  getMainWindow: () => BrowserWindow | null;
}

export function registerIpc(deps: IpcDeps) {
  const { db, orchestrator, engines, channels, feishu, wecom, weixin, scheduler, broker, monitor, mcp, skills, providers, workflows, projects, deliverables, teams, wfPlatforms, collab, ocr, webServer, getMainWindow } = deps;

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  // 快照推送节流（trailing）：任务高频状态变化时最多 ~400ms 推一次，降低 IPC 序列化开销
  let snapTimer: NodeJS.Timeout | null = null;
  let snapPending = false;
  const pushSnapshot = () => {
    if (snapTimer) { snapPending = true; return; }
    broadcast('aibox:snapshot', buildSnapshot(deps));
    snapTimer = setTimeout(() => {
      snapTimer = null;
      if (snapPending) { snapPending = false; pushSnapshot(); }
    }, 400);
  };

  // 编排器状态变化 → 推送全量快照（本地事件到 UI ≤ 2 秒）；审批挂起即时可见
  orchestrator.onChange(pushSnapshot);
  broker.onChange(pushSnapshot);
  // 任务输出流式推送（逐字显示，无需轮询）
  orchestrator.onOutput((taskId, chunk) => {
    broadcast('aibox:taskOutput', { taskId, chunk });
  });
  // 资源样本 → 实时推送
  monitor.onSample(() => {
    broadcast('aibox:resources', {
      history: monitor.getHistory(),
      health: monitor.getHealth()
    });
  });

  // ---------- 查询 ----------
  ipcMain.handle('aibox:getSnapshot', () => buildSnapshot(deps));
  ipcMain.handle('aibox:getAppVersion', () => app.getVersion());
  ipcMain.handle('aibox:getResourceHistory', () => ({ history: monitor.getHistory(), health: monitor.getHealth() }));
  ipcMain.handle('aibox:getSystemInfo', (): SystemInfo => ({
    platform: process.platform,
    osVersion: release(),
    hostname: hostname(),
    uptimeSec: Math.floor(process.uptime()),
    appVersion: app.getVersion()
  }));

  // ---------- 项目 ----------
  ipcMain.handle('aibox:createProject', (_e, input: ProjectInput) => {
    const project = projects.create(input);
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:updateProject', (_e, id: string, patch: ProjectPatch) => {
    const project = projects.update(assertId(id, 'projectId'), patch);
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:archiveProject', (_e, id: string) => {
    const project = projects.archive(assertId(id, 'projectId'));
    pushSnapshot();
    return project;
  });
  ipcMain.handle('aibox:getProjectOperations', () => projects.operations(deliverables.list()));

  // ---------- 成果验收 ----------
  ipcMain.handle('aibox:listDeliverables', () => deliverables.list());
  ipcMain.handle('aibox:getDeliverable', (_e, id: string) => deliverables.get(assertId(id, 'deliverableId')));
  ipcMain.handle('aibox:updateDeliverableMeta', (_e, id: string, patch: DeliverableMetaPatch) =>
    deliverables.updateMeta(assertId(id, 'deliverableId'), patch));
  ipcMain.handle('aibox:addDeliverableVersion', (_e, id: string, input: DeliverableVersionInput) =>
    deliverables.addVersion(assertId(id, 'deliverableId'), input));
  ipcMain.handle('aibox:reviewDeliverable', (_e, id: string, input: DeliverableReviewInput) => {
    const deliverableId = assertId(id, 'deliverableId');
    const current = deliverables.get(deliverableId);
    if (!current) throw new Error('成果不存在');
    let reworkRef: string | null = null;
    let reworkMessage: string | null = null;
    if (input.status === 'rework' && input.createRework) {
      const instruction = `返工要求：${assertString(input.note, 'note', 2, 1000)}\n原成果：${current.title}`;
      if (current.sourceType === 'task') {
        const task = orchestrator.createFollowUpTask(current.sourceId, instruction);
        reworkRef = task.id;
        reworkMessage = '返工任务已派发给原数字员工';
      } else {
        const result = teams.trigger(current.ownerId, instruction, current.projectId ?? undefined);
        if (!result.ok || !result.runId) throw new Error(result.message);
        reworkRef = result.runId;
        reworkMessage = '专家团返工运行已启动';
      }
    }
    const result = deliverables.review(deliverableId, input, reworkRef);
    if (!result) throw new Error('成果不存在');
    pushSnapshot();
    return { ...result, reworkRef, reworkMessage };
  });
  ipcMain.handle('aibox:getProjectDeliverablePackage', (_e, projectId: string) =>
    deliverables.packageForProject(assertId(projectId, 'projectId')));
  ipcMain.handle('aibox:exportDeliverable', async (_e, id: string, format: 'markdown' | 'json') => {
    const detail = deliverables.get(assertId(id, 'deliverableId'));
    if (!detail) throw new Error('成果不存在');
    if (!['markdown', 'json'].includes(format)) throw new Error('导出格式无效');
    const win = getMainWindow();
    if (!win) return { ok: false, canceled: false, message: '窗口不存在' };
    const extension = format === 'markdown' ? 'md' : 'json';
    const result = await dialog.showSaveDialog(win, {
      title: format === 'markdown' ? '下载成果正文' : '导出成果详情',
      defaultPath: `${safeFileSegment(detail.title)}-v${detail.latestVersion}.${extension}`,
      filters: [{ name: format === 'markdown' ? 'Markdown 文档' : 'JSON 数据', extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, message: '已取消' };
    const content = format === 'markdown' ? deliverables.renderMarkdown(detail) : JSON.stringify(detail, null, 2);
    writeFileSync(result.filePath, content, 'utf8');
    db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.export', target: detail.id, result: format });
    return { ok: true, canceled: false, message: `已导出：${result.filePath}`, path: result.filePath };
  });
  ipcMain.handle('aibox:exportProjectDeliverablePackage', async (_e, projectId: string) => {
    const pkg = deliverables.packageForProject(assertId(projectId, 'projectId'));
    const win = getMainWindow();
    if (!win) return { ok: false, canceled: false, message: '窗口不存在' };
    const result = await dialog.showOpenDialog(win, { title: '选择成果包保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, message: '已取消' };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const baseTarget = join(result.filePaths[0], `${safeFileSegment(pkg.project.name)}-成果包-${stamp}`);
    let target = baseTarget;
    let suffix = 2;
    while (existsSync(target)) target = `${baseTarget}-${suffix++}`;
    const itemsDir = join(target, 'deliverables');
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(join(target, 'README.md'), deliverables.renderPackageReadme(pkg), 'utf8');
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(pkg, null, 2), 'utf8');
    pkg.deliverables.forEach((item, index) => {
      const detail = deliverables.get(item.id);
      if (!detail) return;
      const filename = `${String(index + 1).padStart(2, '0')}-${safeFileSegment(item.title)}-v${item.latestVersion}.md`;
      writeFileSync(join(itemsDir, filename), deliverables.renderMarkdown(detail), 'utf8');
    });
    db.audit({ id: randomUUID(), actor: 'admin', action: 'deliverable.package.export', target: pkg.project.id, result: 'ok' });
    return { ok: true, canceled: false, message: `成果包已导出：${target}`, path: target };
  });

  // ---------- 数字员工 ----------
  ipcMain.handle('aibox:createAgent', (_e, input: CreateAgentInput) => {
    assertString(input?.name, 'name', 2, 30);
    assertString(input?.role, 'role', 2, 500);
    assertString(input?.engineId, 'engineId', 1, 100);
    return orchestrator.createAgent(input);
  });
  ipcMain.handle('aibox:startAgent', (_e, id: string) => orchestrator.startAgent(assertId(id)));
  ipcMain.handle('aibox:stopAgent', (_e, id: string) => orchestrator.stopAgent(assertId(id)));
  // 助手人设编辑（soul.md / agents.md / user.md / 权限模式）
  ipcMain.handle('aibox:updateAgentPersona', (_e, id: string, patch: AgentPersonaPatch) => {
    const a = orchestrator.updateAgentPersona(id, patch);
    pushSnapshot();
    return a;
  });
  // AI 辅助生成人设：用已配置的 LLM 供应商生成 soul.md + agents.md + role
  ipcMain.handle('aibox:generatePersona', async (_e, description: string) => {
    const { getProviderSettings, readProviderKey } = await import('./services/provider.js');
    const settings = getProviderSettings(db);
    const key = readProviderKey(db);
    if (!settings || !key) throw new Error('请先在设置页配置模型供应商');
    const prompt = `请根据以下描述生成一个 AI 助手的配置，用 JSON 格式输出：
{"name":"助手名称","role":"职责描述(50-100字)","soulMd":"身份与性格(100-200字)","agentsMd":"行为指令(5条规则)","systemPrompt":"系统提示词(50-100字)","permissionMode":"readonly或standard"}

描述：${description}

仅输出 JSON，不要其他内容。`;
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1000 })
    });
    if (!res.ok) throw new Error(`LLM 请求失败: HTTP ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 输出格式异常，请重试');
    return JSON.parse(jsonMatch[0]) as { name: string; role: string; soulMd: string; agentsMd: string; systemPrompt: string; permissionMode: string };
  });
  // 会话（持续多轮对话）
  ipcMain.handle('aibox:listConversations', (_e, agentId: string) => orchestrator.listConversations(agentId));
  ipcMain.handle('aibox:chatWithAgent', (_e, agentId: string, message: string, conversationId?: string) => {
    const r = orchestrator.chatWithAgent(agentId, message, conversationId);
    pushSnapshot();
    return r;
  });
  // 会话管理：重命名 / 删除
  ipcMain.handle('aibox:renameConversation', (_e, id: string, title: string) => {
    db.raw.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  });
  ipcMain.handle('aibox:deleteConversation', (_e, id: string) => {
    db.raw.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  });
  // 用量统计
  ipcMain.handle('aibox:getUsageStats', () => orchestrator.usageStats());
  ipcMain.handle('aibox:getUsageStatsEnhanced', (_e, since: number | null) => {
    const where = since ? 'WHERE created_at >= ?' : '';
    const params = since ? [since] : [];
    const total = db.raw.prepare(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(total_tokens),0) t FROM usage_records ${where}`).get(...params) as { i: number; o: number; t: number };
    const byModel = (db.raw.prepare(`SELECT model, SUM(input_tokens) input, SUM(output_tokens) output, SUM(total_tokens) total, COUNT(*) count FROM usage_records ${where} GROUP BY model ORDER BY total DESC`).all(...params) as { model: string; input: number; output: number; total: number; count: number }[]);
    const byAgent = (db.raw.prepare(`SELECT agent_id, SUM(total_tokens) total, COUNT(*) count FROM usage_records ${where} GROUP BY agent_id ORDER BY total DESC`).all(...params) as { agent_id: string; total: number; count: number }[]);
    // 最近 7 天每日趋势
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const daily = (db.raw.prepare('SELECT created_at, total_tokens FROM usage_records WHERE created_at >= ? ORDER BY created_at').all(sevenDaysAgo) as { created_at: number; total_tokens: number }[]);
    const trend: { date: string; total: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = dayStart.getTime() + 86400000;
      const dayTotal = daily.filter((r) => r.created_at >= dayStart.getTime() && r.created_at < dayEnd).reduce((s, r) => s + r.total_tokens, 0);
      trend.push({ date: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`, total: dayTotal });
    }
    const recent = (db.raw.prepare(`SELECT * FROM usage_records ${where} ORDER BY created_at DESC LIMIT 50`).all(...params) as { id: string; agent_id: string; model: string; input_tokens: number; output_tokens: number; total_tokens: number; created_at: number }[]).map((r) => ({
      id: r.id, agentId: r.agent_id, model: r.model, input: r.input_tokens, output: r.output_tokens, total: r.total_tokens, createdAt: r.created_at
    }));
    return { total: { input: total.i, output: total.o, total: total.t }, byModel, byAgent, trend, recent };
  });

  // ---------- MCP 服务器管理 ----------
  ipcMain.handle('aibox:listMcpServers', () => mcp.list());
  ipcMain.handle('aibox:createMcpServer', (_e, input: { name: string; command: string; args?: string[]; env?: Record<string, string> }) => mcp.create(input));
  ipcMain.handle('aibox:removeMcpServer', (_e, id: string) => mcp.remove(id));
  ipcMain.handle('aibox:toggleMcpServer', (_e, id: string, enabled: boolean) => mcp.toggle(id, enabled));
  ipcMain.handle('aibox:startMcpServer', (_e, id: string) => mcp.start(id));
  ipcMain.handle('aibox:stopMcpServer', (_e, id: string) => mcp.stop(id));
  ipcMain.handle('aibox:getMcpTools', () => mcp.allTools());
  ipcMain.handle('aibox:callMcpTool', (_e, serverId: string, toolName: string, args: Record<string, unknown>) => mcp.callTool(serverId, toolName, args));

  // ---------- Skills 管理 ----------
  ipcMain.handle('aibox:listSkills', () => skills.list());
  ipcMain.handle('aibox:createSkill', (_e, input: { name: string; description?: string; content?: string }) => skills.create(input));
  ipcMain.handle('aibox:updateSkill', (_e, id: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }) => skills.update(id, patch));
  ipcMain.handle('aibox:removeSkill', (_e, id: string) => skills.remove(id));
  ipcMain.handle('aibox:bindSkill', (_e, agentId: string, skillId: string) => skills.bindAgent(agentId, skillId));
  ipcMain.handle('aibox:unbindSkill', (_e, agentId: string, skillId: string) => skills.unbindAgent(agentId, skillId));
  ipcMain.handle('aibox:getAgentSkills', (_e, agentId: string) => skills.forAgent(agentId));

  // ---------- Hermes 同步 ----------
  ipcMain.handle('aibox:importFromHermes', () => importFromHermes(mcp, skills));
  ipcMain.handle('aibox:exportToHermes', () => exportToHermes(mcp, skills));

  // ---------- 多供应商管理 ----------
  ipcMain.handle('aibox:listProviders', () => providers.list());
  ipcMain.handle('aibox:createProvider', (_e, input: { name: string; baseUrl: string; model: string; apiKey?: string; isDefault?: boolean }) => providers.create(input));
  ipcMain.handle('aibox:updateProvider', (_e, id: string, patch: { name?: string; baseUrl?: string; model?: string; apiKey?: string; isDefault?: boolean }) => providers.update(id, patch));
  ipcMain.handle('aibox:removeProvider', (_e, id: string) => providers.remove(id));
  ipcMain.handle('aibox:testProviderById', (_e, id: string) => providers.testById(id));
  ipcMain.handle('aibox:fetchProviderModels', (_e, id: string) => providers.fetchModels(id));
  // ---------- API Bridge ----------
  ipcMain.handle('aibox:getBridgeStatus', () => deps.apiBridge.getStatus());
  ipcMain.handle('aibox:toggleBridge', (_e, enabled: boolean) => { deps.apiBridge.toggle(enabled); return deps.apiBridge.getStatus(); });
  ipcMain.handle('aibox:regenerateBridgeKey', () => { deps.apiBridge.regenerateKey(); return deps.apiBridge.getStatus(); });

  // ---------- Prompt 模板 ----------
  ipcMain.handle('aibox:listTemplates', () => (db.raw.prepare('SELECT * FROM prompt_templates ORDER BY created_at DESC').all() as unknown as { id: string; name: string; content: string; category: string; created_at: number }[]).map((r) => ({ id: r.id, name: r.name, content: r.content, category: r.category, createdAt: r.created_at })));
  ipcMain.handle('aibox:createTemplate', (_e, input: { name: string; content: string; category?: string }) => {
    const id = `tpl-${randomUUID().slice(0, 8)}`;
    db.raw.prepare('INSERT INTO prompt_templates(id, name, content, category, created_at) VALUES(?,?,?,?,?)').run(id, input.name, input.content, input.category ?? 'general', Date.now());
    return { id, ...input };
  });
  ipcMain.handle('aibox:removeTemplate', (_e, id: string) => db.raw.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id));

  // ---------- Agent 克隆/导入导出 ----------
  ipcMain.handle('aibox:cloneAgent', (_e, id: string, newName: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    return orchestrator.createAgent({
      name: newName || `${agent.name} (副本)`, role: agent.role, systemPrompt: agent.systemPrompt,
      soulMd: agent.soulMd, agentsMd: agent.agentsMd, userMd: agent.userMd,
      engineId: agent.engineId, workspace: agent.workspace, permissionMode: agent.permissionMode,
      concurrencyLimit: agent.concurrencyLimit, channelIds: []
    });
  });
  ipcMain.handle('aibox:exportAgent', (_e, id: string) => {
    const agent = orchestrator.listAgents().find((a) => a.id === id);
    if (!agent) throw new Error('助手不存在');
    const { id: _id, lifecycle: _l, archived: _a, createdAt: _c, updatedAt: _u, avatarColor: _av, ...exportable } = agent;
    return JSON.stringify(exportable, null, 2);
  });
  ipcMain.handle('aibox:importAgent', (_e, json: string) => {
    try {
      const data = JSON.parse(json) as { name?: string; role?: string; systemPrompt?: string; soulMd?: string; agentsMd?: string; userMd?: string; engineId?: string; workspace?: string; permissionMode?: string; concurrencyLimit?: number };
      if (!data.name) return { ok: false, message: '文件缺少 name 字段' };
      const agent = orchestrator.createAgent({
        name: data.name, role: data.role ?? '', systemPrompt: data.systemPrompt ?? '',
        soulMd: data.soulMd ?? '', agentsMd: data.agentsMd ?? '', userMd: data.userMd ?? '',
        engineId: data.engineId ?? 'eng-hermes', workspace: data.workspace ?? '',
        permissionMode: (data.permissionMode as 'readonly' | 'standard' | 'trusted' | 'autonomous') ?? 'standard',
        concurrencyLimit: data.concurrencyLimit ?? 1, channelIds: []
      });
      pushSnapshot();
      return { ok: true, message: `已导入员工「${agent.name}」`, agent };
    } catch (e) {
      return { ok: false, message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  ipcMain.handle('aibox:batchAgentAction', (_e, ids: string[], action: 'start' | 'stop' | 'delete') => {
    let count = 0;
    for (const id of ids) {
      try {
        if (action === 'start') { orchestrator.startAgent(id); count++; }
        else if (action === 'stop') { orchestrator.stopAgent(id); count++; }
        else if (action === 'delete') { orchestrator.archiveAgent(id); count++; }
      } catch { /* 跳过失败的 */ }
    }
    pushSnapshot();
    return { ok: true, message: `已对 ${count} 位员工执行「${action === 'start' ? '启用' : action === 'stop' ? '停用' : '删除'}」操作` };
  });
  ipcMain.handle('aibox:getAgentDetail', (_e, agentId: string) => {
    const tasks = orchestrator.listTasks().filter((t) => t.agentId === agentId).slice(0, 10);
    const usage = db.raw.prepare('SELECT COALESCE(SUM(total_tokens),0) as total, COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COUNT(*) as calls FROM usage_records WHERE agent_id = ?').get(agentId) as { total: number; input: number; output: number; calls: number };
    const events = (db.raw.prepare("SELECT id, event_type, created_at FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5) ORDER BY created_at DESC LIMIT 30").all(agentId) as { id: string; event_type: string; created_at: number }[]).map((e) => ({ id: e.id, eventType: e.event_type, createdAt: e.created_at }));
    return { tasks, usage: { totalTokens: usage.total, inputTokens: usage.input, outputTokens: usage.output, calls: usage.calls }, events };
  });

  // ---------- 可视化工作流引擎 ----------
  workflows.onBroadcast(broadcast);
  ipcMain.handle('aibox:listWorkflows', () => workflows.list());
  ipcMain.handle('aibox:createWorkflow', (_e, input: { name: string; description?: string; nodes: WfNode[]; edges: WfEdge[] }) => workflows.create(input));
  ipcMain.handle('aibox:updateWorkflow', (_e, id: string, patch: { name?: string; description?: string; nodes?: WfNode[]; edges?: WfEdge[] }) => workflows.update(id, patch));
  ipcMain.handle('aibox:removeWorkflow', (_e, id: string) => workflows.remove(id));
  ipcMain.handle('aibox:triggerWorkflow', (_e, id: string, inputs?: Record<string, string>) => {
    const r = workflows.trigger(id, inputs);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getWorkflowRunState', (_e, id: string) => workflows.getRunState(id));
  ipcMain.handle('aibox:listWorkflowRuns', (_e, id: string) => workflows.listRuns(id));
  ipcMain.handle('aibox:publishWorkflowAsSkill', (_e, id: string) => {
    const r = workflows.publishAsSkill(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:unpublishWorkflowSkill', (_e, id: string) => {
    const r = workflows.unpublishSkill(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:exportWorkflow', (_e, id: string) => workflows.exportWorkflow(id));
  ipcMain.handle('aibox:importWorkflow', (_e, json: string) => {
    const r = workflows.importWorkflow(json);
    if (r.ok) pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:validateWorkflow', (_e, wf: { nodes: unknown[]; edges: unknown[] }) => workflows.validate(wf as { nodes: never[]; edges: never[] }));
  ipcMain.handle('aibox:saveWfVariables', (_e, wfId: string, variables: unknown[]) => workflows.saveVariables(wfId, variables as never[]));
  // ---------- 外部工作流平台（Coze / Dify） ----------
  ipcMain.handle('aibox:listWfPlatforms', () => wfPlatforms.list());
  ipcMain.handle('aibox:saveWfPlatform', (_e, input: { id?: string; name: string; baseUrl: string; token?: string }) => wfPlatforms.save(input));
  ipcMain.handle('aibox:removeWfPlatform', (_e, id: string) => wfPlatforms.remove(id));
  ipcMain.handle('aibox:testWfPlatform', (_e, id: string) => wfPlatforms.test(id));

  // ---------- 专家团 ----------
  ipcMain.handle('aibox:listTeams', () => teams.list());
  ipcMain.handle('aibox:createTeam', (_e, input: { name: string; coordinatorId: string; memberIds: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.create(input));
  ipcMain.handle('aibox:updateTeam', (_e, id: string, patch: { name?: string; coordinatorId?: string; memberIds?: string[]; mode?: 'coordinate' | 'roundtable'; workspace?: string }) => teams.update(id, patch));
  ipcMain.handle('aibox:removeTeam', (_e, id: string) => teams.remove(id));
  ipcMain.handle('aibox:triggerTeam', (_e, id: string, task: string, projectId?: string) => {
    const r = teams.trigger(id, task, projectId ? assertId(projectId, 'projectId') : undefined);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getTeamRuns', (_e, teamId: string) => {
    deliverables.list();
    return teams.listRuns(assertId(teamId, 'teamId'));
  });
  ipcMain.handle('aibox:getTeamCollaborationOverview', (_e, teamId: string) => {
    deliverables.list();
    return teams.getCollaborationOverview(assertId(teamId, 'teamId'));
  });
  ipcMain.handle('aibox:listAttentionRuns', () => teams.listAttentionRuns());
  ipcMain.handle('aibox:getTeamConfig', (_e, teamId: string) => teams.getConfig(teamId));
  ipcMain.handle('aibox:saveTeamConfig', (_e, teamId: string, config: { timeout: number; maxRetries: number; concurrency: number }) => {
    teams.saveConfig(teamId, config);
    return { ok: true };
  });
  ipcMain.handle('aibox:getTeamStats', (_e, teamId: string) => teams.getStats(teamId));
  ipcMain.handle('aibox:getSubtaskOutput', (_e, taskId: string) => teams.getSubtaskOutput(taskId));
  ipcMain.handle('aibox:retryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.retrySubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:cancelTeamRun', (_e, runId: string) => teams.cancelRun(assertId(runId, 'runId')));
  ipcMain.handle('aibox:skipTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.skipSubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:forceRetryTeamSubtask', (_e, runId: string, subtaskIndex: number) => teams.forceRetrySubtask(assertId(runId, 'runId'), subtaskIndex));
  ipcMain.handle('aibox:injectTeamGuidance', (_e, runId: string, message: string) => teams.injectGuidance(assertId(runId, 'runId'), assertString(message, 'message', 1, 500)));
  ipcMain.handle('aibox:saveTeamAsTemplate', (_e, teamId: string, name?: string) => teams.saveAsTemplate(teamId, name));
  ipcMain.handle('aibox:listTeamTemplates', () => teams.listTemplates());
  ipcMain.handle('aibox:removeTeamTemplate', (_e, id: string) => teams.removeTemplate(id));

  // ---------- 任务 ----------
  ipcMain.handle('aibox:createTask', (_e, agentId: string, title: string, projectId?: string) => orchestrator.createTask(
    assertId(agentId, 'agentId'),
    assertString(title, 'title', 1, 500),
    'desktop',
    { projectId: projectId ? assertId(projectId, 'projectId') : undefined }
  ));
  ipcMain.handle('aibox:cancelTask', (_e, id: string) => orchestrator.cancelTask(assertId(id)));
  ipcMain.handle('aibox:pauseTask', (_e, id: string) => orchestrator.pauseTask(assertId(id)));
  ipcMain.handle('aibox:resumeTask', (_e, id: string) => orchestrator.resumeTask(assertId(id)));
  ipcMain.handle('aibox:decideApproval', (_e, id: string, approve: boolean) => orchestrator.decideApproval(assertId(id), approve === true));
  // 追问/续跑（P2b）：新任务继承会话锚点
  ipcMain.handle('aibox:createFollowUpTask', (_e, parentTaskId: string, title: string) => orchestrator.createFollowUpTask(parentTaskId, title));
  // 任务详情：事件时间线 + 产物全文（13.2 审计可追溯）
  ipcMain.handle('aibox:getTaskEvents', (_e, taskId: string) => orchestrator.taskEvents(taskId));
  ipcMain.handle('aibox:getTaskResult', (_e, taskId: string) => orchestrator.taskResult(taskId));
  // 任务产出质量标记（成果管理：采纳/驳回/返工）
  ipcMain.handle('aibox:setTaskQuality', (_e, taskId: string, quality: 'accepted' | 'rejected' | 'rework' | null) => orchestrator.setTaskQuality(assertId(taskId, 'taskId'), quality));

  // ---------- 引擎 ----------
  // 真实自动安装（npm -g，下载地址取配置文件）；完成后重新检测并推送快照
  ipcMain.handle('aibox:installEngine', async (_e, id: string) => {
    pushSnapshot(); // 立即反映 INSTALLING 状态
    const r = await engines.install(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:detectEngines', async () => {
    const list = await engines.detect();
    pushSnapshot();
    return list;
  });
  ipcMain.handle('aibox:getInstallGuide', (_e, id: string) => engines.installGuide(id));
  ipcMain.handle('aibox:updateEngine', async (_e, id: string) => {
    const r = await engines.update(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:uninstallEngine', async (_e, id: string) => {
    const r = await engines.uninstall(id);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getEngineLatestVersion', (_e, id: string) => engines.latestVersion(id));
  ipcMain.handle('aibox:restartEngine', async (_e, id: string) => {
    const r = await engines.restart(assertId(id));
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:checkRuntime', () => engines.checkRuntime());
  ipcMain.handle('aibox:installRuntime', async (_e, name: string) => {
    const r = await engines.installRuntime(name);
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url); // 外链一律系统浏览器，仅放行 https
  });
  // 打开产物目录 / 工作目录（系统资源管理器）
  ipcMain.handle('aibox:openTaskWorkspace', async (_e, taskId: string) => {
    const ws = orchestrator.resolveTaskWorkspace(assertId(taskId, 'taskId'));
    if (!ws) return { ok: false, message: '无法定位产物目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  ipcMain.handle('aibox:openAgentWorkspace', async (_e, agentId: string) => {
    const ws = orchestrator.resolveAgentWorkspace(assertId(agentId, 'agentId'));
    if (!ws) return { ok: false, message: '无法定位工作目录' };
    const err = await shell.openPath(ws);
    return err ? { ok: false, message: err } : { ok: true, message: '' };
  });
  ipcMain.handle('aibox:authEngine', (_e, id: string) => {
    engines.markAuthed(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:setDefaultEngine', (_e, id: string) => {
    engines.setDefault(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:getEngineConfig', (_e, id: string) => engines.getConfig(id));
  ipcMain.handle('aibox:saveEngineConfig', (_e, id: string, config: { runArgs?: string[]; env?: Record<string, string>; maxConcurrency?: number }) => {
    engines.saveConfig(id, config);
    return { ok: true };
  });
  ipcMain.handle('aibox:getEngineLogs', (_e, id: string) => engines.getLogs(id));
  ipcMain.handle('aibox:getEngineMetrics', (_e, id: string) => engines.getMetrics(id));
  ipcMain.handle('aibox:registerCustomEngine', (_e, input: { name: string; command: string; args?: string; dataBoundary?: string }) => {
    const r = engines.registerCustom(input);
    if (r.ok) pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:getEngineRouting', () => {
    return db.getSetting<Record<string, string>>('engine_routing', {});
  });
  ipcMain.handle('aibox:saveEngineRouting', (_e, rules: Record<string, string>) => {
    db.setSetting('engine_routing', rules);
    return { ok: true };
  });

  // ---------- 模型供应商（Hermes；密钥仅存 safeStorage，Renderer 只见脱敏视图） ----------
  ipcMain.handle('aibox:getProviderConfig', () => getProviderConfig(db));
  ipcMain.handle('aibox:saveProviderConfig', async (_e, input: { baseUrl: string; model: string; apiKey?: string }) => {
    saveProviderConfig(db, input);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'provider.save', target: input.baseUrl, result: 'ok' });
    await engines.detect(); // 配置齐备后 Hermes 转 HEALTHY
    pushSnapshot();
    return getProviderConfig(db);
  });
  ipcMain.handle('aibox:testProvider', (_e, override?: { baseUrl?: string; apiKey?: string }) => testProvider(db, override));

  // ---------- 应用配置文件（下载源等；不含密钥） ----------
  ipcMain.handle('aibox:getAppConfig', () => loadConfig());
  ipcMain.handle('aibox:setAppConfig', (_e, patch: Partial<AppConfig>) => {
    const next = saveConfig(patch);
    db.audit({ id: randomUUID(), actor: 'admin', action: 'config.save', target: 'aibox.config.json', result: 'ok' });
    return next;
  });

  // ---------- 定时任务（P3a） ----------
  ipcMain.handle('aibox:createSchedule', (_e, input: ScheduleInput) => {
    const s = scheduler.create(input);
    pushSnapshot();
    return s;
  });
  ipcMain.handle('aibox:toggleSchedule', (_e, id: string, enabled: boolean) => {
    scheduler.toggle(id, enabled);
    pushSnapshot();
  });
  ipcMain.handle('aibox:deleteSchedule', (_e, id: string) => {
    scheduler.remove(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:updateSchedule', (_e, id: string, patch: { title?: string; content?: string; cronKind?: string; cronValue?: string }) => {
    scheduler.update(id, patch as { title?: string; content?: string; cronKind?: 'interval' | 'daily' | 'weekly' | 'monthly'; cronValue?: string });
    pushSnapshot();
  });
  ipcMain.handle('aibox:getScheduleHistory', (_e, scheduleId: string) => scheduler.getHistory(scheduleId));

  // ---------- 渠道 ----------
  // 飞书真实接入（P3c）：保存凭据（secret 走 safeStorage）并建立长连接
  ipcMain.handle('aibox:configureFeishu', async (_e, appId: string, appSecret: string) => {
    feishu.saveCredentials(appId, appSecret);
    const r = await feishu.connect();
    pushSnapshot();
    return r;
  });
  // 企业微信智能机器人真实接入：官方长连接 API 模式（BotID/Secret，Secret 走 safeStorage）
  ipcMain.handle('aibox:configureWecom', async (_e, botId: string, secret: string) => {
    wecom.saveCredentials(botId, secret);
    const r = await wecom.connect();
    pushSnapshot();
    return r;
  });
  // 个人微信真实接入：本地 Bot 桥接接口（回环 WebSocket，令牌走 safeStorage）
  ipcMain.handle('aibox:configureWeixin', async (_e, bridgeUrl: string, token: string) => {
    weixin.saveCredentials(bridgeUrl, token);
    const r = await weixin.connect();
    pushSnapshot();
    return r;
  });
  ipcMain.handle('aibox:setupChannel', (_e, id: string, accountName: string) => {
    channels.setup(id, accountName);
    setTimeout(pushSnapshot, 1500);
  });
  ipcMain.handle('aibox:disconnectChannel', (_e, id: string) => {
    if (id === 'ch-feishu') feishu.disconnect();
    if (id === 'ch-wecom') wecom.disconnect();
    if (id === 'ch-weixin') weixin.disconnect();
    channels.disconnect(id);
    pushSnapshot();
  });
  ipcMain.handle('aibox:bindChannel', (_e, channelId: string, agentId: string) => {
    channels.bindAgent(channelId, agentId);
    pushSnapshot();
  });
  ipcMain.handle('aibox:unbindChannel', (_e, channelId: string, agentId: string) => {
    channels.unbindAgent(channelId, agentId);
    pushSnapshot();
  });

  // ---------- 设置 ----------
  ipcMain.handle('aibox:getSetting', (_e, key: string) => db.getSetting(key, null));
  ipcMain.handle('aibox:setSetting', (_e, key: string, value: unknown) => db.setSetting(key, value));
  // Web 管理面板访问 Token：重新生成强随机 Token（同时失效旧会话）
  ipcMain.handle('aibox:regenerateWebToken', () => ({ token: webServer.regenerateToken() }));

  // ---------- OCR 文字识别服务 ----------
  ipcMain.handle('aibox:getOcrStatus', () => ocr.getStatus());
  ipcMain.handle('aibox:toggleOcr', (_e, enabled: boolean) => { ocr.setEnabled(enabled); return ocr.getStatus(); });
  ipcMain.handle('aibox:downloadOcrModels', () => ocr.downloadModels());
  ipcMain.handle('aibox:ocrRecognize', (_e, imagePath: string) => ocr.recognize(imagePath));
  // 数据库维护：完整性检查 + 手动清理
  ipcMain.handle('aibox:integrityCheck', () => db.integrityCheck());
  ipcMain.handle('aibox:manualCleanup', () => { db.cleanupRetention(); return { ok: true, message: '数据清理完成' }; });
  // 窗口控制：全屏切换
  ipcMain.handle('aibox:toggleFullscreen', () => {
    const win = getMainWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
    return win?.isFullScreen() ?? false;
  });
  ipcMain.handle('aibox:isFullscreen', () => getMainWindow()?.isFullScreen() ?? false);

  // ---------- 工作目录选择（7.2：必须由用户选择并进入允许列表） ----------
  ipcMain.handle('aibox:pickDirectory', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 数据备份导出（本地优先：用户可备份 SQLite 数据库） ----------
  ipcMain.handle('aibox:exportData', async () => {
    const win = getMainWindow();
    if (!win) return { ok: false, message: '窗口不存在' };
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: '导出数据库备份',
      defaultPath: `aibox-backup-${stamp}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' };
    try {
      db.flush(); // 先落盘再复制，保证备份完整
      copyFileSync(join(app.getPath('userData'), 'aibox-data', 'aibox.db'), r.filePath);
      db.audit({ id: randomUUID(), actor: 'admin', action: 'data.export', target: r.filePath, result: 'ok' });
      return { ok: true, message: `备份已导出：${r.filePath}` };
    } catch (err) {
      return { ok: false, message: `导出失败：${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ---------- 凭据（15.1：密钥不进入 Renderer/localStorage，仅存系统密钥库） ----------
  ipcMain.handle('aibox:storeSecret', (_e, ref: string, secret: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用');
    const buf = safeStorage.encryptString(secret);
    db.setSetting(`secret:${ref}`, buf.toString('base64'));
    db.audit({ id: randomUUID(), actor: 'admin', action: 'secret.store', target: ref, result: 'ok' });
  });
  ipcMain.handle('aibox:hasSecret', (_e, ref: string) => db.getSetting<string | null>(`secret:${ref}`, null) !== null);

  // ---------- 前端异常上报（ErrorBoundary 捕获的渲染异常写入审计日志） ----------
  ipcMain.handle('aibox:reportError', (_e, payload: { message: string; stack?: string; componentStack?: string }) => {
    db.audit({
      id: randomUUID(), actor: 'renderer', action: 'ui.error',
      target: (payload?.message ?? 'unknown').slice(0, 200),
      result: 'error',
      source: (payload?.stack ?? '').slice(0, 300) || 'renderer'
    });
  });

  // ---------- 多机协同 ----------
  ipcMain.handle('aibox:collab:checkGit', async () => {
    const runtimes = await engines.checkRuntime();
    return runtimes.find((r) => r.name === 'Git') ?? { name: 'Git', installed: false, version: null, path: null };
  });
  ipcMain.handle('aibox:collab:installGit', () => engines.installRuntime('Git'));
  ipcMain.handle('aibox:collab:listWorkspaces', () => collab.listWorkspaces());
  ipcMain.handle('aibox:collab:createWorkspace', (_e, input: { name: string; repoPath: string; conventions?: string; gitRules?: string; mcpPort?: number; gitPort?: number }) => {
    assertString(input?.name, 'name', 1, 50);
    assertString(input?.repoPath, 'repoPath', 1, 500);
    return collab.createWorkspace(input);
  });
  ipcMain.handle('aibox:collab:removeWorkspace', (_e, id: string) => collab.removeWorkspace(assertId(id)));
  ipcMain.handle('aibox:collab:startWorkspace', (_e, id: string) => collab.startWorkspace(assertId(id)));
  ipcMain.handle('aibox:collab:stopWorkspace', (_e, id: string) => { collab.stopWorkspace(assertId(id)); });
  ipcMain.handle('aibox:collab:listTasks', (_e, workspaceId: string) => collab.listTasks(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:createTask', (_e, workspaceId: string, input: { title: string; description?: string; branchName?: string }) => {
    assertString(input?.title, 'title', 1, 200);
    return collab.createTask(assertId(workspaceId, 'workspaceId'), input);
  });
  ipcMain.handle('aibox:collab:reviewTask', (_e, taskId: string, result: 'accept' | 'reject', comment: string) => {
    return collab.reviewTask(assertId(taskId, 'taskId'), result, comment ?? '');
  });
  ipcMain.handle('aibox:collab:listAgents', (_e, workspaceId: string) => collab.listAgents(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:getConnectInfo', (_e, workspaceId: string) => collab.getConnectInfo(assertId(workspaceId, 'workspaceId')));
  ipcMain.handle('aibox:collab:updateRules', (_e, id: string, patch: { conventions?: string; gitRules?: string }) => {
    collab.updateRules(assertId(id), patch);
  });
}

let snapshotVersion = 0;

function buildSnapshot(deps: IpcDeps) {
  const todos = deps.orchestrator.todos();
  // 系统级待办：无可用执行器提醒 + 资源告警（遗留修复）
  const executorAvailable = deps.engines.hasUsableExecutor();
  const systemTodos: TodoItem[] = [];
  if (!executorAvailable) {
    systemTodos.push({
      id: 'sys-no-executor',
      title: '未检测到可用执行引擎，请到引擎中心安装 CLI 或配置 Hermes 供应商',
      owner: '引擎中心', dueText: '尽快处理', severity: 'high', kind: 'system'
    });
  }
  for (const [i, msg] of deps.monitor.getAlerts().entries()) {
    systemTodos.push({ id: `sys-alert-${i}`, title: msg, owner: '系统监控', dueText: '资源告警', severity: 'high', kind: 'system' });
  }
  return {
    version: ++snapshotVersion,
    stats: deps.orchestrator.stats(),
    agentCards: deps.orchestrator.agentCards(),
    projects: deps.projects.list(),
    tasks: deps.orchestrator.listTasks(),
    todos: [...systemTodos, ...todos].slice(0, 12),
    approvals: deps.orchestrator.listApprovals(),
    engines: deps.engines.list(),
    channels: deps.channels.list(),
    schedules: deps.scheduler.list(),
    // 至少一个可用执行器（CLI 健康或 Hermes 已配置）才能支持系统正常运行
    executorAvailable
  };
}

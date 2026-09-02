'use strict';

// Real two-novel acceptance. This script uses the public Electron/preload
// surface and the authenticated Hermes project proxy. It never inserts a
// project, employee, plan, task or result directly into SQLite.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(process.env.AIBOX_NOVEL_OUTPUT || path.join(root, 'tmp', 'acceptance-novel-studio', stamp));
const seedUserData = path.resolve(process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || path.join(root, 'tmp', 'acceptance-clean-seed3', 'user-data'));
const userData = path.join(evidenceRoot, 'user-data');
fs.mkdirSync(evidenceRoot, { recursive: true });
if (!fs.existsSync(seedUserData) || !fs.statSync(seedUserData).isDirectory()) {
  throw new Error(`AIBOX_ACCEPTANCE_SEED_USER_DATA is unavailable: ${seedUserData}`);
}
fs.cpSync(seedUserData, userData, { recursive: true, force: true });

const TARGET_WORDS = 300_000;
const PILOT_CHAPTERS = 2;
// The acceptance harness may provision a real Provider through the same
// preload/Main contract as the UI. Credentials are supplied only at runtime
// via environment variables and are never written to source or reports.
const configuredProviderBaseUrl = String(process.env.AIBOX_NOVEL_BASE_URL || '').trim();
const configuredProviderKey = String(process.env.AIBOX_NOVEL_API_KEY || '').trim();
const configuredProviderName = String(process.env.AIBOX_NOVEL_PROVIDER_NAME || '小说验收 Provider').trim();
const configuredModel = String(process.env.AIBOX_NOVEL_MODEL || '').trim();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  evidenceRoot,
  userData,
  target: { novelCount: 2, wordsPerNovel: TARGET_WORDS, totalWords: TARGET_WORDS * 2 },
  guardrail: {
    mode: 'REAL_PILOT_WITH_EXPLICIT_TARGET',
    pilotChaptersPerNovel: PILOT_CHAPTERS,
    reason: 'A 600,000-word run is bounded to a real pilot batch so provider limits, cost and recovery behavior are observable before a long unattended run.'
  },
  provider: null,
  officeSkills: null,
  projects: [],
  totals: { hermesTurns: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskReceipts: 0, terminalTasks: 0, failedTasks: 0, retryRequests: 0, actualWords: 0 },
  consoleErrors: [],
  result: 'RUNNING',
  error: null
};

function safe(value, max = 24_000) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .slice(0, max);
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? safe(item) : item));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`${label} timed out${last ? `: ${safe(JSON.stringify(last))}` : ''}`);
}

function countWords(text) {
  // This is intentionally a transparent character count for Chinese output,
  // not a fabricated estimate from requested token counts.
  return String(text || '').replace(/\s/g, '').length;
}

function workspaceWords(workspace) {
  const files = [];
  if (!fs.existsSync(workspace)) return { words: 0, files };
  for (const file of fs.readdirSync(workspace, { recursive: true })) {
    const full = path.join(workspace, String(file));
    if (!fs.statSync(full).isFile() || !/\.(md|txt)$/i.test(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    files.push({ relativePath: path.relative(workspace, full).replaceAll('\\', '/'), words: countWords(text), bytes: Buffer.byteLength(text) });
  }
  return { words: files.reduce((sum, item) => sum + item.words, 0), files };
}

function officeReadiness(homePath) {
  const expected = [
    ['docx', path.join(homePath, 'skills', 'productivity', 'docx', 'SKILL.md')],
    ['xlsx', path.join(homePath, 'skills', 'productivity', 'xlsx', 'SKILL.md')],
    ['powerpoint', path.join(homePath, 'skills', 'productivity', 'powerpoint', 'SKILL.md')]
  ];
  const skills = expected.map(([name, file]) => ({ name, file, present: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 }));
  let python = null;
  try {
    const candidate = process.platform === 'win32'
      ? path.join(root, 'runtime', 'hermes', 'python', 'python.exe')
      : path.join(root, 'runtime', 'hermes', 'python', 'bin', 'python3');
    python = fs.existsSync(candidate) ? candidate : null;
    if (python) {
      const output = execFileSync(python, ['-c', 'import importlib.util,json; print(json.dumps({"pythonDocx":bool(importlib.util.find_spec("docx")),"openpyxl":bool(importlib.util.find_spec("openpyxl")),"pptx":bool(importlib.util.find_spec("pptx"))}))'], { encoding: 'utf8', windowsHide: true }).trim();
      python = { path: candidate, modules: JSON.parse(output) };
    }
  } catch (error) {
    python = { path: python, error: safe(error.message || error) };
  }
  return { homePath, skills, python, libreOffice: Boolean(process.env.PATH && process.env.PATH.split(path.delimiter).some((entry) => fs.existsSync(path.join(entry, process.platform === 'win32' ? 'soffice.exe' : 'soffice')))) };
}

async function main() {
  const started = Date.now();
  const appEnv = { ...process.env, AIBOX_USER_DATA_DIR: userData, AIBOX_DISABLE_HARDWARE_ACCELERATION: '1' };
  for (const name of [
    'AIBOX_ACCEPTANCE_API_KEY', 'AIBOX_NOVEL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'ELECTRON_RUN_AS_NODE'
  ]) delete appEnv[name];
  const application = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env: appEnv, timeout: 60_000 });
  const page = await application.firstWindow({ timeout: 60_000 });
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(safe(message.text())); });
  page.on('pageerror', (error) => report.consoleErrors.push(safe(error.message)));
  await page.locator('.app-shell').waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.evaluate(() => window.aibox.setDebugMode(true));

  let contentsId = null;
  let proxyPort = null;
  const runHistory = [];
  const projectRequest = async (operation, payload) => {
    if (!contentsId) throw new Error('Hermes embedded contents is unavailable');
    const expression = `(() => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 180000); return fetch('/__opc_nexus/project/${operation}', {method:${payload === undefined ? `'GET'` : `'POST'`}, credentials:'include', headers:${payload === undefined ? '{}' : `{'content-type':'application/json'}`}, body:${payload === undefined ? 'undefined' : JSON.stringify(JSON.stringify(payload))}, signal:c.signal}).then(async r => ({status:r.status, body:await r.json()})).finally(() => clearTimeout(t)); })()`;
    return application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes contents was destroyed');
      return contents.executeJavaScript(input.expression, true);
    }, { id: contentsId, expression });
  };

  async function runTurn(project, message, conversationId) {
    const startedAt = Date.now();
    const response = await projectRequest('chat-turn', { message, ...(conversationId ? { conversationId } : {}) });
    if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || `Hermes turn failed: ${response.status}`);
    const result = response.body.result || {};
    const usage = result.usage || {};
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) report.totals.usage[key] += Number(usage[key] || 0);
    report.totals.hermesTurns += 1;
    const item = { startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, conversationId: conversationId || null, content: safe(result.content), usage: serializable(usage), runtime: serializable(result.runtime || null) };
    runHistory.push(item);
    return { ...result, _timing: item };
  }

  async function state() {
    const response = await projectRequest('state');
    if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || `Hermes state failed: ${response.status}`);
    return response.body.result;
  }

  // The acceptance run represents the owner at the keyboard.  Runtime tool
  // approvals remain durable Main-owned decisions; the harness only reads
  // the pending list through preload and clicks "approve" for this explicitly
  // authorized test scenario.  This prevents a real worker from hanging in
  // WAITING_APPROVAL while preserving the approval/audit evidence.
  async function approvePendingTaskApprovals(taskIds) {
    const wanted = new Set(taskIds);
    const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
    const pending = (snapshot.approvals || []).filter((item) => wanted.has(item.taskId) && item.status === 'pending');
    for (const approval of pending) {
      await page.evaluate((id) => window.aibox.decideApproval(id, true), approval.id);
    }
    return pending.map((approval) => ({ id: approval.id, taskId: approval.taskId, type: approval.type, risk: approval.risk }));
  }

  async function openHermes(projectId) {
    const nativeWindow = await waitFor(async () => application.evaluate(({ BrowserWindow, webContents }, targetUrl) => {
      const contents = webContents.getAllWebContents().find((item) => {
        try { return item.getURL() === targetUrl && !item.isDestroyed(); } catch { return false; }
      });
      const host = contents ? BrowserWindow.fromWebContents(contents) : null;
      if (!host || host.isDestroyed()) return null;
      if (host.isMinimized()) host.restore();
      if (!host.isVisible()) host.show();
      const [width, height] = host.getContentSize();
      return width >= 320 && height >= 240 ? { width, height } : null;
    }, page.url()), 10_000, '主窗口原生尺寸');
    const bounds = await page.evaluate((native) => {
      const rect = document.querySelector('.app-shell')?.getBoundingClientRect();
      const x = Math.max(8, Math.round(rect?.x || 8));
      const y = Math.max(8, Math.round(rect?.y || 8));
      return {
        x,
        y,
        width: Math.max(336, Math.min(Math.round(rect?.width || 1200), native.width - x)),
        height: Math.max(256, Math.min(Math.round(rect?.height || 820), native.height - y))
      };
    }, nativeWindow);
    let opened = null;
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        opened = await page.evaluate((input) => window.aibox.openEmbeddedHermesWorkbench(input), { projectId, bounds, theme: 'dark' });
        break;
      } catch (error) {
        lastError = error;
        if (!/superseded|startup timed out|fetch failed/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (!opened) throw lastError || new Error('Hermes Workbench did not open');
    proxyPort = opened.runtime?.proxyPort || null;
    await waitFor(async () => {
      const status = await page.evaluate((id) => window.aibox.getHermesRuntimeStatus(id), projectId);
      if (status.state === 'error' || status.state === 'stopped') throw new Error(status.lastError || `Hermes state=${status.state}`);
      return status.state === 'healthy' ? status : null;
    }, 120_000, 'Hermes project health');
    contentsId = await waitFor(() => application.evaluate(({ webContents }, port) => {
      const candidate = webContents.getAllWebContents().find((item) => { try { return new URL(item.getURL()).port === String(port) && !item.isDestroyed(); } catch { return false; } });
      return candidate?.id || null;
    }, proxyPort), 30_000, 'Hermes embedded web contents');
    await waitFor(() => application.evaluate(({ webContents }, id) => {
      const candidate = webContents.fromId(id);
      return candidate && !candidate.isDestroyed() ? candidate.executeJavaScript('Boolean(document.querySelector("textarea"))', true) : false;
    }, contentsId), 30_000, 'Hermes composer');
    return opened;
  }

  async function createProject(spec) {
    const workspace = path.join(evidenceRoot, spec.slug, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    await application.evaluate(async ({ dialog }, selectedDirectory) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [selectedDirectory] };
        return original(...args);
      };
    }, workspace).catch(() => undefined);
    const project = await page.evaluate((input) => window.aibox.createProject(input), { name: spec.name, objective: spec.objective, description: 'Hermes 小说团队真实验收，动态组队，不绑定固定员工。', status: 'active', workspaceMode: 'custom' });
    const skills = await page.evaluate(() => window.aibox.listSkills());
    const officeSkills = skills.filter((item) => ['Word 文档生成', 'Excel 数据处理', 'PPT 演示制作'].includes(item.name));
    const settings = await page.evaluate(({ id, model, pluginIds }) => window.aibox.saveQuestSettings(id, { mode: 'quest', orchestrator: 'hermes', sandbox: 'workspace', permissionMode: 'standard', model, workerAgentIds: [], pluginIds, maxParallel: 3, autoApproveLowRisk: false }), { id: project.id, model: report.provider.model, pluginIds: officeSkills.map((skill) => `skill:${skill.id}`) });
    spec.project = { id: project.id, name: project.name, workspace, settings, officeSkills: officeSkills.map((item) => ({ id: item.id, name: item.name, enabled: item.enabled })) };
    const opened = await openHermes(project.id);
    spec.runtime = serializable(opened.runtime || null);
    spec.officeReadiness = officeReadiness(opened.runtime?.homePath || path.join(userData, 'aibox-data', 'hermes', 'projects', project.id));
    return { project, workspace };
  }

  async function runNovel(spec) {
    const scenarioStarted = Date.now();
    spec.startedAt = new Date().toISOString();
    try {
      const { project, workspace } = await createProject(spec);
      const teamLabel = `${spec.slug}-${project.id.slice(-4)}`;
      const before = await state();
      const staffing = await runTurn(spec, [
        '老板要建立一支真实的长篇小说创作团队。请现在调用 nexus_create_employee 创建 6 名真实数字员工，ownerConfirmed=true，不要虚构返回：',
        `1. 总编秘书 ${teamLabel}：长期记忆，负责统筹、澄清、计划和向子员工询问验收；`,
        `2. 世界观架构师 ${teamLabel}：长期记忆，负责世界观圣经；`,
        `3. 人物与关系设计师 ${teamLabel}：长期记忆，负责角色卡和关系图；`,
        `4. 长篇大纲编辑 ${teamLabel}：长期记忆，负责三幕/分卷/章节清单；`,
        `5. 章节写手 ${teamLabel}：短期记忆，按设定写试产章节；`,
        `6. 独立文学验收编辑 ${teamLabel}：无记忆，只做单次验收。`,
        '所有员工必须填写具体中文 role、systemPrompt、agentsMd，使用当前已配置的真实执行引擎；不要把员工加入固定项目池（addToProjectPool=false）；此轮只建档，不执行创作。完成后列出 Main 返回的真实员工 ID。'
      ].join('\n'));
      spec.turns = [staffing._timing];
      const after = await state();
      const created = after.employees.filter((employee) => !before.employees.some((old) => old.id === employee.id));
      spec.employees = created.map((employee) => ({ id: employee.id, name: employee.name, role: employee.role, engineId: employee.engineId, memoryMode: employee.memoryMode, capabilities: employee.capabilities }));
      if (created.length < 6) throw new Error(`Hermes created ${created.length} employees, expected at least 6`);
      const byRole = (pattern) => created.find((employee) => pattern.test(`${employee.name} ${employee.role}`));
      const chief = byRole(/总编|秘书|chief|editor/i);
      const reviewer = byRole(/验收|审校|校对|review|validate/i);
      const world = byRole(/世界观|world/i);
      const character = byRole(/人物|角色|character/i);
      const outline = byRole(/大纲|outline|分卷/i);
      const writer = byRole(/写手|写作|章节|writer/i);
      if (!chief || !reviewer || !world || !character || !outline || !writer) throw new Error('Hermes employee roles could not be resolved to real IDs');
      const conversation = await projectRequest('create-conversation', {});
      if (conversation.status !== 200 || !conversation.body?.ok) throw new Error(conversation.body?.error || 'conversation creation failed');
      const conversationId = conversation.body.result.conversationId;
      spec.conversationId = conversationId;
      const planning = await runTurn(spec, [
        `这是一个目标 30 万字的长篇小说项目《${spec.title}》，题材：${spec.genre}。目标是中文原创长篇，最终约 ${TARGET_WORDS} 字，分卷、章节和一致性必须可追溯。`,
        `本轮先调用 clarify，只问一个会影响范围、风格或交付方式的问题；不要在同一轮提交计划。`,
        '收到老板回答后，再调用 nexus_submit_plan。计划必须只使用以下真实员工 ID，禁止虚构：',
        `总编秘书=${created.find((employee) => /总编|秘书|chief|editor/i.test(`${employee.name} ${employee.role}`))?.id || created[0].id}`,
        `世界观架构师=${world.id}`,
        `人物与关系设计师=${character.id}`,
        `长篇大纲编辑=${outline.id}`,
        `章节写手=${writer.id}`,
        `独立文学验收编辑=${reviewer.id}`,
        `本轮只做真实试产批次：世界观、人物卡、长篇大纲、前 ${PILOT_CHAPTERS} 章；不要假装已经写完 30 万字。期望文件：${JSON.stringify(['bible/world.md', 'bible/characters.md', 'outline/novel-outline.md', ...Array.from({ length: PILOT_CHAPTERS }, (_v, i) => `draft/chapter-${String(i + 1).padStart(2, '0')}.md`)])}`,
        '独立验收员工不得进入实现 DAG，后续由主秘书另行调用 nexus_delegate_task 做 validation。不要声称已批准或已完成。'
      ].join('\n'), conversationId);
      spec.turns.push(planning._timing);
      const current = await state();
      const clarification = await waitFor(async () => (await state()).clarifications.find((item) => item.conversationId === conversationId) || null, 120_000, `${spec.slug} clarification`);
      spec.clarification = { id: clarification.clarifyId, prompt: clarification.prompt, questionKind: clarification.questionKind };
      const clarificationPrompt = String(clarification.prompt || '');
      const answer = /workerAgentId|员工对应|对应关系|ID|清单冲突/i.test(clarificationPrompt)
        ? [
            '按 OPC-Nexus Main 返回的权威员工清单严格映射，不采用模型自行猜测的 ID：',
            `总编秘书=${chief.id}`,
            `世界观架构师=${world.id}`,
            `人物与关系设计师=${character.id}`,
            `长篇大纲编辑=${outline.id}`,
            `章节写手=${writer.id}`,
            `独立文学验收编辑=${reviewer.id}`,
            `章节体量仍按每章约 2500-3000 字、约 120 章、12 卷，总目标约 30 万字。${spec.answer}`,
            `本轮只生成前 ${PILOT_CHAPTERS} 章及设定/大纲真实文件，不把 30 万字目标伪造为已完成。`
          ].join('\n')
        : `选择明确体量：每章约 2500-3000 字，约 120 章，分 12 卷，总目标约 30 万字。${spec.answer} 本轮只生成前 ${PILOT_CHAPTERS} 章及设定/大纲真实文件，30 万字目标作为后续分卷生产基线，不在本轮伪造完成。`;
      const answered = await projectRequest('answer-clarify', { clarifyId: clarification.clarifyId, answer });
      if (answered.status !== 200 || !answered.body?.ok) throw new Error(answered.body?.error || 'clarification answer failed');
      spec.answer = answer;
      const plan = await waitFor(async () => {
        // HermesPlanProjection intentionally exposes the governance/session
        // identity, not the UI conversationId. This project has one active
        // draft, so match the authoritative projected row by status.
        const value = (await state()).plans.find((item) => item.status === 'PROJECTED');
        return value && /^[a-f0-9]{64}$/.test(value.hash || '') ? value : null;
      }, 180_000, `${spec.slug} projected plan`);
      spec.plan = { draftId: plan.draftId, planId: plan.planId, version: plan.version, hash: plan.hash, status: plan.status };
      const baseline = await state();
      const approved = await projectRequest('approve-plan', { draftId: plan.draftId });
      const dispatched = await projectRequest('dispatch-plan', { draftId: plan.draftId });
      if (approved.status !== 200 || dispatched.status !== 200 || dispatched.body?.result?.status !== 'DISPATCHED') throw new Error(`plan dispatch failed: ${safe(JSON.stringify({ approved, dispatched }))}`);
      spec.plan.approval = serializable(approved.body.result);
      spec.plan.dispatch = serializable(dispatched.body.result);
      const taskIds = await waitFor(async () => {
        const tasks = (await state()).tasks.filter((task) => !baseline.tasks.some((old) => old.taskId === task.taskId));
        return tasks.length >= 3 ? tasks.map((task) => task.taskId) : null;
      }, 30_000, `${spec.slug} task receipts`);
      spec.taskReceipts = taskIds.length;
      report.totals.taskReceipts += taskIds.length;
      const terminal = await waitFor(async () => {
        await approvePendingTaskApprovals(taskIds);
        const tasks = (await state()).tasks.filter((task) => taskIds.includes(task.taskId));
        return tasks.length === taskIds.length && tasks.every((task) => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) ? tasks : null;
      }, Number(process.env.AIBOX_NOVEL_TASK_TIMEOUT_MS || 2_400_000), `${spec.slug} pilot tasks`);
      spec.tasks = terminal.map((task) => ({ taskId: task.taskId, title: task.title, worker: task.worker, status: task.status, progress: task.progress, intent: task.intent, validationVerdict: task.validationVerdict, files: task.files }));
      report.totals.terminalTasks += terminal.length;
      report.totals.failedTasks += terminal.filter((task) => task.status !== 'COMPLETED').length;
      const manifests = [];
      for (const task of terminal) {
        const value = await page.evaluate((taskId) => window.aibox.getTaskManifest(taskId), task.taskId).catch(() => null);
        manifests.push({ taskId: task.taskId, manifest: serializable(value) });
      }
      spec.manifests = manifests;
      const reviewerPrompt = [
        '实现试产任务已到达终态。现在必须调用一次 nexus_delegate_task 做独立文学验收。',
        `workerAgentId=${reviewer.id}，intent=validation，relatedTaskIds=${JSON.stringify(taskIds)}，expectedArtifacts=[]。`,
        '核对真实文件是否存在、设定是否一致、章节是否符合老板回答。不得创建验收文件，不得把未完成的 30 万字目标说成完成。只返回 PASS、FAIL 或 BLOCKED 及真实证据。'
      ].join('\n');
      const validationReply = await runTurn(spec, reviewerPrompt, conversationId);
      spec.turns.push(validationReply._timing);
      const validationTask = await waitFor(async () => (await state()).tasks.find((task) => task.intent === 'validation' && !taskIds.includes(task.taskId)) || null, 120_000, `${spec.slug} validation receipt`);
      const validationTerminal = await waitFor(async () => {
        await approvePendingTaskApprovals([validationTask.taskId]);
        const task = (await state()).tasks.find((item) => item.taskId === validationTask.taskId);
        return task && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status) ? task : null;
      }, 300_000, `${spec.slug} validation task`);
      spec.validation = { taskId: validationTerminal.taskId, status: validationTerminal.status, verdict: validationTerminal.validationVerdict, worker: validationTerminal.worker, result: validationReply.content };
      report.totals.taskReceipts += 1;
      report.totals.terminalTasks += 1;
      if (validationTerminal.status !== 'COMPLETED') report.totals.failedTasks += 1;
      const words = workspaceWords(workspace);
      spec.actualOutput = words;
      report.totals.actualWords += words.words;
      spec.completion = { targetWords: TARGET_WORDS, actualWords: words.words, ratio: Number((words.words / TARGET_WORDS).toFixed(6)), status: words.words >= TARGET_WORDS ? 'PASS' : 'PILOT_ONLY' };
      const analysis = await runTurn(spec, [
        '请基于本项目的真实 Hermes/OPC-Nexus 状态生成分析报告，不要补写不存在的事实。',
        `目标：${TARGET_WORDS} 字；实际试产字数：${words.words}；任务回执：${spec.taskReceipts}；终态任务：${terminal.length + 1}。`,
        '请说明：调用了哪些真实员工、每个员工实际任务、Hermes 调度耗时、任务耗时、失败/阻断/重试、实际产物和字数、为何当前不能宣称完成 30 万字、下一步如何分卷执行。输出 Markdown，结论必须区分 PASS、PILOT_ONLY、BLOCKED。'
      ].join('\n'), conversationId);
      spec.hermesAnalysis = { content: analysis.content, timing: analysis._timing };
      spec.status = spec.completion.status === 'PASS' && spec.validation.verdict === 'PASS' ? 'PASS' : 'PILOT_ONLY';
    } catch (error) {
      spec.status = 'BLOCKED';
      spec.error = safe(error instanceof Error ? (error.stack || error.message) : error);
      // Do not leave a timed-out acceptance project with orphaned RUNNING
      // tasks after Electron closes.  Read the authoritative state and cancel
      // only this project's active tasks through the normal preload contract.
      try {
        const current = await state();
        const active = current.tasks.filter((task) => ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status));
        for (const task of active) await page.evaluate((id) => window.aibox.cancelTask(id), task.taskId);
        spec.cleanup = { cancelledTaskIds: active.map((task) => task.taskId) };
        spec.tasks = current.tasks.map((task) => ({
          taskId: task.taskId, title: task.title, worker: task.worker, status: task.status,
          progress: task.progress, intent: task.intent, validationVerdict: task.validationVerdict, files: task.files
        }));
      } catch (cleanupError) {
        spec.cleanup = { error: safe(cleanupError instanceof Error ? cleanupError.message : cleanupError) };
      }
    } finally {
      spec.finishedAt = new Date().toISOString();
      spec.durationMs = Date.now() - scenarioStarted;
      spec.hermesTurns = spec.turns?.length || 0;
    }
  }

  try {
    let providers = await page.evaluate(() => window.aibox.listProviders());
    let provider;
    if (configuredProviderBaseUrl || configuredProviderKey) {
      if (!configuredProviderBaseUrl || !configuredProviderKey) {
        throw new Error('AIBOX_NOVEL_BASE_URL and AIBOX_NOVEL_API_KEY must be provided together');
      }
      provider = await page.evaluate((input) => window.aibox.createProvider(input), {
        name: configuredProviderName,
        baseUrl: configuredProviderBaseUrl,
        model: configuredModel || 'deepseek-v4-flash',
        apiKey: configuredProviderKey,
        isDefault: true
      });
      providers = await page.evaluate(() => window.aibox.listProviders());
    } else {
      provider = providers.find((item) => item.isDefault && item.hasKey) || providers.find((item) => item.hasKey);
    }
    if (!provider) throw new Error('No configured Provider with safeStorage key');
    const models = await page.evaluate((id) => window.aibox.fetchProviderModels(id), provider.id);
    if (!models.ok || !models.models?.length) throw new Error(models.error || 'Provider returned no models');
    const requested = configuredModel;
    const model = requested && models.models.includes(requested) ? requested : (models.models.includes(provider.model) ? provider.model : models.models[0]);
    if (model !== provider.model) await page.evaluate(({ id, model: next }) => window.aibox.updateProvider(id, { model: next }), { id: provider.id, model });
    // The Worker engine may have an explicit Provider binding left over from
    // an earlier run (for example the old quya relay).  Selecting a Provider
    // as the acceptance runtime must also update that explicit engine route;
    // otherwise Hermes itself uses DeepSeek while every real employee task
    // silently goes to the stale upstream and fails at 5%.
    if (configuredProviderBaseUrl || configuredProviderKey) {
      const existingEngineConfig = await page.evaluate(() => window.aibox.getEngineConfig('eng-nexus'));
      await page.evaluate(({ existing, providerId, model: nextModel }) => window.aibox.saveEngineConfig('eng-nexus', {
        ...(existing || {}),
        providerMode: 'managed',
        providerId,
        modelOverride: nextModel,
        protocol: 'openai-chat'
      }), { existing: existingEngineConfig, providerId: provider.id, model });
      const restarted = await page.evaluate(() => window.aibox.restartEngine('eng-nexus'));
      if (!restarted?.ok) throw new Error(restarted?.message || 'OPC-Nexus Worker Provider route could not be reloaded');
    }
    const check = await page.evaluate((id) => window.aibox.testProviderById(id), provider.id);
    if (!check.ok) throw new Error(check.error || 'Provider connectivity test failed');
    report.provider = { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, model, modelCount: models.models.length, latencyMs: check.latencyMs ?? null, hasKey: provider.hasKey };
    const specs = [
      { slug: 'novel-a', name: '长篇小说 A · 星海悬疑', title: '《静海回声》', genre: '近未来科幻悬疑', objective: '完成 30 万字长篇科幻悬疑的生产闭环试产', answer: '采用近未来月球城与档案谜案，中文 Markdown，本地交付，不联网发布。' },
      { slug: 'novel-b', name: '长篇小说 B · 历史权谋', title: '《雁门旧局》', genre: '架空历史权谋', objective: '完成 30 万字长篇历史权谋的生产闭环试产', answer: '采用架空王朝边疆与盐运政治，中文 Markdown，本地交付，不联网发布。' }
    ];
    for (const spec of specs) {
      report.projects.push(spec);
      // Each project is independent; a startup failure is evidence for that
      // project but must not erase the results already obtained for the other.
      await runNovel(spec);
      contentsId = null;
    }
    report.officeSkills = report.projects.map((project) => ({ projectId: project.project?.id, readiness: project.officeReadiness }));
    report.result = report.projects.every((project) => project.status === 'PASS') ? 'PASS' : report.projects.some((project) => project.status === 'PILOT_ONLY') ? 'PILOT_ONLY' : 'BLOCKED';
    // Preserve the exact Hermes-generated analysis in a human-readable file.
    const analyses = report.projects.filter((project) => project.hermesAnalysis?.content).map((project) => `## ${project.name}\n\n${safe(project.hermesAnalysis.content, 60_000)}`).join('\n\n');
    fs.writeFileSync(path.join(evidenceRoot, 'hermes-analysis.md'), `# Hermes 小说团队真实分析\n\n生成时间：${new Date().toISOString()}\n\n${analyses || 'Hermes 未能生成分析：本轮在分析阶段前被真实错误阻断。'}\n`, 'utf8');
  } catch (error) {
    report.result = 'BLOCKED';
    report.error = safe(error instanceof Error ? (error.stack || error.message) : error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    fs.writeFileSync(path.join(evidenceRoot, 'report.json'), JSON.stringify(serializable(report), null, 2), 'utf8');
    await application.close().catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify({ result: report.result, reportPath: path.join(evidenceRoot, 'report.json'), analysisPath: path.join(evidenceRoot, 'hermes-analysis.md'), projects: report.projects.map((project) => ({ name: project.name, status: project.status, durationMs: project.durationMs, actualWords: project.completion?.actualWords || 0, taskReceipts: project.taskReceipts || 0 })) }, null, 2)}\n`);
  if (report.result === 'BLOCKED') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${safe(error)}\n`);
  process.exitCode = 1;
});

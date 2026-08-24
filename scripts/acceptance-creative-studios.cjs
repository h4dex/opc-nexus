'use strict';

// Real creative-studio acceptance. This script deliberately drives the same
// Electron IPC, Hermes project proxy, Orchestrator and artifact gates as a
// human user. It never inserts tasks/employees directly into SQLite.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(process.env.AIBOX_CREATIVE_OUTPUT || path.join(root, 'tmp', 'acceptance-creative-studios', stamp));
const seedUserData = (process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || '').trim();
if (!seedUserData || !fs.statSync(seedUserData).isDirectory()) {
  throw new Error('AIBOX_ACCEPTANCE_SEED_USER_DATA must point to a seeded user-data directory with a real Provider');
}
const userData = path.join(evidenceRoot, 'user-data');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(seedUserData, userData, { recursive: true, force: true });

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  userData,
  comparison: {
    workbuddy: ['visible project context', 'clear running/queued state', 'resumeable work'],
    codex: ['composer remains usable while work runs', 'collapsible execution evidence', 'explicit delivery evidence']
  },
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
  result: 'RUNNING'
};

function safe(value, max = 12_000) {
  return String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').slice(0, max);
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

async function main() {
  const application = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env: { ...process.env, AIBOX_USER_DATA_DIR: userData, AIBOX_DISABLE_HARDWARE_ACCELERATION: '1' },
    timeout: 60_000
  });
  const page = await application.firstWindow({ timeout: 60_000 });
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(safe(message.text())); });
  page.on('pageerror', (error) => report.consoleErrors.push(safe(error.message)));
  await page.locator('.app-shell').waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.evaluate(() => window.aibox.setDebugMode(true));

  let contentsId = null;
  let proxyPort = null;
  let project = null;
  let workspace = null;
  let projectModel = null;
  let projectRequest;

  const providers = await page.evaluate(() => window.aibox.listProviders());
  const provider = providers.find((item) => item.isDefault && item.hasKey) || providers.find((item) => item.hasKey);
  if (!provider) throw new Error('Seed user data has no usable Provider');
  const models = await page.evaluate((id) => window.aibox.fetchProviderModels(id), provider.id);
  if (!models.ok || !Array.isArray(models.models) || models.models.length === 0) throw new Error(models.error || 'Provider returned no models');
  projectModel = ['deepseek-v4-pro-0813', 'deepseek-v4-flash-0731', 'gpt-4o-mini'].find((candidate) => models.models.includes(candidate)) || models.models[0];
  await page.evaluate(({ id, model }) => window.aibox.updateProvider(id, { model }), { id: provider.id, model: projectModel });
  const providerTest = await page.evaluate((id) => window.aibox.testProviderById(id), provider.id);
  if (!providerTest.ok) throw new Error(providerTest.error || 'Provider connectivity test failed');
  report.provider = { baseUrl: provider.baseUrl, model: projectModel, modelCount: models.models.length, latencyMs: providerTest.latencyMs ?? null };

  const currentBounds = () => page.evaluate(() => {
    const root = document.querySelector('.app-shell');
    const rect = root?.getBoundingClientRect();
    return { x: Math.max(8, Math.round(rect?.x ?? 8)), y: Math.max(8, Math.round(rect?.y ?? 8)), width: Math.max(336, Math.round(rect?.width ?? 1200)), height: Math.max(256, Math.round(rect?.height ?? 820)) };
  });

  const discoverContents = async () => application.evaluate(({ webContents }, port) => {
    const item = webContents.getAllWebContents().find((candidate) => {
      try { return new URL(candidate.getURL()).port === String(port) && !candidate.isDestroyed(); } catch { return false; }
    });
    return item?.id || null;
  }, proxyPort);

  async function openHermes() {
    const input = { projectId: project.id, bounds: await currentBounds(), theme: 'dark' };
    let result = null;
    let lastError = null;
    // QuestWorkbench may be opening the same project automatically after the
    // project becomes active. Treat that single Main-side supersession as a
    // recoverable UI race and retry after the previous mutation settles.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        result = await page.evaluate((value) => window.aibox.openEmbeddedHermesWorkbench(value), input);
        break;
      } catch (error) {
        lastError = error;
        if (!/superseded/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    if (!result) throw lastError || new Error('Hermes embedded Workbench did not open');
    if (!result.runtime?.proxyPort) throw new Error('Hermes proxy was not returned');
    proxyPort = result.runtime.proxyPort;
    await waitFor(async () => {
      const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (status.state === 'error' || status.state === 'stopped') throw new Error(status.lastError || `Hermes state=${status.state}`);
      return status.state === 'healthy' ? status : null;
    }, 120_000, 'Hermes project health');
    contentsId = await waitFor(discoverContents, 30_000, 'Hermes embedded contents');
    await waitFor(async () => application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return null;
      return contents.executeJavaScript(`Boolean(document.querySelector('textarea[placeholder="给 Hermes 下达任务"]'))`, true);
    }, contentsId), 30_000, 'Hermes composer');
    return result;
  }

  projectRequest = async (operation, payload) => {
    // An upstream provider can keep a Hermes turn open indefinitely. Bound
    // the test transport so a real outage becomes BLOCKED evidence rather
    // than leaving Electron and its child runtimes behind.
    const timeoutMs = 180_000;
    const expression = `(() => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ${timeoutMs}); return fetch('/__opc_nexus/project/${operation}', {method:${payload === undefined ? `'GET'` : `'POST'`}, credentials:'include', headers:${payload === undefined ? '{}' : `{'content-type':'application/json'}`}, body:${payload === undefined ? 'undefined' : JSON.stringify(JSON.stringify(payload))}, signal: controller.signal}).then(async r=>JSON.stringify({status:r.status,body:await r.json()})).finally(() => clearTimeout(timer)); })()`;
    const serialized = await application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes contents is unavailable');
      return contents.executeJavaScript(input.source, true);
    }, { id: contentsId, source: expression });
    const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (value === undefined) {
      const diagnostic = await application.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        return { id, url: contents?.getURL?.() || null, ready: Boolean(contents && !contents.isDestroyed()) };
      }, contentsId).catch((error) => ({ error: safe(error) }));
      throw new Error(`Hermes project request returned no JSON for ${operation}: ${safe(JSON.stringify(diagnostic))}`);
    }
    return value;
  };

  async function capture(name, targetContents = contentsId) {
    const file = path.join(evidenceRoot, `${report.scenarios.length + 1}-${name}.png`);
    const png = await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      return (await contents.capturePage()).toPNG().toString('base64');
    }, targetContents);
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    report.screenshots.push(file);
    return file;
  }

  async function step(scenario, name, action) {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const evidence = await action();
      const item = { name, status: 'PASS', startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, evidence };
      scenario.steps.push(item);
      return evidence;
    } catch (error) {
      const item = { name, status: 'BLOCKED', startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, error: safe(error instanceof Error ? error.message : error) };
      scenario.steps.push(item);
      throw error;
    }
  }

  async function createScenarioProject(name, objective, scenario) {
    workspace = path.join(evidenceRoot, name.replace(/[^\w\u4e00-\u9fff-]+/g, '-'), 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    await application.evaluate(async ({ dialog }, selectedDirectory) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [selectedDirectory] };
        return original(...args);
      };
    }, workspace).catch(() => undefined);
    project = await page.evaluate((input) => window.aibox.createProject(input), {
      name, objective, description: '由 Hermes 根据老板描述组建动态创作团队，不绑定固定员工池。', status: 'active', workspaceMode: 'custom'
    });
    scenario.project = { id: project.id, name: project.name, workspace };
    await page.evaluate(({ projectId, model }) => window.aibox.saveQuestSettings(projectId, {
      mode: 'quest', orchestrator: 'hermes', sandbox: 'workspace', permissionMode: 'standard',
      model, workerAgentIds: [], pluginIds: [], maxParallel: 4, autoApproveLowRisk: false
    }), { projectId: project.id, model: projectModel });
    await openHermes();
  }

  function httpsJson(url, options = {}) {
    const target = new URL(url);
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method || (body ? 'POST' : 'GET'),
        rejectUnauthorized: false,
        headers: { ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}), ...(options.headers || {}) }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
          resolve({ status: response.statusCode || 0, headers: response.headers, json, text });
        });
      });
      request.once('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  async function runTurn(message, conversationId) {
    const response = await projectRequest('chat-turn', { message, ...(conversationId ? { conversationId } : {}) });
    if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || `Hermes turn failed: ${response.status}`);
    return response.body.result;
  }

  async function projectState() {
    const response = await projectRequest('state');
    if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || 'Hermes state failed');
    return response.body.result;
  }

  async function waitTasks(ids, timeoutMs = 360_000) {
    return waitFor(async () => {
      const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
      const tasks = snapshot.tasks.filter((task) => ids.includes(task.id));
      for (const approval of snapshot.approvals.filter((item) => item.status === 'pending' && tasks.some((task) => task.id === item.taskId))) {
        await page.evaluate((id) => window.aibox.decideApproval(id, true), approval.id);
      }
      return tasks.length === ids.length && tasks.every((task) => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) ? tasks : null;
    }, timeoutMs, 'creative workers completion');
  }

  async function staffViaHermes(scenario, staffingPrompt) {
    const before = await projectState();
    const result = await step(scenario, '老板在 Hermes 描述团队并由 Hermes 创建数字员工', () => runTurn(staffingPrompt));
    const employees = await waitFor(async () => {
      const current = await projectState();
      const created = current.employees.filter((employee) => !before.employees.some((old) => old.id === employee.id));
      return created.length >= 4 ? created : null;
    }, 180_000, 'Hermes-created creative employees');
    scenario.staffing = employees.map((employee) => ({ id: employee.id, name: employee.name, role: employee.role, engineId: employee.engineId, memoryMode: employee.memoryMode, capabilities: employee.capabilities }));
    scenario.staffingReply = safe(result.content);
    await capture(`${scenario.slug}-staffing`);
    return employees;
  }

  async function runComplexScenario(scenario, employees, brief) {
    // Conversation creation is a state-changing project operation and must use
    // the same POST contract as the embedded Hermes UI.
    const conversationResponse = await projectRequest('create-conversation', {});
    if (conversationResponse.status !== 200 || !conversationResponse.body?.ok || !conversationResponse.body.result?.conversationId) {
      throw new Error(conversationResponse.body?.error || `Hermes conversation creation failed: ${conversationResponse.status}`);
    }
    const conversation = conversationResponse.body.result;
    scenario.conversationId = conversation.conversationId;
    const ids = employees.map((employee) => employee.id);
    const planRequest = await step(scenario, '老板下达复杂创作任务，Hermes 先澄清边界', () => runTurn([
      `这是一个复杂创作项目：${brief.objective}`,
      '本轮先调用 clarify，只问一个会影响交付的范围问题，不要提交计划。',
      '收到老板回答后再调用 nexus_submit_plan，计划必须只使用下列真实员工 ID，禁止虚构员工：',
      ...employees.map((employee) => `${employee.name}=${employee.id}`),
      `DAG 节点必须产生这些真实项目相对文件：${JSON.stringify(brief.artifacts)}。每个文件只能归属一个节点。`,
      '硬一致性要求：所有文件统一使用“静海城”这一名称；档案馆是中立机构，当前只做实体档案数字化迁移，不写成机构关闭或违反“档案永存”律令；角色卡和正文必须严格引用世界观文件，不得另造“静海市”等同义名。',
      'DAG 只允许包含 3 个实现节点（世界观、角色卡、第一章）；不要把独立文学验收编辑加入 DAG，也不要创建验收节点。实现完成后，主秘书会在另一个独立步骤单独委派验收员工。',
      '不要声称已批准或完成。'
    ].join('\n'), conversation.conversationId));
    scenario.initialReply = safe(planRequest.content);
    const clarification = await waitFor(async () => (await projectState()).clarifications.find((item) => item.conversationId === conversation.conversationId) || null, 120_000, 'creative clarification');
    scenario.clarification = { id: clarification.clarifyId, prompt: clarification.prompt };
    await step(scenario, '老板回答澄清问题', async () => {
      const answer = await projectRequest('answer-clarify', { clarifyId: clarification.clarifyId, answer: brief.answer });
      if (answer.status !== 200 || !answer.body?.ok) throw new Error(answer.body?.error || 'Clarification answer failed');
      return answer.body.result;
    });
    const plan = await step(scenario, 'Hermes 生成真实计划草案并由 Main 赋予版本/hash', async () => {
      const value = await waitFor(async () => (await projectState()).plans.find((item) => item.status === 'PROJECTED') || null, 180_000, 'creative plan projection');
      if (!/^[a-f0-9]{64}$/.test(value.hash || '') || !Number.isInteger(value.version)) throw new Error(`Invalid plan identity: ${safe(JSON.stringify(value))}`);
      return { draftId: value.draftId, planId: value.planId, version: value.version, hash: value.hash };
    });
    scenario.plan = plan;
    // Capture the task baseline before approval/dispatch. The Main process
    // creates tasks synchronously during dispatch, so taking this snapshot
    // afterwards would incorrectly classify every real task as pre-existing.
    const beforeTasks = await page.evaluate(() => window.aibox.getSnapshot());
    await step(scenario, '老板批准并派发 Hermes DAG', async () => {
      const approved = await projectRequest('approve-plan', { draftId: plan.draftId });
      if (approved.status !== 200 || approved.body?.result?.status !== 'APPROVED') throw new Error(approved.body?.error || 'plan approval failed');
      const dispatched = await projectRequest('dispatch-plan', { draftId: plan.draftId });
      if (dispatched.status !== 200 || dispatched.body?.result?.status !== 'DISPATCHED') throw new Error(dispatched.body?.error || 'plan dispatch failed');
      return { approved: approved.body.result, dispatched: dispatched.body.result };
    });
    const taskIds = await waitFor(async () => {
      const current = await page.evaluate(() => window.aibox.getSnapshot());
      const tasks = current.tasks.filter((task) => task.projectId === project.id && !beforeTasks.tasks.some((old) => old.id === task.id));
      return tasks.length >= brief.minTasks ? tasks.map((task) => task.id) : null;
    }, 30_000, 'creative DAG tasks');
    const dispatchedTasks = await page.evaluate(() => window.aibox.getSnapshot());
    const reviewer = employees.find((employee) => /验收|审校|校对|review|validate/i.test(`${employee.name} ${employee.role}`));
    if (!reviewer) throw new Error('No independent acceptance employee was created');
    if (dispatchedTasks.tasks.some((task) => task.projectId === project.id && taskIds.includes(task.id) && task.agentId === reviewer.id)) {
      throw new Error('Hermes plan incorrectly included the independent acceptance employee in the implementation DAG');
    }
    scenario.taskIds = taskIds;
    const terminals = await step(scenario, '数字员工真实执行并生成交付文件', () => waitTasks(taskIds, 600_000));
    scenario.tasks = terminals.map((task) => ({ id: task.id, title: task.title, agentId: task.agentId, status: task.status, progress: task.progress, error: task.error }));
    const manifests = [];
    for (const task of terminals) {
      const manifest = await page.evaluate((taskId) => window.aibox.getTaskManifest(taskId), task.id);
      manifests.push({ taskId: task.id, manifest });
    }
    scenario.manifests = manifests.map((item) => ({ taskId: item.taskId, entries: item.manifest?.entries?.map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256, previewable: entry.previewable })) || [] }));
    const produced = scenario.manifests.flatMap((item) => item.entries.map((entry) => entry.relativePath));
    if (!brief.artifacts.every((artifact) => produced.includes(artifact))) throw new Error(`Missing real artifacts: expected ${brief.artifacts.join(', ')}; got ${produced.join(', ')}`);
    await capture(`${scenario.slug}-delivery`);

    const validation = await step(scenario, '主秘书委派独立验收员工', () => runTurn([
      '你是主秘书。实现任务已结束，必须委派另一名未参与实现的员工做独立验收，不要自己验收。',
      `只调用一次 nexus_delegate_task，workerAgentId=${reviewer.id}，intent=validation，relatedTaskIds=${JSON.stringify(taskIds)}，expectedArtifacts=[]。`,
      '验收真实文件是否存在、内容是否符合老板范围和任务标准；只返回最终 PASS、FAIL 或 BLOCKED 及不超过 300 字的依据，不创建验收文件，不逐字复述输入材料，不要提前宣称 PASS。'
    ].join('\n'), conversation.conversationId));
    scenario.validationReply = safe(validation.content);
    const validationTask = await waitFor(async () => {
      const current = await page.evaluate(() => window.aibox.getSnapshot());
      return current.tasks.find((task) => !taskIds.includes(task.id) && task.agentId === reviewer.id && String(task.content || '').startsWith('Task intent: validation')) || null;
    }, 120_000, 'independent creative validator');
    const validationTerminal = (await waitTasks([validationTask.id], 240_000))[0];
    const status = await step(scenario, '读取独立验收权威结果', async () => {
      const result = await runTurn(`必须使用 nexus_task_status 查询验收任务 ${validationTerminal.id}，只依据 validationVerdict 汇总 PASS、FAIL 或 BLOCKED，不得猜测。`, conversation.conversationId);
      return { taskId: validationTerminal.id, status: validationTerminal.status, result: validationTerminal.result, secretaryReply: safe(result.content) };
    });
    scenario.validation = status;
    const verdict = String(status.result || '').match(/\b(PASS|FAIL|BLOCKED)\b/i)?.[1]?.toUpperCase() || 'BLOCKED';
    scenario.verdict = verdict;
    if (verdict !== 'PASS') throw new Error(`Independent acceptance returned ${verdict}: ${safe(JSON.stringify(status))}`);
  }

  try {
    const novel = { slug: 'novel-team', name: '小说创作团队真实验收', steps: [] };
    report.scenarios.push(novel);
    await createScenarioProject(novel.name, '完成一篇短篇科幻小说的设定、首章和一致性验收', novel);
    const novelEmployees = await staffViaHermes(novel, [
      '老板要建立一个真实的小说创作团队，请现在调用 nexus_create_employee 创建 4 名数字员工：世界观架构师（长期记忆，负责设定）、角色设计师（长期记忆，负责角色卡）、章节写手（当前会话短期记忆，负责首章）、独立文学验收编辑（无记忆，仅单次验收）。',
      '每个员工都要有具体 role、中文 systemPrompt 和 agentsMd；ownerConfirmed 必须为 true；默认使用已配置的真实 Nexus 引擎；不要把员工加入固定项目池，项目保持动态组队。不要执行创作任务，完成后列出 Main 返回的真实 ID。'
    ].join('\n'));
    await runComplexScenario(novel, novelEmployees, {
      objective: '以“月面档案馆”为题创作一篇约 1000 字科幻短篇，交付世界观、角色卡和第一章，并由独立编辑验收一致性。',
      artifacts: ['research/world-bible.md', 'research/character-bible.md', 'draft/chapter-01.md'],
      minTasks: 3,
      answer: '采用近未来月球城市背景；交付中文 Markdown；只在本地项目目录生成文件，不联网发布。'
    });

    const film = { slug: 'film-team', name: '影视创作团队真实验收', steps: [] };
    report.scenarios.push(film);
    await createScenarioProject(film.name, '完成一部 5 分钟短片的前期创作、分镜和制作验收', film);
    const filmEmployees = await staffViaHermes(film, [
      '老板要建立一个真实的影视创作团队，请现在调用 nexus_create_employee 创建 4 名数字员工：故事开发编剧（长期记忆，负责梗概和主题）、剧本编剧（当前会话短期记忆，负责分场剧本）、分镜与制片统筹（无记忆，负责镜头表和拍摄计划）、独立影视验收导演（无记忆，仅单次验收）。',
      '每个员工必须用中文填写具体 role、systemPrompt 和 agentsMd；ownerConfirmed 必须为 true；使用已配置真实引擎；不要加入固定员工池；不要执行任务，完成后返回 Main 的真实员工 ID。'
    ].join('\n'));
    await runComplexScenario(film, filmEmployees, {
      objective: '以“最后一班电车”为题完成 5 分钟现实主义短片前期包，交付故事梗概、分场剧本和分镜/拍摄计划，由独立导演验收。',
      artifacts: ['preproduction/story-outline.md', 'preproduction/screenplay.md', 'preproduction/shot-list.md'],
      minTasks: 3,
      answer: '采用当代城市夜班背景；交付中文 Markdown；只生成本地前期文档，不声称已拍摄或发布影片。'
    });

    const mobileScenario = { steps: [], slug: 'mobile', name: '手机 Web 真实查看影视项目状态' };
    report.scenarios.push(mobileScenario);
    const mobile = await step(mobileScenario, '手机 Web 真实查看影视项目状态', async () => {
      const port = await reservePort();
      const offer = await page.evaluate(({ projectId, port }) => window.aibox.createHermesMobilePairing(projectId, { bindHost: '127.0.0.1', port, publicHost: '127.0.0.1' }), { projectId: report.scenarios[1].project.id, port });
      const paired = await httpsJson(`${offer.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: offer.origin }, body: { code: offer.code } });
      if (paired.status !== 200) throw new Error(`mobile pairing status=${paired.status}`);
      const cookie = Array.isArray(paired.headers['set-cookie']) ? paired.headers['set-cookie'][0]?.split(';')[0] : String(paired.headers['set-cookie'] || '').split(';')[0];
      const state = await httpsJson(`${offer.origin}/__opc_nexus/project/state`, { headers: { Cookie: cookie } });
      if (state.status !== 200) throw new Error(`mobile state status=${state.status}`);
      return { origin: offer.origin, pairingStatus: paired.status, stateStatus: state.status, projectId: state.json?.result?.projectId };
    });
    report.mobile = mobile;
    report.result = report.scenarios.every((scenario) => scenario.verdict === 'PASS') ? 'PASS' : 'BLOCKED';
  } catch (error) {
    report.result = 'BLOCKED';
    report.error = safe(error instanceof Error ? (error.stack || error.message) : error);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    await application.close().catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify({ result: report.result, reportPath: path.join(evidenceRoot, 'report.json'), scenarios: report.scenarios.map((scenario) => ({ name: scenario.name, verdict: scenario.verdict, steps: scenario.steps.length })) }, null, 2)}\n`);
  if (report.result !== 'PASS') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${safe(error)}\n`);
  process.exitCode = 1;
});

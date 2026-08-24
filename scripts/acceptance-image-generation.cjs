'use strict';

// Real image-generation acceptance through the Electron UI and Hermes project
// Host Contract. The seed user-data directory must contain a configured,
// encrypted Provider; the script never accepts a mock response.
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const seedUserData = (process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || '').trim();
if (!seedUserData || !fs.statSync(seedUserData).isDirectory()) {
  throw new Error('AIBOX_ACCEPTANCE_SEED_USER_DATA must point to a user-data directory with a real Provider');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(process.env.AIBOX_IMAGE_OUTPUT || path.join(root, 'tmp', 'acceptance-image-generation', stamp));
const userData = path.join(evidenceRoot, 'user-data');
const workspace = path.join(evidenceRoot, 'shaver-shop', 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.cpSync(seedUserData, userData, { recursive: true, force: true });

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  evidenceRoot,
  workspace,
  status: 'RUNNING',
  steps: []
};

function bounded(value, max = 12_000) {
  return String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').slice(0, max);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}

function record(name, startedAt, status, evidence) {
  report.steps.push({ name, startedAt, endedAt: new Date().toISOString(), status, ...(status === 'PASS' ? { evidence } : { error: bounded(evidence) }) });
}

async function main() {
  let application;
  try {
    application = await electron.launch({
      executablePath: require('electron'),
      args: ['.'],
      cwd: root,
      env: { ...process.env, AIBOX_USER_DATA_DIR: userData, AIBOX_DISABLE_HARDWARE_ACCELERATION: '1' },
      timeout: 60_000
    });
    const page = await application.firstWindow({ timeout: 60_000 });
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });

    let startedAt = new Date().toISOString();
    const providers = await page.evaluate(() => window.aibox.listProviders());
    const provider = providers.find((item) => item.isDefault && item.hasKey) || providers.find((item) => item.hasKey);
    if (!provider) throw new Error('No configured Provider with an encrypted API Key');
    const models = await page.evaluate((id) => window.aibox.fetchProviderModels(id), provider.id);
    if (!models.ok || !Array.isArray(models.models) || models.models.length === 0) throw new Error(models.error || 'Provider model listing failed');
    const inferenceModel = provider.model || models.models[0];
    const imageModel = ['gpt-image-2', 'gpt-image-1.5', 'dall-e-3'].find((candidate) => models.models.includes(candidate)) || 'gpt-image-2';
    report.provider = { baseUrl: provider.baseUrl, inferenceModel, imageModel, modelCount: models.models.length };
    record('读取真实 Provider 和上游模型列表', startedAt, 'PASS', { baseUrl: provider.baseUrl, imageModel, modelCount: models.models.length });

    startedAt = new Date().toISOString();
    await application.evaluate(async ({ dialog }, selectedDirectory) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [selectedDirectory] };
        return original(...args);
      };
    }, workspace);
    const project = await page.evaluate((input) => window.aibox.createProject(input), {
      name: '剃须刀电商素材真实验收',
      objective: '使用真实图片模型生成一套电商店铺剃须刀素材',
      description: '由 Hermes 通过受治理图片工具生成真实图片产物。',
      status: 'active',
      workspaceMode: 'custom',
      workspace
    });
    await page.evaluate(({ projectId, model }) => window.aibox.saveQuestSettings(projectId, {
      mode: 'quest', orchestrator: 'hermes', sandbox: 'workspace', permissionMode: 'standard',
      model, workerAgentIds: [], pluginIds: [], maxParallel: 2, autoApproveLowRisk: false
    }), { projectId: project.id, model: inferenceModel });
    record('创建项目并绑定项目工作目录', startedAt, 'PASS', { projectId: project.id, workspace });

    startedAt = new Date().toISOString();
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector('.app-shell')?.getBoundingClientRect();
      return {
        x: Math.max(8, Math.round(rect?.x ?? 8)),
        y: Math.max(8, Math.round(rect?.y ?? 8)),
        width: Math.max(336, Math.round(rect?.width ?? 1200)),
        height: Math.max(256, Math.round(rect?.height ?? 820))
      };
    });
    let opened = null;
    let lastOpenError = null;
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      try {
        opened = await page.evaluate(({ projectId, bounds }) => window.aibox.openEmbeddedHermesWorkbench({ projectId, bounds, theme: 'dark' }), { projectId: project.id, bounds });
      } catch (error) {
        lastOpenError = error;
        if (!/superseded/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    if (!opened) throw lastOpenError || new Error('Hermes embedded Workbench did not open');
    const status = await waitFor(async () => {
      const value = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
      if (value.state === 'error' || value.state === 'stopped') throw new Error(value.lastError || `Hermes state=${value.state}`);
      return value.state === 'healthy' ? value : null;
    }, 120_000, 'Hermes project runtime');
    record('启动并健康检查 Hermes 项目服务', startedAt, 'PASS', { state: status.state, proxyPort: opened.runtime?.proxyPort ?? null });

    const contentsId = await waitFor(async () => application.evaluate(({ webContents }, port) => {
      const item = webContents.getAllWebContents().find((candidate) => {
        try { return new URL(candidate.getURL()).port === String(port) && !candidate.isDestroyed(); } catch { return false; }
      });
      return item?.id || null;
    }, opened.runtime?.proxyPort), 30_000, 'Hermes workbench contents');
    await waitFor(async () => application.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return false;
      return contents.executeJavaScript(`Boolean(document.querySelector('textarea[placeholder="给 Hermes 下达任务"]'))`, true);
    }, contentsId), 30_000, 'Hermes composer');
    async function projectRequest(operation, payload) {
      const timeoutMs = 300_000;
      const expression = `(() => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ${timeoutMs}); return fetch('/__opc_nexus/project/${operation}', {method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:${JSON.stringify(JSON.stringify(payload))}, signal: controller.signal}).then(async r=>JSON.stringify({status:r.status,body:await r.json()})).finally(() => clearTimeout(timer)); })()`;
      const raw = await application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents || contents.isDestroyed()) throw new Error('Hermes workbench contents is unavailable');
        return contents.executeJavaScript(input.source, true);
      }, { id: contentsId, source: expression });
      if (raw === undefined) {
        const diagnostic = await application.evaluate(({ webContents }, id) => {
          const contents = webContents.fromId(id);
          return { id, url: contents?.getURL?.() || null, ready: Boolean(contents && !contents.isDestroyed()) };
        }, contentsId).catch((error) => ({ error: bounded(error) }));
        throw new Error(`Hermes project request returned no JSON for ${operation}: ${bounded(JSON.stringify(diagnostic))}`);
      }
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    const prompts = [
      ['main.png', '白底电商主图，正面展示一把高级黑色电动剃须刀，产品完整无遮挡，柔和棚拍光，纯白背景，适合商品首图，不要文字水印。'],
      ['bathroom.png', '电商场景图，一把高级黑色电动剃须刀放在现代简洁男士浴室洗手台，干净明亮，产品是视觉主体，写实商业摄影，不要文字水印。'],
      ['detail.png', '电商卖点特写图，突出电动剃须刀金属刀头、防水结构和人体工学握柄，黑色与银色材质，精致商业产品摄影，不要文字水印。'],
      ['lifestyle.png', '电商生活方式横幅图，年轻男士在明亮浴室使用高级黑色电动剃须刀，画面留出右侧留白用于后期排版，写实商业广告摄影，不要文字水印。']
    ];
    const outputs = [];
    for (const [filename, prompt] of prompts) {
      startedAt = new Date().toISOString();
      const message = [
          '老板明确授权真实生成图片。本轮只调用一次 nexus_image_generate，不要调用 native image_generate，不要创建任务计划。',
          `使用真实图片模型 ${imageModel}，prompt=${prompt}`,
          `outputPath=product-images/${filename}，size=1024x1024，count=1，ownerConfirmed=true。`,
          '只有 Host Contract 返回真实文件和 SHA-256 后才能汇报成功；如果 Provider 不支持图片接口，原样报告 HTTP 状态和错误。'
        ].join('\n');
      const response = await projectRequest('chat-turn', { message });
      if (response.status !== 200 || !response.body?.ok) throw new Error(response.body?.error || `Hermes image turn failed: ${response.status}`);
      const expected = path.join(workspace, 'product-images', filename);
      await waitFor(() => fs.existsSync(expected) && fs.statSync(expected).size > 0, 300_000, `image artifact ${filename}`);
      const bytes = fs.readFileSync(expected);
      const crypto = require('node:crypto');
      outputs.push({
        relativePath: path.relative(workspace, expected).replaceAll('\\', '/'),
        bytes: bytes.byteLength,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        reply: bounded(response.body.result?.content, 2_000)
      });
      record(`Hermes 真实生成 ${filename}`, startedAt, 'PASS', outputs.at(-1));
    }
    report.outputs = outputs;
    report.status = outputs.length === prompts.length ? 'PASS' : 'BLOCKED';
  } catch (error) {
    report.status = 'BLOCKED';
    report.error = bounded(error instanceof Error ? (error.stack || error.message) : error);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    await application?.close().catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: path.join(evidenceRoot, 'report.json'), outputs: report.outputs || [], error: report.error || null }, null, 2)}\n`);
  if (report.status !== 'PASS') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${bounded(error)}\n`);
  process.exitCode = 1;
});

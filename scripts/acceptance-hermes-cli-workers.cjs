'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.AIBOX_ACCEPTANCE_OUTPUT || path.join(root, 'tmp', 'acceptance-hermes-cli-workers', stamp)
);
const defaultSeed = path.join(root, 'tmp', 'acceptance-real', '2026-08-20-compat-r3', 'user-data');
const seedUserData = path.resolve(process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || defaultSeed);
const userData = path.join(evidenceRoot, 'user-data');
const workspace = path.join(evidenceRoot, 'project-workspace');
const reportPath = path.join(evidenceRoot, 'report.json');
const screenshotPath = path.join(evidenceRoot, 'quest-cli-workers.png');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  seedUserData,
  userData,
  workspace,
  provider: null,
  startup: null,
  workers: [],
  steps: [],
  consoleErrors: [],
  result: 'RUNNING'
};

function safeText(value, max = 8_000) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, max);
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'string' ? safeText(item) : item
  )));
}

async function step(name, action, required = true) {
  const startedAt = Date.now();
  try {
    const value = await action();
    report.steps.push({ name, status: 'PASS', durationMs: Date.now() - startedAt, evidence: serializable(value) });
    return value;
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : error);
    report.steps.push({ name, status: required ? 'FAIL' : 'BLOCKED', durationMs: Date.now() - startedAt, error: message });
    if (required) throw error;
    return null;
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out${last ? `: ${safeText(JSON.stringify(last))}` : ''}`);
}

function assertSecretFree(value, label) {
  const text = JSON.stringify(value);
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(text)) {
    throw new Error(`${label} exposed a Provider credential`);
  }
}

async function main() {
  if (!fs.existsSync(seedUserData) || !fs.statSync(seedUserData).isDirectory()) {
    throw new Error(`Acceptance seed user-data is unavailable: ${seedUserData}`);
  }
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.cpSync(seedUserData, userData, { recursive: true, force: true, errorOnExist: false });
  fs.mkdirSync(workspace, { recursive: true });

  const appEnv = {
    ...process.env,
    AIBOX_DISABLE_HARDWARE_ACCELERATION: '1',
    AIBOX_USER_DATA_DIR: userData
  };
  for (const name of [
    'AIBOX_ACCEPTANCE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL',
    'ELECTRON_RUN_AS_NODE'
  ]) delete appEnv[name];

  const application = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env: appEnv,
    timeout: 60_000
  });
  let page;
  let hermesContentsId = null;

  const projectRequest = async (operation, payload) => {
    if (!hermesContentsId) throw new Error('Hermes embedded WebContents is unavailable');
    return application.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id);
      if (!contents || contents.isDestroyed()) throw new Error('Hermes embedded WebContents was destroyed');
      const expression = `(() => fetch(${JSON.stringify('/__opc_nexus/project/')}${' + '}${JSON.stringify(input.operation)}, {
        method: ${JSON.stringify(input.hasPayload ? 'POST' : 'GET')},
        credentials: 'include',
        ${input.hasPayload ? `headers: {'content-type':'application/json'}, body: ${JSON.stringify(JSON.stringify(input.payload))},` : ''}
      }).then(async response => ({ status: response.status, body: await response.json() })))()`;
      return contents.executeJavaScript(expression, true);
    }, { id: hermesContentsId, operation, payload, hasPayload: payload !== undefined });
  };

  try {
    page = await application.firstWindow({ timeout: 60_000 });
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(safeText(`console: ${message.text()}`));
    });
    page.on('pageerror', (error) => report.consoleErrors.push(safeText(`page: ${error.message}`)));
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });
    await page.setViewportSize({ width: 1440, height: 940 });

    await application.evaluate(({ dialog }, selectedDirectory) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options && Array.isArray(options.properties) && options.properties.includes('openDirectory')) {
          return { canceled: false, filePaths: [selectedDirectory] };
        }
        return original(...args);
      };
    }, workspace);

    await step('启用调试日志', async () => {
      const status = await page.evaluate(() => window.aibox.setDebugMode(true));
      if (!status.enabled || !status.currentFile) throw new Error('Debug log did not become active');
      return status;
    });

    const provider = await step('读取当前安全 Provider', async () => {
      const providers = await page.evaluate(() => window.aibox.listProviders());
      const selected = providers.find((item) => item.isDefault && item.hasKey)
        || providers.find((item) => item.hasKey);
      if (!selected) throw new Error('No Provider with a safeStorage credential is configured');
      if (!/^https:\/\/api\.quya\.org(?:\/|$)/i.test(selected.baseUrl)) {
        throw new Error(`Current Provider is not api.quya.org: ${selected.baseUrl}`);
      }
      const view = {
        id: selected.id,
        name: selected.name,
        baseUrl: selected.baseUrl,
        model: selected.model,
        hasKey: selected.hasKey,
        isDefault: selected.isDefault
      };
      assertSecretFree(view, 'Provider renderer view');
      report.provider = view;
      return view;
    });

    const advertisedModels = await step('读取上游模型列表', async () => {
      const result = await page.evaluate((providerId) => window.aibox.fetchProviderModels(providerId), provider.id);
      if (!result.ok) throw new Error(result.error || 'Provider model listing failed');
      if (result.models.length === 0) throw new Error('Provider advertised no models');
      return result.models;
    });

    const acceptanceModel = await step('选择 CLI 真实验收模型', async () => {
      const requested = String(process.env.AIBOX_ACCEPTANCE_MODEL || '').trim();
      const preferred = requested || 'qwen3.6-max-preview';
      const selectedModel = advertisedModels.includes(preferred)
        ? preferred
        : advertisedModels.includes(provider.model)
          ? provider.model
          : null;
      if (!selectedModel) {
        throw new Error(`Neither preferred nor configured model is advertised: ${preferred}, ${provider.model}`);
      }
      if (selectedModel !== provider.model) {
        await page.evaluate(({ providerId, model }) => window.aibox.updateProvider(providerId, { model }), {
          providerId: provider.id,
          model: selectedModel
        });
        provider.model = selectedModel;
        report.provider.model = selectedModel;
      }
      return { count: advertisedModels.length, requested: preferred, selected: selectedModel };
    });

    await step('检测本机 Codex CLI 与 Claude Code', async () => {
      const engines = await page.evaluate(() => window.aibox.detectEngines());
      const selected = engines.filter((item) => item.id === 'eng-codex' || item.id === 'eng-claude');
      if (selected.length !== 2 || selected.some((item) => item.status === 'NOT_INSTALLED')) {
        throw new Error(`CLI runtime is missing: ${JSON.stringify(selected)}`);
      }
      return selected.map((item) => ({ id: item.id, name: item.name, version: item.version, path: item.path, status: item.status }));
    });

    const engineSpecs = [
      {
        id: 'eng-codex', name: 'Codex CLI', protocol: 'openai-responses',
        model: acceptanceModel.selected,
        agentName: 'Codex 验收工程师', artifact: 'deliverables/codex-worker.txt'
      },
      {
        id: 'eng-claude', name: 'Claude Code', protocol: 'anthropic-messages',
        model: String(process.env.AIBOX_ACCEPTANCE_CLAUDE_MODEL || acceptanceModel.selected).trim(),
        agentName: 'Claude 验收工程师', artifact: 'deliverables/claude-worker.txt'
      }
    ];
    const readySpecs = [];
    for (const spec of engineSpecs) {
      const configured = await step(`${spec.name} 绑定当前 Provider`, async () => {
        await page.evaluate(({ engineId, providerId, model, protocol }) => window.aibox.saveEngineConfig(engineId, {
          runArgs: [],
          env: {},
          maxConcurrency: 1,
          providerMode: 'managed',
          providerId,
          modelOverride: model,
          protocol
        }), { engineId: spec.id, providerId: provider.id, model: spec.model, protocol: spec.protocol });
        const config = await page.evaluate((engineId) => window.aibox.getEngineConfig(engineId), spec.id);
        if (!config || config.providerMode !== 'managed' || config.providerId !== provider.id
          || config.modelOverride !== spec.model || config.protocol !== spec.protocol) {
          throw new Error(`Managed Provider binding did not persist: ${JSON.stringify(config)}`);
        }
        assertSecretFree(config, `${spec.name} renderer config`);
        return config;
      }, false);
      if (!configured) continue;

      const probe = await step(`${spec.name} 真实受管模型探测`, async () => {
        const result = await page.evaluate((engineId) => window.aibox.authEngine(engineId), spec.id);
        if (!result.ok) throw new Error(result.message);
        return result;
      }, false);
      if (probe) readySpecs.push(spec);
    }

    const workers = [];
    for (const spec of readySpecs) {
      const agent = await step(`创建 ${spec.name} 独立数字员工`, async () => page.evaluate((input) => window.aibox.createAgent(input), {
        name: spec.agentName,
        role: `${spec.name} 真实文件执行`,
        systemPrompt: '只执行收到的真实项目任务。必须实际写入要求的文件，不能虚构完成。',
        engineId: spec.id,
        workspace: '',
        permissionMode: 'standard',
        memoryMode: 'short_term',
        concurrencyLimit: 1,
        channelIds: []
      }));
      workers.push({ ...spec, agent });
    }

    if (workers.length > 0) {
      const project = await step('创建 CLI 委派验收项目', async () => page.evaluate(() => window.aibox.createProject({
        name: 'Hermes CLI 调度验收',
        objective: '验证 Hermes 使用同一 Provider 调度 Codex CLI 与 Claude Code',
        description: '隔离验收项目，产物必须由真实 CLI 员工写入。',
        status: 'active',
        workspaceMode: 'custom'
      })));

      await step('限制 Hermes 仅使用本轮 CLI 员工', async () => page.evaluate(({ projectId, workerAgentIds, model }) => (
        window.aibox.saveQuestSettings(projectId, {
          mode: 'quest',
          orchestrator: 'hermes',
          sandbox: 'workspace',
          permissionMode: 'standard',
          model,
          workerAgentIds,
          pluginIds: [],
          maxParallel: 2,
          autoApproveLowRisk: false
        })
      ), { projectId: project.id, workerAgentIds: workers.map((item) => item.agent.id), model: provider.model }));

      const bounds = await application.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
        if (!host) throw new Error('Main window is unavailable');
        const [width, height] = host.getContentSize();
        return { x: 8, y: 8, width: Math.max(320, width - 16), height: Math.max(240, height - 16) };
      });
      const startupStartedAt = Date.now();
      const embedded = await step('打开分阶段 Hermes Workbench', async () => {
        const value = await page.evaluate(({ projectId, bounds: nextBounds }) => window.aibox.openEmbeddedHermesWorkbench({
          projectId,
          bounds: nextBounds,
          theme: 'dark'
        }), { projectId: project.id, bounds });
        if (!value.attached || !value.runtime?.proxyPort) {
          throw new Error(value.runtime?.lastError || 'Hermes Web UI did not attach');
        }
        return value;
      });
      const dashboardReadyMs = Date.now() - startupStartedAt;
      const healthy = await step('等待 Hermes 执行 Gateway 就绪', async () => waitFor(async () => {
        const status = await page.evaluate((projectId) => window.aibox.getHermesRuntimeStatus(projectId), project.id);
        if (status.state === 'error') throw new Error(status.lastError || 'Hermes startup failed');
        return status.state === 'healthy' ? status : null;
      }, 90_000, 'Hermes Gateway health'));
      report.startup = {
        dashboardReadyMs,
        gatewayReadyMs: Date.now() - startupStartedAt,
        startupPhase: healthy.startupPhase,
        startupElapsedMs: healthy.startupElapsedMs
      };

      hermesContentsId = await step('定位嵌入 Hermes WebContents', async () => waitFor(async () => (
        application.evaluate(({ webContents }, port) => {
          const found = webContents.getAllWebContents().find((contents) => {
            try { return new URL(contents.getURL()).port === String(port); } catch { return false; }
          });
          return found?.id || null;
        }, embedded.runtime.proxyPort)
      ), 20_000, 'Hermes WebContents'));

      for (const worker of workers) {
        const workerEvidence = await step(`Hermes @${worker.agent.name} 调度 ${worker.name}`, async () => {
          const conversation = await page.evaluate(({ projectId, employeeId }) => (
            window.aibox.createHermesProjectConversation(projectId, employeeId)
          ), { projectId: project.id, employeeId: worker.agent.id });
          const before = await page.evaluate(() => window.aibox.getSnapshot());
          const beforeIds = new Set(before.tasks.map((task) => task.id));
          const response = await projectRequest('chat-turn', {
            conversationId: conversation.conversationId,
            message: [
              `@${worker.agent.name} 请调用 nexus_delegate_task，把任务真实派给员工 ${worker.agent.id}。`,
              `任务：使用当前 ${worker.name} 在项目目录创建 ${worker.artifact}。`,
              `文件内容必须包含 engine=${worker.id}、model=${worker.model} 和 status=real-execution。`,
              `expectedArtifacts 必须精确为 [\"${worker.artifact}\"]。`,
              '不要由 Hermes 自己写文件，不要虚构任务或完成状态。'
            ].join('\n')
          });
          if (response.status !== 200 || !response.body?.ok) {
            throw new Error(response.body?.error || `${worker.name} Hermes dispatch failed (${response.status})`);
          }
          const task = await waitFor(async () => {
            const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
            return snapshot.tasks.find((item) => !beforeIds.has(item.id)
              && item.projectId === project.id && item.agentId === worker.agent.id) || null;
          }, 90_000, `${worker.name} delegated task creation`);
          const terminal = await waitFor(async () => {
            const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
            const current = snapshot.tasks.find((item) => item.id === task.id);
            for (const approval of snapshot.approvals.filter((item) => item.taskId === task.id && item.status === 'pending')) {
              await page.evaluate((approvalId) => window.aibox.decideApproval(approvalId, true), approval.id);
            }
            return current && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(current.status)
              ? current
              : null;
          }, 360_000, `${worker.name} task completion`);
          if (terminal.status !== 'COMPLETED') {
            throw new Error(`${worker.name} ended as ${terminal.status}: ${terminal.error || ''}`);
          }
          const target = path.join(workspace, ...worker.artifact.split('/'));
          if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
            throw new Error(`${worker.name} completed without ${worker.artifact}`);
          }
          const content = fs.readFileSync(target, 'utf8');
          if (!content.includes(`engine=${worker.id}`) || !content.includes(`model=${worker.model}`)
            || !content.includes('status=real-execution')) {
            throw new Error(`${worker.name} artifact content is incomplete: ${safeText(content)}`);
          }
          const events = await page.evaluate((taskId) => window.aibox.getTaskEvents(taskId), terminal.id);
          const result = await page.evaluate((taskId) => window.aibox.getTaskResult(taskId), terminal.id);
          assertSecretFree({ events, result, content }, `${worker.name} evidence`);
          if (!terminal.sessionId) throw new Error(`${worker.name} did not persist a CLI session anchor`);
          let resumeEvidence = null;
          if (worker.id === 'eng-codex') {
            const resumeArtifact = 'deliverables/codex-resume.txt';
            const followUp = await page.evaluate(({ taskId, instruction }) => (
              window.aibox.createFollowUpTask(taskId, instruction)
            ), {
              taskId: terminal.id,
              instruction: [
                `在同一项目工作区继续创建 ${resumeArtifact}。`,
                `文件内容必须包含 parent-session=${terminal.sessionId} 和 status=resume-real-execution。`,
                '必须实际写入并读回验证，不能只回复文本。'
              ].join('\n')
            });
            const resumed = await waitFor(async () => {
              const snapshot = await page.evaluate(() => window.aibox.getSnapshot());
              const current = snapshot.tasks.find((item) => item.id === followUp.id);
              for (const approval of snapshot.approvals.filter((item) => item.taskId === followUp.id && item.status === 'pending')) {
                await page.evaluate((approvalId) => window.aibox.decideApproval(approvalId, true), approval.id);
              }
              return current && ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(current.status)
                ? current
                : null;
            }, 360_000, 'Codex resume task completion');
            if (resumed.status !== 'COMPLETED') {
              throw new Error(`Codex resume ended as ${resumed.status}: ${resumed.error || ''}`);
            }
            if (resumed.sessionId !== terminal.sessionId) {
              throw new Error(`Codex resume changed session anchor: ${terminal.sessionId} -> ${resumed.sessionId}`);
            }
            const resumeTarget = path.join(workspace, ...resumeArtifact.split('/'));
            if (!fs.existsSync(resumeTarget) || fs.statSync(resumeTarget).size === 0) {
              throw new Error(`Codex resume completed without ${resumeArtifact}`);
            }
            const resumeContent = fs.readFileSync(resumeTarget, 'utf8');
            if (!resumeContent.includes(`parent-session=${terminal.sessionId}`)
              || !resumeContent.includes('status=resume-real-execution')) {
              throw new Error(`Codex resume artifact content is incomplete: ${safeText(resumeContent)}`);
            }
            const codexProfiles = path.join(userData, 'aibox-data', 'codex', 'profiles');
            const rolloutText = fs.existsSync(codexProfiles)
              ? fs.readdirSync(codexProfiles, { recursive: true })
                .filter((entry) => typeof entry === 'string' && entry.endsWith('.jsonl'))
                .map((entry) => fs.readFileSync(path.join(codexProfiles, entry), 'utf8'))
                .join('\n')
              : '';
            if (/multi_agent_v\d+__spawn_agent|"source":\{"subagent"/.test(rolloutText)) {
              throw new Error('Managed Codex worker started an ungoverned native sub-agent');
            }
            resumeEvidence = {
              taskId: resumed.id,
              taskStatus: resumed.status,
              sessionId: resumed.sessionId,
              artifact: resumeTarget,
              content: resumeContent
            };
          }
          return {
            engineId: worker.id,
            agentId: worker.agent.id,
            conversationId: conversation.conversationId,
            taskId: terminal.id,
            taskStatus: terminal.status,
            sessionId: terminal.sessionId,
            artifact: target,
            content,
            hermesReply: response.body.result?.content,
            eventCount: events.length,
            result,
            resume: resumeEvidence
          };
        }, false);
        report.workers.push({
          engineId: worker.id,
          agentId: worker.agent.id,
          status: workerEvidence ? 'PASS' : 'FAIL',
          ...(workerEvidence ? { evidence: serializable(workerEvidence) } : {})
        });
      }

      await step('CLI 引擎日志保持脱敏', async () => {
        const logs = {};
        for (const worker of workers) {
          logs[worker.id] = await page.evaluate((engineId) => window.aibox.getEngineLogs(engineId), worker.id);
        }
        assertSecretFree(logs, 'CLI engine logs');
        return Object.fromEntries(Object.entries(logs).map(([engineId, entries]) => [engineId, entries.length]));
      });

      const png = await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (!contents) throw new Error('Hermes WebContents is unavailable for screenshot');
        return (await contents.capturePage()).toPNG().toString('base64');
      }, hermesContentsId);
      fs.writeFileSync(screenshotPath, Buffer.from(png, 'base64'));
    }

    if (report.consoleErrors.length > 0) {
      throw new Error(`Renderer produced ${report.consoleErrors.length} console error(s)`);
    }
    if (readySpecs.length !== engineSpecs.length || report.workers.length !== engineSpecs.length
      || report.workers.some((item) => item.status !== 'PASS')) {
      report.result = 'BLOCKED_PROVIDER_OR_ENGINE';
    } else {
      report.result = 'PASS';
    }
  } finally {
    try { await application.close(); } catch { /* best effort cleanup */ }
    report.generatedAt = new Date().toISOString();
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(serializable(report), null, 2)}\n`, 'utf8');
  }

  console.log(`[Hermes CLI workers] ${report.result}`);
  console.log(`[Hermes CLI workers] report=${reportPath}`);
  if (report.startup) {
    console.log(`[Hermes CLI workers] dashboard=${report.startup.dashboardReadyMs}ms gateway=${report.startup.gatewayReadyMs}ms`);
  }
  for (const worker of report.workers) {
    console.log(`[Hermes CLI workers] ${worker.engineId}=${worker.status}`);
  }
  if (report.result !== 'PASS') process.exitCode = 2;
}

main().catch((error) => {
  report.result = 'FAIL';
  report.steps.push({ name: 'fatal', status: 'FAIL', error: safeText(error instanceof Error ? error.message : error) });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(serializable(report), null, 2)}\n`, 'utf8');
  console.error(`[Hermes CLI workers] ${safeText(error instanceof Error ? error.stack || error.message : error)}`);
  console.error(`[Hermes CLI workers] report=${reportPath}`);
  process.exitCode = 1;
});

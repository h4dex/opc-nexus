/**
 * 本地 Web 管理服务器：支持局域网远程访问，用于工控机无人值守场景。
 * - 复用 renderer 构建产物作为前端页面（与桌面端完全一致的 UI）
 * - REST API 镜像关键 IPC 通道（供应商/员工/渠道/引擎/设置）
 * - 简单 Token 认证（Bearer token，可在设置页配置，默认 aibox-admin）
 * - 监听 0.0.0.0:PORT（默认 3210，可配置）
 * - 主进程启动时自动开启，与桌面窗口并行运行
 */
import express from 'express';
import cors from 'cors';
import { join } from 'node:path';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { EngineManager } from './engineManager.js';
import type { ChannelManager } from './channelManager.js';
import type { ProviderManager } from './providerManager.js';
import type { McpManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';
import type { TeamEngine } from './teamEngine.js';
import { getProviderConfig, saveProviderConfig } from './provider.js';
import { loadConfig, saveConfig } from './config.js';

export interface WebServerDeps {
  db: Database;
  orchestrator: Orchestrator;
  engines: EngineManager;
  channels: ChannelManager;
  providers: ProviderManager;
  mcp: McpManager;
  skills: SkillManager;
  teams: TeamEngine;
}

const DEFAULT_PORT = 28889;
const DEFAULT_TOKEN = 'aibox-admin';

export class WebServer {
  private app: ReturnType<typeof express> | null = null;
  private server: ReturnType<ReturnType<typeof express>['listen']> | null = null;

  constructor(private deps: WebServerDeps) {}

  get port(): number {
    return this.deps.db.getSetting<number>('webPort', DEFAULT_PORT);
  }

  get token(): string {
    return this.deps.db.getSetting<string>('webToken', DEFAULT_TOKEN);
  }

  start() {
    const { db, orchestrator, engines, channels, providers, mcp, skills, teams } = this.deps;
    const app = express();
    this.app = app;

    app.use(cors());
    app.use(express.json());

    // Token 认证中间件（静态资源和健康检查免认证）
    app.use((req, res, next) => {
      if (req.path === '/api/health' || req.path.startsWith('/assets/') || req.path === '/' || req.path === '/index.html') {
        return next();
      }
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.token}`) {
        return res.status(401).json({ error: '未授权：请提供有效的 Access Token' });
      }
      next();
    });

    // 静态文件：复用 renderer 构建产物
    const rendererDir = join(__dirname, '../renderer');
    app.use(express.static(rendererDir));
    app.get('{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(join(rendererDir, 'index.html'));
    });

    // ---------- REST API ----------

    // 健康检查（免认证）
    app.get('/api/health', (_req, res) => {
      res.json({ ok: true, version: '1.0.0', agents: orchestrator.listAgents().length });
    });

    // 快照（完整状态）
    app.get('/api/snapshot', (_req, res) => {
      res.json({
        agents: orchestrator.agentCards(),
        tasks: orchestrator.listTasks(),
        engines: engines.list(),
        channels: channels.list(),
        approvals: orchestrator.listApprovals()
      });
    });

    // 供应商管理
    app.get('/api/providers', (_req, res) => res.json(providers.list()));
    app.post('/api/providers', (req, res) => {
      const p = providers.create(req.body);
      res.json(p);
    });
    app.put('/api/providers/:id', (req, res) => {
      providers.update(req.params.id, req.body);
      res.json({ ok: true });
    });
    app.delete('/api/providers/:id', (req, res) => {
      providers.remove(req.params.id);
      res.json({ ok: true });
    });

    // 旧版供应商配置（兼容）
    app.get('/api/provider', (_req, res) => res.json(getProviderConfig(db)));
    app.post('/api/provider', (req, res) => {
      saveProviderConfig(db, req.body);
      res.json({ ok: true });
    });

    // 数字员工管理
    app.get('/api/agents', (_req, res) => res.json(orchestrator.listAgents()));
    app.post('/api/agents', (req, res) => {
      const a = orchestrator.createAgent(req.body);
      res.json(a);
    });
    app.put('/api/agents/:id/persona', (req, res) => {
      const a = orchestrator.updateAgentPersona(req.params.id, req.body);
      res.json(a);
    });
    app.post('/api/agents/:id/start', (req, res) => {
      orchestrator.startAgent(req.params.id);
      res.json({ ok: true });
    });
    app.post('/api/agents/:id/stop', (req, res) => {
      orchestrator.stopAgent(req.params.id);
      res.json({ ok: true });
    });

    // 任务
    app.get('/api/tasks', (_req, res) => res.json(orchestrator.listTasks()));
    app.post('/api/tasks', (req, res) => {
      const t = orchestrator.createTask(req.body.agentId, req.body.title);
      res.json(t);
    });
    app.post('/api/tasks/:id/cancel', (req, res) => {
      orchestrator.cancelTask(req.params.id);
      res.json({ ok: true });
    });
    app.post('/api/approvals/:id/decide', (req, res) => {
      orchestrator.decideApproval(req.params.id, req.body.approve === true);
      res.json({ ok: true });
    });

    // 引擎
    app.get('/api/engines', (_req, res) => res.json(engines.list()));
    app.post('/api/engines/detect', async (_req, res) => {
      const list = await engines.detect();
      res.json(list);
    });

    // 渠道
    app.get('/api/channels', (_req, res) => res.json(channels.list()));

    // MCP
    app.get('/api/mcp', (_req, res) => res.json(mcp.list()));
    app.post('/api/mcp', (req, res) => res.json(mcp.create(req.body)));
    app.delete('/api/mcp/:id', (req, res) => { mcp.remove(req.params.id); res.json({ ok: true }); });

    // Skills
    app.get('/api/skills', (_req, res) => res.json(skills.list()));
    app.post('/api/skills', (req, res) => res.json(skills.create(req.body)));
    app.delete('/api/skills/:id', (req, res) => { skills.remove(req.params.id); res.json({ ok: true }); });

    // 专家团
    app.get('/api/teams', (_req, res) => res.json(teams.list()));
    app.post('/api/teams', (req, res) => res.json(teams.create(req.body)));
    app.post('/api/teams/:id/trigger', (req, res) => res.json(teams.trigger(req.params.id, req.body.task)));

    // 应用配置
    app.get('/api/config', (_req, res) => res.json(loadConfig()));
    app.put('/api/config', (req, res) => res.json(saveConfig(req.body)));

    // 设置
    app.get('/api/settings/:key', (req, res) => res.json({ value: db.getSetting(req.params.key, null) }));
    app.put('/api/settings/:key', (req, res) => {
      db.setSetting(req.params.key, req.body.value);
      res.json({ ok: true });
    });

    // 启动监听
    const port = this.port;
    this.server = app.listen(port, '0.0.0.0', () => {
      console.log(`[WebServer] 管理面板已启动: http://0.0.0.0:${port} (Token: ${this.token})`);
    });
  }

  stop() {
    this.server?.close();
    this.server = null;
  }
}

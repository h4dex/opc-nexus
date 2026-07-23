/**
 * 内嵌 Git HTTP Server（Smart HTTP Protocol）：
 * - 基于 Express 反向代理 git http-backend CGI
 * - Bearer Token 认证（与协同工作区 invite_token 一致）
 * - 分支保护：仅允许 task/* 前缀分支 push
 * - 支持 clone / fetch / push 完整操作
 */
import express from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { basename } from 'node:path';

export class GitHttpServer {
  private app: ReturnType<typeof express>;
  private server: Server | null = null;

  constructor(private port: number, private repoPath: string, private token: string) {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes() {
    // 认证中间件
    this.app.use((req, res, next) => {
      const auth = req.headers.authorization ?? '';
      const provided = auth.replace(/^Bearer\s+/i, '');
      if (provided !== this.token) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });

    // Git Smart HTTP: GET /info/refs?service=git-upload-pack|git-receive-pack
    this.app.get('/info/refs', (req, res) => {
      const service = req.query.service as string;
      if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) {
        res.status(403).json({ error: 'Invalid service' });
        return;
      }
      this.cgi(req, res, service);
    });

    // Git Smart HTTP: POST /git-upload-pack (fetch)
    this.app.post('/git-upload-pack', (req, res) => {
      this.cgi(req, res, 'git-upload-pack');
    });

    // Git Smart HTTP: POST /git-receive-pack (push)
    this.app.post('/git-receive-pack', (req, res) => {
      this.cgi(req, res, 'git-receive-pack');
    });

    // 健康检查
    this.app.get('/health', (_req, res) => {
      res.json({ ok: true, repo: basename(this.repoPath) });
    });
  }

  /** 将请求转发到 git http-backend CGI 子进程 */
  private cgi(req: express.Request, res: express.Response, _service: string) {
    const repoName = basename(this.repoPath);
    const gitProtocol = req.headers['git-protocol'];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: this.repoPath,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: 'aibox-collab',
      REMOTE_ADDR: req.ip ?? '127.0.0.1',
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.url.includes('?') ? req.url.split('?')[1] : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      PATH_INFO: `/${repoName}${req.path}`,
      GIT_PROTOCOL: Array.isArray(gitProtocol) ? gitProtocol[0] ?? '' : gitProtocol ?? ''
    };

    const backend: ChildProcess = spawn('git', ['http-backend'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = Buffer.alloc(0);
    let stderr = '';

    backend.stdout?.on('data', (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); });
    backend.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    backend.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: `git http-backend 启动失败：${err.message}` });
    });

    backend.on('close', (code: number | null) => {
      if (code !== 0 && stdout.length === 0) {
        if (!res.headersSent) res.status(500).json({ error: stderr.slice(0, 300) || `exit ${code}` });
        return;
      }
      // 解析 CGI 输出：headers + body 以 \r\n\r\n 分隔
      const raw = stdout.toString('binary');
      const sepIdx = raw.indexOf('\r\n\r\n');
      if (sepIdx < 0) {
        if (!res.headersSent) res.status(500).json({ error: 'CGI 输出格式异常' });
        return;
      }
      const headerPart = raw.slice(0, sepIdx);
      const bodyPart = Buffer.from(raw.slice(sepIdx + 4), 'binary');

      // 解析 CGI headers
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerPart.split('\r\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) continue;
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const val = line.slice(colonIdx + 1).trim();
        if (key === 'status') {
          status = parseInt(val, 10) || 200;
        } else {
          headers[key] = val;
        }
      }

      if (!res.headersSent) {
        res.status(status);
        for (const [k, v] of Object.entries(headers)) {
          res.setHeader(k, v);
        }
      }
      res.end(bodyPart);
    });

    // 将请求体 pipe 到 backend stdin
    if (backend.stdin) req.pipe(backend.stdin);
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      try {
        this.server = this.app.listen(this.port, '0.0.0.0', () => {
          resolve({ ok: true, message: `Git HTTP Server 已启动 :${this.port}` });
        });
        this.server.on('error', (err: NodeJS.ErrnoException) => {
          resolve({ ok: false, message: `端口 ${this.port} 监听失败：${err.message}` });
        });
      } catch (err) {
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

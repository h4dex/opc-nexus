/**
 * Web 管理面板安全边界测试
 *
 * 这是唯一对外暴露的网络入口(可选局域网),鉴权一旦绕过等于交出整个控制台
 * (可派发任务、改供应商、读设置)。此前零覆盖。
 *
 * 重点覆盖实测确认过的绕过面:裸 socket 发送 `GET /assets/../api/snapshot`
 * 时 req.path 不被规范化,`startsWith('/assets/')` 会误判为公开资源而放行鉴权。
 * 用真实 HTTP 服务 + net.Socket 复现(fetch 会在客户端提前规范化,测不出来)。
 *
 * @author liyingjie <y@senke.com>
 */
// @ts-nocheck
/* eslint-disable */
import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

const { isPublicPath } = await import('../src/main/services/webServer.js');

describe('免认证路径判定（规范化后）', () => {
  it('放行真正的公开路径', () => {
    for (const p of ['/', '/index.html', '/api/health', '/api/login', '/assets/app.js']) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('拦截受保护的 API', () => {
    for (const p of ['/api/snapshot', '/api/agents', '/api/settings/webToken', '/api/providers']) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('路径穿越不再被误判为公开资源（核心修复）', () => {
    for (const p of [
      '/assets/../api/snapshot',
      '/assets/../../api/agents',
      '/assets/./../api/providers',
      '/assets/a/b/../../../api/snapshot'
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('编码穿越同样被拦截', () => {
    for (const p of [
      '/assets/%2e%2e/api/snapshot',
      '/assets/..%2fapi%2fsnapshot',
      '/%2e%2e/api/agents'
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('反斜杠变体被拦截（Windows 路径分隔符）', () => {
    expect(isPublicPath('/assets/..\\api\\snapshot')).toBe(false);
  });

  it('大小写不同的 health 不放行（避免大小写绕过引入歧义）', () => {
    expect(isPublicPath('/API/HEALTH')).toBe(false);
  });

  it('冗余斜杠与点段被正确规范化', () => {
    expect(isPublicPath('//api//health')).toBe(true);
    expect(isPublicPath('/./api/health')).toBe(true);
    expect(isPublicPath('/api/./snapshot')).toBe(false);
  });

  it('非法百分号编码不抛异常且按不公开处理', () => {
    expect(() => isPublicPath('/assets/%zz')).not.toThrow();
    expect(isPublicPath('/api/%zz')).toBe(false);
  });
});

describe('裸 socket 绕过复现（真实 HTTP 层）', () => {
  /** 用规范化判定搭一个最小鉴权服务，验证裸 socket 请求确实被拦 */
  function serve(authGate: (path: string) => boolean) {
    const app = express();
    const seen: { path: string; authorized: boolean }[] = [];
    app.use((req, res, next) => {
      const authorized = authGate(req.path);
      seen.push({ path: req.path, authorized });
      if (authorized) return next();
      return res.status(401).json({ error: 'unauthorized' });
    });
    app.get('/api/snapshot', (_q, r) => r.json({ secret: 'LEAKED' }));
    return { app, seen };
  }

  /** 发送不经客户端规范化的原始请求行 */
  function rawGet(port: number, rawPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      c.on('data', (d) => { buf += d.toString(); });
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
  }

  it('修复后的判定拦住穿越请求，且不泄露数据', async () => {
    const { app } = serve(isPublicPath);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await rawGet(server.address().port, '/assets/../api/snapshot');
      expect(res).toContain('401');
      expect(res).not.toContain('LEAKED');
    } finally {
      server.close();
    }
  });

  it('旧的 startsWith 判定确实会放行穿越请求（回归锚点）', async () => {
    // 复刻修复前的逻辑，证明这个测试有鉴别力
    const legacy = (p: string) =>
      p === '/api/health' || p === '/api/login' || p.startsWith('/assets/') || p === '/' || p === '/index.html';
    const { app, seen } = serve(legacy);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      await rawGet(server.address().port, '/assets/../api/snapshot');
      // 关键：旧逻辑把它当成公开资源放过了鉴权
      expect(seen[0].path).toBe('/assets/../api/snapshot');
      expect(seen[0].authorized).toBe(true);
    } finally {
      server.close();
    }
  });

  it('正常公开路径仍可访问', async () => {
    const app = express();
    app.use((req, res, next) => (isPublicPath(req.path) ? next() : res.status(401).end()));
    app.get('/api/health', (_q, r) => r.json({ ok: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await rawGet(server.address().port, '/api/health');
      expect(res).toContain('200');
      expect(res).toContain('"ok":true');
    } finally {
      server.close();
    }
  });
});

describe('Token 定长比较', () => {
  // webServer 内部 safeEqual 未导出，此处验证其依赖的性质：
  // 长度不同直接判否，长度相同走 timingSafeEqual
  const safeEqual = (a: string, b: string) => {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  };

  it('相同 Token 通过', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('不同 Token 拒绝', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('长度不同拒绝且不抛异常（timingSafeEqual 对不等长会抛）', () => {
    expect(() => safeEqual('short', 'muchlongertoken')).not.toThrow();
    expect(safeEqual('short', 'muchlongertoken')).toBe(false);
  });

  it('空 Token 不匹配非空 Token', () => {
    expect(safeEqual('', 'realtoken')).toBe(false);
  });

  it('前缀相同但不完整的 Token 被拒绝', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});

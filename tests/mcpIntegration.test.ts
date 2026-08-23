import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

import { McpManager } from '../src/main/services/mcpManager.js';
import { mcpToolsForAgent } from '../src/main/services/executor/mcpTools.js';
import { seedMcpServers } from '../src/main/services/seed.js';

const capabilities = { network: false, shell: false, install: false, browser: true, computer: false };

describe('MCP dynamic Agent tools', () => {
  const discovered = [
    { name: 'browser_snapshot', description: 'snapshot', inputSchema: { type: 'object' }, serverId: 'mcp-browser', serverName: 'Browser', capability: 'browser' as const },
    { name: 'browser_click', description: 'click', inputSchema: { type: 'object' }, serverId: 'mcp-browser', serverName: 'Browser', capability: 'browser' as const },
    { name: 'browser_submit', description: 'submit', inputSchema: { type: 'object' }, serverId: 'mcp-browser', serverName: 'Browser', capability: 'browser' as const }
  ];

  it('only exposes read-only MCP tools to a readonly employee', async () => {
    const manager = {
      toolsForAgent: vi.fn().mockResolvedValue(discovered),
      callToolForAgent: vi.fn()
    } as unknown as McpManager;

    const tools = await mcpToolsForAgent(manager, 'agent-1', capabilities, 'readonly');
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toContain('snapshot');
    expect(tools[0].risk).toBe('safe');
  });

  it('namespaces tools and routes execution through the guarded manager method', async () => {
    const callToolForAgent = vi.fn().mockResolvedValue('done');
    const manager = {
      toolsForAgent: vi.fn().mockResolvedValue(discovered),
      callToolForAgent
    } as unknown as McpManager;

    const tools = await mcpToolsForAgent(manager, 'agent-1', capabilities, 'standard');
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.every((tool) => tool.name.startsWith('mcp_mcp_browser_') && tool.name.length <= 64)).toBe(true);

    await tools.find((tool) => tool.description.includes('click'))!.execute(
      { ref: 'e1' },
      { workspace: 'C:\\work', agentId: 'agent-1', taskId: 'task-1', host: null }
    );
    expect(callToolForAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', taskId: 'task-1', serverId: 'mcp-browser', toolName: 'browser_click'
    }));
  });

  it('treats browser mutations as dangerous when their side effect is unknown', async () => {
    const manager = {
      toolsForAgent: vi.fn().mockResolvedValue(discovered),
      callToolForAgent: vi.fn()
    } as unknown as McpManager;

    const tools = await mcpToolsForAgent(manager, 'agent-1', capabilities, 'trusted');
    expect(tools.find((tool) => tool.description.includes('click'))?.risk).toBe('danger');
    expect(tools.find((tool) => tool.description.includes('submit'))?.risk).toBe('danger');
  });
});

interface Row {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: number;
  scope: string;
  capability: string;
}

function managerFixture() {
  const rows = new Map<string, Row>();
  const settings = new Map<string, string>();
  const agents = new Map([['agent-1', { id: 'agent-1', archived: 0, capabilities_json: JSON.stringify(capabilities) }]]);
  const audit = vi.fn();
  const db = {
    raw: {
      prepare: (sql: string) => ({
        all: () => /FROM mcp_servers/.test(sql) ? [...rows.values()] : [],
        get: (id: string) => {
          if (/SELECT id FROM agents/.test(sql)) return agents.get(id)?.archived === 0 ? { id } : undefined;
          if (/SELECT capabilities_json FROM agents/.test(sql)) return agents.get(id);
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (/INSERT INTO mcp_servers/.test(sql)) {
            const [id, name, command, argv, env, scope, capability] = args as string[];
            rows.set(id, { id, name, command, args: argv, env, enabled: 1, scope, capability });
          } else if (/UPDATE mcp_servers SET enabled/.test(sql)) {
            const [enabled, id] = args as [number, string];
            const row = rows.get(id);
            if (row) row.enabled = enabled;
          } else if (/DELETE FROM mcp_servers/.test(sql)) {
            rows.delete(args[0] as string);
          } else if (/DELETE FROM settings/.test(sql)) {
            settings.delete(args[0] as string);
          }
          return { changes: 1 };
        }
      })
    },
    getSetting: <T>(key: string, fallback: T): T => settings.has(key) ? settings.get(key) as T : fallback,
    setSetting: (key: string, value: string) => settings.set(key, value),
    audit
  };
  return { manager: new McpManager(db as never), rows, settings, agents, audit };
}

describe('MCP scope and browser credential guards', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('encrypts the Playwright extension token and persists only a placeholder', () => {
    const { manager, rows, settings } = managerFixture();
    const server = manager.createPlaywrightBrowser({ agentId: 'agent-1', extensionToken: 'browser-secret' });
    const row = rows.get(server.id)!;

    expect(JSON.parse(row.env)).toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: '***' });
    expect(settings.get(`secret:mcp:${server.id}:env`)).not.toContain('browser-secret');
    expect(server.hasSecrets).toBe(true);
  });

  it('reuses the employee browser server and replaces its encrypted token', () => {
    const { manager, rows, settings } = managerFixture();
    const first = manager.createPlaywrightBrowser({ agentId: 'agent-1', extensionToken: 'first-token' });
    const second = manager.createPlaywrightBrowser({ agentId: 'agent-1', extensionToken: 'second-token' });

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    const encrypted = settings.get(`secret:mcp:${first.id}:env`)!;
    expect(encrypted).not.toContain('first-token');
    expect(encrypted).not.toContain('second-token');
    const decrypted = Buffer.from(encrypted, 'base64').toString().replace('enc:', '');
    expect(JSON.parse(decrypted)).toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'second-token' });
  });

  it('re-checks scope and the current browser capability before every tool call', async () => {
    const { manager, agents } = managerFixture();
    const server = manager.create({ name: 'Browser', command: 'node', scope: 'agent-1', capability: 'browser' });
    vi.spyOn(manager, 'callTool').mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } });

    await expect(manager.callToolForAgent({
      agentId: 'agent-1', taskId: 'task-1', serverId: server.id, toolName: 'browser_snapshot', args: {}, capabilities
    })).resolves.toBe('ok');

    agents.get('agent-1')!.capabilities_json = JSON.stringify({ ...capabilities, browser: false });
    await expect(manager.callToolForAgent({
      agentId: 'agent-1', taskId: 'task-2', serverId: server.id, toolName: 'browser_click', args: {}, capabilities
    })).rejects.toThrow('未开启浏览器权限');

    await expect(manager.callToolForAgent({
      agentId: 'agent-2', taskId: 'task-3', serverId: server.id, toolName: 'browser_click', args: {}, capabilities
    })).rejects.toThrow('无权使用');
  });

  it('does not auto-start configured MCP servers during Agent tool discovery', async () => {
    const { manager } = managerFixture();
    manager.create({ name: 'Configured only', command: 'node', scope: 'agent-1' });
    const start = vi.spyOn(manager, 'start');

    await expect(manager.toolsForAgent('agent-1', capabilities)).resolves.toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('MCP seed capabilities', () => {
  it('does not create enabled placeholder MCP servers on a new install', () => {
    const inserted: unknown[][] = [];
    const removed: unknown[][] = [];
    const db = {
      raw: {
        prepare: (sql: string) => ({
          get: () => ({ c: 0 }),
          run: (...args: unknown[]) => {
            if (/INSERT INTO mcp_servers/.test(sql)) inserted.push(args);
            if (/DELETE FROM mcp_servers/.test(sql)) removed.push(args);
            return { changes: 0 };
          }
        })
      },
      transaction: (fn: () => void) => fn()
    };

    seedMcpServers(db as never);
    expect(inserted).toEqual([]);
    expect(removed.length).toBeGreaterThan(0);
  });
});

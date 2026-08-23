import { randomUUID } from 'node:crypto';
import type { HermesProjectPluginView } from '../../shared/types.js';
import type { Database } from './database.js';
import type { McpManager } from './mcpManager.js';
import type { ProjectWorkbenchService } from './projectWorkbench.js';
import type { SkillManager } from './skillManager.js';

export class HermesProjectPluginBridge {
  constructor(
    private readonly db: Database,
    private readonly workbench: Pick<ProjectWorkbenchService, 'getSettings'>,
    private readonly mcp: McpManager,
    private readonly skills: SkillManager
  ) {}

  list(projectId: string): HermesProjectPluginView[] {
    const selected = new Set(this.workbench.getSettings(projectId).pluginIds);
    const skillViews: HermesProjectPluginView[] = this.skills.list()
      .filter((skill) => selected.has(`skill:${skill.id}`))
      .map((skill) => ({
        id: `skill:${skill.id}`,
        name: skill.name,
        kind: 'skill',
        status: skill.enabled ? 'ready' : 'blocked',
        tools: []
      }));
    const tools = this.mcp.allTools();
    const mcpViews: HermesProjectPluginView[] = this.mcp.list()
      .filter((server) => selected.has(`mcp:${server.id}`))
      .map((server) => ({
        id: `mcp:${server.id}`,
        name: server.name,
        kind: 'mcp',
        status: server.enabled && server.running && server.scope === 'global' ? 'ready' : 'blocked',
        tools: tools.filter((tool) => tool.serverId === server.id).map((tool) => ({
          name: tool.name,
          description: tool.description
        }))
      }));
    return [...skillViews, ...mcpViews];
  }

  systemMessage(projectId: string): string {
    return [
      'OPC-Nexus project plugin policy:',
      '- Only plugins with status ready below are callable.',
      '- Skills are synchronized into the project Hermes skills directory.',
      '- Call a selected MCP tool only through nexus_mcp_call; a blocked entry is not available.',
      JSON.stringify(this.list(projectId), null, 2)
    ].join('\n');
  }

  async call(projectId: string, value: unknown): Promise<{ ok: true; result: unknown }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes MCP request is invalid');
    const input = value as Record<string, unknown>;
    const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : '';
    const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : '';
    const args = input.args;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serverId)
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(toolName)
      || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Hermes MCP request fields are invalid');
    }
    const plugin = this.list(projectId).find((entry) => entry.id === `mcp:${serverId}`);
    if (!plugin || plugin.status !== 'ready' || !plugin.tools.some((tool) => tool.name === toolName)) {
      throw new Error('Hermes MCP tool is not selected, running, global, or available for this project');
    }
    const response = await this.mcp.callTool(serverId, toolName, args as Record<string, unknown>);
    this.db.audit({
      id: randomUUID(), actor: 'hermes', action: 'hermes.mcp.call',
      target: `${projectId}:${serverId}:${toolName}`,
      result: response.ok ? 'ok' : `error:${response.error ?? 'unknown'}`,
      source: 'hermes'
    });
    if (!response.ok) throw new Error(response.error ?? 'Hermes MCP tool call failed');
    return { ok: true, result: response.result };
  }
}

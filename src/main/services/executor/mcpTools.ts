import { createHash } from 'node:crypto';
import type { AgentCapabilities, PermissionMode } from '../../../shared/types.js';
import type { McpManager, McpTool } from '../mcpManager.js';
import type { ToolContext, ToolDef, ToolRisk } from './tools.js';

const SAFE_TOOL = /(^|_)(get|list|read|snapshot|screenshot|wait|inspect|query|search|observe)(_|$)/i;
const DANGER_TOOL = /(^|_)(delete|remove|purchase|checkout|submit|send|publish|install|uninstall|evaluate|execute)(_|$)/i;

function toolRisk(tool: McpTool): ToolRisk {
  if (DANGER_TOOL.test(tool.name)) return 'danger';
  if (SAFE_TOOL.test(tool.name)) return 'safe';
  // Browser mutations can submit data or trigger account-side effects; the tool name
  // alone cannot distinguish a harmless click from a purchase or deletion.
  if (tool.capability === 'browser') return 'danger';
  return 'write';
}

function exposedName(tool: McpTool): string {
  const server = tool.serverId.replace(/[^a-zA-Z0-9_]/g, '_');
  const name = tool.name.replace(/[^a-zA-Z0-9_]/g, '_');
  const hash = createHash('sha256').update(tool.name).digest('hex').slice(0, 8);
  return `mcp_${server}_${hash}_${name}`.slice(0, 64);
}

/** Convert the MCP discovery result into the same guarded tool surface as built-in tools. */
export async function mcpToolsForAgent(
  manager: McpManager | null,
  agentId: string,
  capabilities: AgentCapabilities,
  permissionMode: PermissionMode
): Promise<ToolDef[]> {
  if (!manager) return [];
  const tools = await manager.toolsForAgent(agentId, capabilities);
  return tools.map<ToolDef>((tool) => ({
    name: exposedName(tool),
    description: `[MCP: ${tool.serverName}] ${tool.description || tool.name}`,
    risk: toolRisk(tool),
    requiresCapability: tool.capability || undefined,
    inputSchema: tool.inputSchema,
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
      return manager.callToolForAgent({
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        serverId: tool.serverId,
        toolName: tool.name,
        args,
        capabilities
      });
    }
  })).filter((tool) => permissionMode !== 'readonly' || tool.risk === 'safe');
}

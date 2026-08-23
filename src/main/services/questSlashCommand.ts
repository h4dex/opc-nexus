import type { HermesEmployeeView, HermesProjectPluginView } from '../../shared/types.js';

export type QuestExecutionMode = 'auto' | 'plan' | 'execute' | 'research';

export type QuestSlashCommand =
  | { kind: 'mode'; mode: QuestExecutionMode; task: string }
  | { kind: 'agent'; target: string; task: string }
  | { kind: 'skill'; target: string; task: string }
  | { kind: 'mcp'; target: string; task: string };

export interface QuestSlashCommandContext {
  employees: readonly HermesEmployeeView[];
  plugins: readonly HermesProjectPluginView[];
}

export interface ResolvedQuestSlashCommand {
  command: QuestSlashCommand;
  turnMessage: string;
  systemDirective: string;
  auditTarget: string;
}

const MODES = new Set<QuestExecutionMode>(['auto', 'plan', 'execute', 'research']);
const SERVER_COMMANDS = new Set(['mode', 'plan', 'execute', 'research', 'agent', 'skill', 'mcp']);
const CLIENT_COMMANDS = new Set(['help', 'new']);
const MAX_TARGET_LENGTH = 256;

function commandError(message: string): never {
  throw new Error(`Quest 命令无效：${message}`);
}

function requireTask(command: string, value: string | undefined): string {
  const task = value?.trim() ?? '';
  if (!task) commandError(`/${command} 后还需要任务描述`);
  return task;
}

function targetAndTask(command: string, value: string | undefined): { target: string; task: string } {
  const rest = value?.trim() ?? '';
  if (!rest) commandError(`/${command} 后还需要目标和任务描述`);

  let target = '';
  let cursor = 0;
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null;
  if (quote) {
    cursor = 1;
    let closed = false;
    while (cursor < rest.length) {
      const character = rest[cursor]!;
      if (character === '\\') {
        const escaped = rest[cursor + 1];
        if (escaped === undefined) commandError(`/${command} 的目标引号未闭合`);
        target += escaped;
        cursor += 2;
        continue;
      }
      if (character === quote) {
        cursor += 1;
        closed = true;
        break;
      }
      target += character;
      cursor += 1;
    }
    if (!closed) commandError(`/${command} 的目标引号未闭合`);
    if (cursor < rest.length && !/\s/u.test(rest[cursor]!)) {
      commandError(`/${command} 的目标后必须用空格分隔任务描述`);
    }
  } else {
    const separator = rest.search(/\s/u);
    if (separator < 0) {
      target = rest;
      cursor = rest.length;
    } else {
      target = rest.slice(0, separator);
      cursor = separator;
    }
  }

  target = target.trim();
  if (!target || target.length > MAX_TARGET_LENGTH || /[\u0000-\u001f\u007f]/u.test(target)) {
    commandError(`/${command} 的目标无效`);
  }
  return { target, task: requireTask(command, rest.slice(cursor)) };
}

/** Parse only host-governed Quest commands. Plain messages return null. */
export function parseQuestSlashCommand(message: string): QuestSlashCommand | null {
  const input = message.trim();
  if (!input.startsWith('/')) return null;
  if (input === '/') commandError('请输入完整命令，例如 /plan 创建官网');

  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/u.exec(input);
  if (!match) commandError('命令格式不正确');
  const name = match[1]!.toLowerCase();
  const rest = match[2];
  if (CLIENT_COMMANDS.has(name)) {
    commandError(`/${name} 是界面命令，请在 Quest 对话框中直接使用`);
  }
  if (!SERVER_COMMANDS.has(name)) commandError(`不支持 /${name}`);

  if (name === 'plan' || name === 'execute' || name === 'research') {
    return { kind: 'mode', mode: name, task: requireTask(name, rest) };
  }
  if (name === 'mode') {
    const parsed = targetAndTask(name, rest);
    const mode = parsed.target.toLowerCase() as QuestExecutionMode;
    if (!MODES.has(mode)) commandError('/mode 只支持 auto、plan、execute 或 research');
    return { kind: 'mode', mode, task: parsed.task };
  }
  const parsed = targetAndTask(name, rest);
  return { kind: name as 'agent' | 'skill' | 'mcp', ...parsed };
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function uniqueMatch<T>(items: readonly T[], description: string, matches: (item: T) => boolean): T {
  const selected = items.filter(matches);
  if (selected.length === 0) commandError(`${description}未在当前项目授权或不可用`);
  if (selected.length > 1) commandError(`${description}名称不唯一，请改用 ID`);
  return selected[0]!;
}

function pluginAliases(plugin: HermesProjectPluginView): string[] {
  const prefix = `${plugin.kind}:`;
  return [plugin.id, plugin.id.startsWith(prefix) ? plugin.id.slice(prefix.length) : plugin.id, plugin.name]
    .map(normalized);
}

function resolvePlugin(
  command: 'skill' | 'mcp',
  reference: string,
  plugins: readonly HermesProjectPluginView[]
): HermesProjectPluginView {
  const target = normalized(reference);
  const plugin = uniqueMatch(
    plugins.filter((item) => item.kind === command),
    `${command === 'skill' ? '技能' : 'MCP'} ${reference} `,
    (item) => pluginAliases(item).includes(target)
  );
  if (plugin.status !== 'ready') commandError(`${command === 'skill' ? '技能' : 'MCP'} ${reference} 当前不可用`);
  return plugin;
}

/** Resolve project-scoped identities after parsing; UI input is never authority. */
export function resolveQuestSlashCommand(
  command: QuestSlashCommand,
  context: QuestSlashCommandContext
): ResolvedQuestSlashCommand {
  if (command.kind === 'mode') {
    return {
      command,
      turnMessage: command.task,
      systemDirective: `Quest command selected execution mode: ${command.mode}. Follow this mode for the current turn and state the mode in progress updates.`,
      auditTarget: `mode:${command.mode}`
    };
  }

  if (command.kind === 'agent') {
    const target = normalized(command.target);
    const employee = uniqueMatch(
      context.employees,
      `数字员工 ${command.target} `,
      (item) => normalized(item.id) === target || normalized(item.name) === target
    );
    return {
      command,
      turnMessage: `@${employee.name} ${command.task}`,
      systemDirective: `The owner explicitly selected employee ${employee.id} (${employee.name}) through a Quest slash command. Delegate to that exact employee and do not substitute another worker.`,
      auditTarget: `agent:${employee.id}`
    };
  }

  if (command.kind === 'skill') {
    const plugin = resolvePlugin('skill', command.target, context.plugins);
    return {
      command,
      turnMessage: command.task,
      systemDirective: `The owner explicitly invoked the ready project skill ${plugin.id} (${plugin.name}). Apply its real synchronized skill context to this turn; do not claim it was used when unavailable.`,
      auditTarget: plugin.id
    };
  }

  const separator = command.target.indexOf('/');
  const serverReference = separator < 0 ? command.target : command.target.slice(0, separator);
  const requestedTool = separator < 0 ? '' : command.target.slice(separator + 1);
  if (!serverReference || (separator >= 0 && !requestedTool)) commandError(`/mcp 的目标必须是 server 或 server/tool`);
  const plugin = resolvePlugin('mcp', serverReference, context.plugins);
  if (plugin.tools.length === 0) commandError(`MCP ${serverReference} 没有可调用的真实工具`);
  const tool = requestedTool
    ? uniqueMatch(plugin.tools, `MCP 工具 ${command.target} `, (item) => item.name === requestedTool)
    : null;
  const availableTools = plugin.tools.map((item) => item.name).join(', ');
  return {
    command,
    turnMessage: command.task,
    systemDirective: tool
      ? `The owner explicitly requested the ready MCP tool ${plugin.id}/${tool.name}. Call that exact tool through the governed nexus_mcp_call bridge; never simulate its result.`
      : `The owner explicitly selected the ready MCP server ${plugin.id}. Choose only from its real tools (${availableTools}) and call the chosen tool through the governed nexus_mcp_call bridge; never simulate its result.`,
    auditTarget: tool ? `${plugin.id}/${tool.name}` : plugin.id
  };
}

import { randomUUID } from 'node:crypto';
import type { AgentMemoryMode, HermesEmployeeView } from '../../shared/types.js';
import type { Database } from './database.js';
import type { ProjectWorkbenchService } from './projectWorkbench.js';

interface AgentRow {
  id: string;
  name: string;
  role: string;
  engine_id: string;
  memory_mode: string;
}

export interface ResolvedAgentMentions {
  employees: HermesEmployeeView[];
  mentioned: HermesEmployeeView[];
  systemMessage: string;
}

function memoryMode(value: string): AgentMemoryMode {
  return value === 'long_term' || value === 'none' ? value : 'short_term';
}

function mentionBoundary(message: string, end: number): boolean {
  const next = message[end];
  return next === undefined || /[\s,，。.!！?？:：;；、)）\]}】]/u.test(next);
}

/** Resolves @mentions against the project-scoped employee policy in Main. */
export class AgentMentionResolver {
  constructor(
    private readonly db: Database,
    private readonly workbench: Pick<ProjectWorkbenchService, 'getWorkerSelection'>
  ) {}

  listEligible(projectId: string): HermesEmployeeView[] {
    const project = this.db.raw.prepare(`
      SELECT id, organization_id FROM projects
      WHERE id = ? AND status <> 'archived'
    `).get(projectId) as { id?: string; organization_id?: string } | undefined;
    if (project?.id !== projectId || !project.organization_id) {
      throw new Error('Hermes project is unavailable');
    }
    const rows = this.db.raw.prepare(`
      SELECT id, name, role, engine_id, memory_mode
      FROM agents
      WHERE organization_id = ? AND archived = 0 AND lifecycle = 'READY'
      ORDER BY length(name) DESC, created_at, id
    `).all(project.organization_id) as unknown as AgentRow[];
    const selection = this.workbench.getWorkerSelection(projectId);
    const restricted = new Set(selection.workerAgentIds);
    return rows
      .filter((row) => selection.mode !== 'restricted' || restricted.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        engineId: row.engine_id,
        memoryMode: memoryMode(row.memory_mode)
      }));
  }

  resolve(projectId: string, message: string): ResolvedAgentMentions {
    const employees = this.listEligible(projectId);
    const byLongestName = [...employees].sort((left, right) => right.name.length - left.name.length);
    const mentioned = new Map<string, HermesEmployeeView>();
    const unknown: string[] = [];
    for (let index = 0; index < message.length; index += 1) {
      if (message[index] !== '@') continue;
      const previous = message[index - 1];
      if (previous !== undefined && !/[\s(（[【{]/u.test(previous)) continue;
      const remaining = message.slice(index + 1);
      const match = byLongestName.find((employee) => (
        remaining.startsWith(employee.name) && mentionBoundary(message, index + 1 + employee.name.length)
      ));
      if (match) {
        mentioned.set(match.id, match);
        index += match.name.length;
        continue;
      }
      const candidate = remaining.match(/^[^\s,，。.!！?？:：;；、)）\]}】]{1,80}/u)?.[0];
      if (candidate) unknown.push(candidate);
    }
    if (unknown.length > 0) {
      throw new Error(`无法使用未授权或不可用的数字员工：${[...new Set(unknown)].join('、')}`);
    }
    const selected = [...mentioned.values()];
    if (selected.length > 0) {
      this.db.audit({
        id: randomUUID(),
        actor: 'principal-local-admin',
        action: 'hermes.employee.mention',
        target: projectId,
        result: selected.map((employee) => employee.id).join(','),
        source: 'hermes'
      });
    }
    const systemMessage = [
      'OPC-Nexus host policy for this turn:',
      '- Only employees listed below exist and are authorized for this project.',
      '- An explicit @mention must be honored by calling nexus_delegate_task with the exact employee id.',
      '- You may choose an unmentioned employee only when their role and capabilities fit the task.',
      '- Do not claim employee execution until nexus_delegate_task returns a real task receipt.',
      JSON.stringify({ employees, explicitMentions: selected }, null, 2)
    ].join('\n');
    return { employees, mentioned: selected, systemMessage };
  }
}

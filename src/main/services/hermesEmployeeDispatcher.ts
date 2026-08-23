import { createHash, randomUUID } from 'node:crypto';
import type { HermesEmployeeTaskIntent, Task, TaskStatus } from '../../shared/types.js';
import type { Database } from './database.js';
import type { Orchestrator } from './orchestrator.js';
import type { ProjectWorkbenchService } from './projectWorkbench.js';

export interface HermesEmployeeTaskRequest {
  requestId: string;
  hermesSessionId: string;
  workerAgentId: string;
  title: string;
  description: string;
  intent: HermesEmployeeTaskIntent;
  relatedTaskIds: string[];
  expectedArtifacts: string[];
}

export interface HermesEmployeeTaskReceipt {
  intent: HermesEmployeeTaskIntent;
  task: Pick<Task, 'id' | 'agentId' | 'projectId' | 'title' | 'status'>;
  deduplicated: boolean;
}

export interface HermesEmployeeTaskStatusReceipt {
  task: Pick<Task, 'id' | 'agentId' | 'projectId' | 'title' | 'status' | 'progress' | 'stage'> & {
    intent: HermesEmployeeTaskIntent;
    terminal: boolean;
    result: string | null;
    failureReason: string | null;
    validationVerdict: 'PASS' | 'FAIL' | 'BLOCKED' | null;
    requiresArtifacts: boolean;
  };
}

const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;
const TERMINAL_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const TASK_INTENTS = new Set<HermesEmployeeTaskIntent>(['execution', 'status_inquiry', 'validation']);

function taskIntent(content: unknown): HermesEmployeeTaskIntent {
  if (typeof content !== 'string') return 'execution';
  const match = /^Task intent: (execution|status_inquiry|validation)$/m.exec(content);
  return match?.[1] as HermesEmployeeTaskIntent | undefined ?? 'execution';
}

function validationVerdict(
  intent: HermesEmployeeTaskIntent,
  status: TaskStatus,
  result: unknown
): 'PASS' | 'FAIL' | 'BLOCKED' | null {
  if (intent !== 'validation' || !TERMINAL_STATUSES.has(status)) return null;
  if (status !== 'COMPLETED' || typeof result !== 'string') return 'BLOCKED';
  const match = /^\s*(?:\*\*(PASS|FAIL|BLOCKED)\*\*|__(PASS|FAIL|BLOCKED)__|`(PASS|FAIL|BLOCKED)`|(PASS|FAIL|BLOCKED))(?=$|[\s:：.,，。;；!?！？])/i.exec(result);
  const verdict = match?.slice(1).find(Boolean);
  return verdict ? verdict.toUpperCase() as 'PASS' | 'FAIL' | 'BLOCKED' : 'BLOCKED';
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000\r]/.test(value)) {
    throw new Error(`Hermes employee task ${field} is invalid`);
  }
  return value.trim();
}

function relativeArtifact(value: unknown): string {
  const path = boundedText(value, 'expected artifact', 4_096).replace(/\\/g, '/');
  if (/^(?:[A-Za-z]:|\/)/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Hermes employee task artifact must be project-relative');
  }
  return path;
}

/** Commits one Hermes-selected employee task through the authoritative Orchestrator. */
export class HermesEmployeeDispatcher {
  constructor(
    private readonly db: Database,
    private readonly orchestrator: Pick<Orchestrator, 'createTask'>,
    private readonly workbench: Pick<ProjectWorkbenchService, 'getWorkerSelection' | 'getExplicitWorkspacePath'>
  ) {}

  private sessionBinding(projectId: string, hermesSessionId: string): {
    conversationId: string;
    principalId: string;
    organizationId: string;
  } {
    const binding = this.db.raw.prepare(`
      SELECT b.conversation_id, c.principal_id, p.organization_id
      FROM hermes_session_bindings b
      JOIN conversations c ON c.id = b.conversation_id AND c.project_id = b.project_id
      JOIN projects p ON p.id = b.project_id AND p.status <> 'archived'
      WHERE b.project_id = ? AND b.hermes_session_id = ?
    `).get(projectId, hermesSessionId) as {
      conversation_id?: string;
      principal_id?: string;
      organization_id?: string;
    } | undefined;
    if (!binding?.conversation_id || !binding.principal_id || !binding.organization_id) {
      throw new Error('Hermes employee task session is not bound to this project');
    }
    return {
      conversationId: binding.conversation_id,
      principalId: binding.principal_id,
      organizationId: binding.organization_id
    };
  }

  dispatch(projectId: string, value: unknown): HermesEmployeeTaskReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Hermes employee task must be an object');
    }
    const input = value as Record<string, unknown>;
    const requestId = boundedText(input.requestId, 'requestId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) {
      throw new Error('Hermes employee task requestId is invalid');
    }
    const hermesSessionId = boundedText(input.hermesSessionId, 'session identity', 256);
    const workerAgentId = boundedText(input.workerAgentId, 'workerAgentId', 128);
    const title = boundedText(input.title, 'title', 500);
    const description = boundedText(input.description, 'description', 32_000);
    const intent = input.intent;
    if (typeof intent !== 'string' || !TASK_INTENTS.has(intent as HermesEmployeeTaskIntent)) {
      throw new Error('Hermes employee task intent is invalid');
    }
    if (!Array.isArray(input.relatedTaskIds) || input.relatedTaskIds.length > 32) {
      throw new Error('Hermes employee task relatedTaskIds are invalid');
    }
    const relatedTaskIds = input.relatedTaskIds.map((value) => boundedText(value, 'relatedTaskId', 128));
    if (!Array.isArray(input.expectedArtifacts) || input.expectedArtifacts.length > 128) {
      throw new Error('Hermes employee task expectedArtifacts are invalid');
    }
    const expectedArtifacts = input.expectedArtifacts.map(relativeArtifact);
    if (intent === 'status_inquiry' && expectedArtifacts.length > 0) {
      throw new Error('Hermes status inquiry cannot require a new artifact');
    }
    if (intent === 'validation' && relatedTaskIds.length === 0) {
      throw new Error('Hermes validation must identify at least one related execution task');
    }
    const binding = this.sessionBinding(projectId, hermesSessionId);
    const relatedWorkerIds = new Set<string>();
    for (const relatedTaskId of relatedTaskIds) {
      const related = this.db.raw.prepare(`
        SELECT id, agent_id, status FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL
      `).get(relatedTaskId, projectId) as { id?: string; agent_id?: string; status?: TaskStatus } | undefined;
      if (related?.id !== relatedTaskId) throw new Error('Hermes related task is outside this project or unavailable');
      if (intent === 'validation' && related.status !== 'COMPLETED') {
        throw new Error('Hermes validation must wait until every related execution task is completed');
      }
      if (related.agent_id) relatedWorkerIds.add(related.agent_id);
    }
    if (intent === 'validation' && relatedWorkerIds.has(workerAgentId)) {
      throw new Error('Hermes validation must be assigned to an independent employee, not an implementation worker');
    }
    const worker = this.db.raw.prepare(`
      SELECT id, engine_id, lifecycle, archived
      FROM agents WHERE id = ? AND organization_id = ?
    `).get(workerAgentId, binding.organizationId) as {
      id?: string;
      engine_id?: string;
      lifecycle?: string;
      archived?: number;
    } | undefined;
    if (worker?.id !== workerAgentId || worker.archived === 1 || worker.lifecycle !== 'READY') {
      throw new Error('Hermes employee task worker is unavailable');
    }
    const selection = this.workbench.getWorkerSelection(projectId);
    if (selection.mode === 'restricted' && !selection.workerAgentIds.includes(workerAgentId)) {
      throw new Error('Hermes employee task worker is outside the project fixed employee pool');
    }
    const workspace = this.workbench.getExplicitWorkspacePath(projectId);
    if (!workspace) throw new Error('Project working directory is not configured');
    const content = [
      `Task intent: ${intent}`,
      description,
      relatedTaskIds.length ? `Related project tasks:\n${relatedTaskIds.join('\n')}` : '',
      intent === 'validation'
        ? [
            'Independently inspect the owner clarification, acceptance criteria, related task results, real files, commands, preview, screenshots, and tests that are available.',
            'When a real http://127.0.0.1:<port>/ preview URL is supplied, first call http_request with GET on that exact URL, then call browser_navigate on the same URL and browser_get_content to inspect the live DOM. Do not guess ports, use :0 or file://, and do not replace these checks with a file-only review.',
            'If the supplied URL is missing, unreachable, or any required inspection tool is unavailable, return BLOCKED instead of claiming PASS.',
            'The first non-whitespace word of your final result must be exactly PASS, FAIL, or BLOCKED.',
            'After that verdict, list the evidence checked, failures, and remaining risks. Do not claim checks you did not perform.'
          ].join('\n')
        : '',
      intent === 'status_inquiry'
        ? 'Return a factual status report in the task result. Do not create a file and do not claim unverified completion.'
        : '',
      expectedArtifacts.length ? `Expected artifacts:\n${expectedArtifacts.join('\n')}` : ''
    ].filter(Boolean).join('\n\n');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      projectId,
      hermesSessionId,
      workerAgentId,
      title,
      intent,
      relatedTaskIds,
      content
    })).digest('hex').slice(0, 40);
    const windowId = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
    const sourceKey = `hermes:${projectId}:${hermesSessionId}:${windowId}:${fingerprint}`;
    const previousSourceKey = `hermes:${projectId}:${hermesSessionId}:${windowId - 1}:${fingerprint}`;
    const existing = this.db.raw.prepare(`
      SELECT id, agent_id, project_id, title, status
      FROM tasks
      WHERE source = 'team' AND source_key IN (?, ?) AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(sourceKey, previousSourceKey) as {
      id?: string;
      agent_id?: string;
      project_id?: string | null;
      title?: string;
      status?: Task['status'];
    } | undefined;
    if (existing?.id && existing.agent_id && existing.project_id && existing.title && existing.status) {
      this.db.audit({
        id: randomUUID(),
        actor: binding.principalId,
        action: 'hermes.employee.dispatch.deduplicated',
        target: existing.id,
        result: `${workerAgentId}:${existing.status}:${requestId}`,
        source: 'hermes'
      });
      return {
        intent: intent as HermesEmployeeTaskIntent,
        task: {
          id: existing.id,
          agentId: existing.agent_id,
          projectId: existing.project_id,
          title: existing.title,
          status: existing.status
        },
        deduplicated: true
      };
    }
    const task = this.orchestrator.createTask(workerAgentId, title, 'team', {
      projectId,
      conversationId: binding.conversationId,
      sourceKey,
      content,
      requiresArtifacts: expectedArtifacts.length > 0,
      workspaceOverride: workspace
    });
    this.db.audit({
      id: randomUUID(),
      actor: binding.principalId,
      action: 'hermes.employee.dispatch',
      target: task.id,
      result: `${intent}:${workerAgentId}:${task.status}`,
      source: 'hermes'
    });
    // Keep the model-facing receipt narrow. In particular, Task.error is null
    // on success but Hermes' generic result detector treats any JSON "error"
    // key as a failure signal.
    return {
      intent: intent as HermesEmployeeTaskIntent,
      task: {
        id: task.id,
        agentId: task.agentId,
        projectId: task.projectId,
        title: task.title,
        status: task.status
      },
      deduplicated: task.deduplicated === true
    };
  }

  async status(projectId: string, value: unknown): Promise<HermesEmployeeTaskStatusReceipt> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Hermes employee status request must be an object');
    }
    const input = value as Record<string, unknown>;
    const requestId = boundedText(input.requestId, 'status requestId', 128);
    const hermesSessionId = boundedText(input.hermesSessionId, 'session identity', 256);
    const taskId = boundedText(input.taskId, 'status taskId', 128);
    const waitSeconds = input.waitSeconds ?? 0;
    if (!Number.isInteger(waitSeconds) || Number(waitSeconds) < 0 || Number(waitSeconds) > 25) {
      throw new Error('Hermes employee status waitSeconds must be an integer from 0 to 25');
    }
    const binding = this.sessionBinding(projectId, hermesSessionId);
    const read = () => this.db.raw.prepare(`
      SELECT id, agent_id, project_id, title, content, status, progress, stage, result, error, artifacts_required
      FROM tasks
      WHERE id = ? AND project_id = ? AND conversation_id = ? AND deleted_at IS NULL
    `).get(taskId, projectId, binding.conversationId) as {
      id?: string;
      agent_id?: string;
      project_id?: string;
      title?: string;
      content?: string;
      status?: TaskStatus;
      progress?: number;
      stage?: string;
      result?: string | null;
      error?: string | null;
      artifacts_required?: number;
    } | undefined;
    let row = read();
    if (!row?.id || !row.agent_id || !row.project_id || !row.title || !row.status) {
      throw new Error('Hermes employee task is outside this project conversation or unavailable');
    }
    const deadline = Date.now() + Number(waitSeconds) * 1_000;
    while (!TERMINAL_STATUSES.has(row.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      row = read();
      if (!row?.id || !row.agent_id || !row.project_id || !row.title || !row.status) {
        throw new Error('Hermes employee task became unavailable');
      }
    }
    const terminal = TERMINAL_STATUSES.has(row.status);
    const intent = taskIntent(row.content);
    const verdict = validationVerdict(intent, row.status, row.result);
    this.db.audit({
      id: randomUUID(),
      actor: binding.principalId,
      action: 'hermes.employee.status',
      target: taskId,
      result: `${row.status}:${requestId}`,
      source: 'hermes'
    });
    if (verdict) {
      this.db.audit({
        id: randomUUID(),
        actor: binding.principalId,
        action: 'hermes.employee.validation.verdict',
        target: taskId,
        result: verdict,
        source: 'hermes'
      });
    }
    return {
      task: {
        id: row.id,
        agentId: row.agent_id,
        projectId: row.project_id,
        title: row.title,
        status: row.status,
        progress: Number(row.progress ?? 0),
        stage: String(row.stage ?? ''),
        intent,
        terminal,
        result: terminal && typeof row.result === 'string' ? row.result.slice(0, 16_000) : null,
        failureReason: terminal && typeof row.error === 'string' ? row.error.slice(0, 4_000) : null,
        validationVerdict: verdict,
        requiresArtifacts: Number(row.artifacts_required ?? 0) === 1
      }
    };
  }
}

/**
 * 测试辅助：模拟 Database 层
 * 使用内存 Map 模拟 sql.js 的 prepare/get/all/run 接口，
 * 仅覆盖 Orchestrator 所需的核心查询。
 */
// @ts-nocheck
/* eslint-disable */

export interface MockDb {
  raw: {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
      run: (...args: unknown[]) => { changes: number };
    };
  };
  transaction: (fn: () => void) => void;
  audit: (entry: unknown) => void;
  getSetting: <T>(key: string, fallback: T) => T;
}

interface Tables {
  projects: Map<string, Record<string, unknown>>;
  agents: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  agent_runs: Map<string, Record<string, unknown>>;
  task_events: Map<string, Record<string, unknown>>;
  approvals: Map<string, Record<string, unknown>>;
  engines: Map<string, Record<string, unknown>>;
  channels: Map<string, Record<string, unknown>>;
  channel_routes: Map<string, Record<string, unknown>>;
  conversations: Map<string, Record<string, unknown>>;
  usage_records: Map<string, Record<string, unknown>>;
  teams: Map<string, Record<string, unknown>>;
  team_runs: Map<string, Record<string, unknown>>;
  deliverables: Map<string, Record<string, unknown>>;
  deliverable_versions: Map<string, Record<string, unknown>>;
  deliverable_reviews: Map<string, Record<string, unknown>>;
  knowledge_entries: Map<string, Record<string, unknown>>;
  knowledge_versions: Map<string, Record<string, unknown>>;
  action_dismissals: Map<string, Record<string, unknown>>;
  schedules: Map<string, Record<string, unknown>>;
  project_budgets: Map<string, Record<string, unknown>>;
  automation_reports: Map<string, Record<string, unknown>>;
  customer_deliveries: Map<string, Record<string, unknown>>;
  audit_logs: Map<string, Record<string, unknown>>;
  settings: Map<string, unknown>;
}

export function createMockDb(): MockDb & { tables: Tables } {
  const tables: Tables = {
    projects: new Map(),
    agents: new Map(),
    tasks: new Map(),
    agent_runs: new Map(),
    task_events: new Map(),
    approvals: new Map(),
    engines: new Map(),
    channels: new Map(),
    channel_routes: new Map(),
    conversations: new Map(),
    usage_records: new Map(),
    teams: new Map(),
    team_runs: new Map(),
    deliverables: new Map(),
    deliverable_versions: new Map(),
    deliverable_reviews: new Map(),
    knowledge_entries: new Map(),
    knowledge_versions: new Map(),
    action_dismissals: new Map(),
    schedules: new Map(),
    project_budgets: new Map(),
    automation_reports: new Map(),
    customer_deliveries: new Map(),
    audit_logs: new Map(),
    settings: new Map()
  };

  const audit = vi.fn();
  const getSetting = <T>(key: string, fallback: T): T => {
    return tables.settings.has(key) ? (tables.settings.get(key) as T) : fallback;
  };

  const raw = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]): unknown => {
        return executeQuery(tables, sql, args, 'get');
      },
      all: (...args: unknown[]): unknown[] => {
        return executeQuery(tables, sql, args, 'all') as unknown[];
      },
      run: (...args: unknown[]) => {
        return executeRun(tables, sql, args);
      }
    })
  };

  return {
    raw,
    transaction: (fn: () => void) => fn(),
    audit,
    getSetting,
    tables
  };
}

/** 简化的 SQL 路由：根据 SQL 语句匹配表和操作 */
function executeQuery(tables: Tables, sql: string, args: unknown[], mode: 'get' | 'all'): unknown | unknown[] {
  const table = detectTable(sql);
  if (!table) return mode === 'get' ? undefined : [];
  const rows = [...tables[table].values()];

  // SELECT * FROM projects ORDER BY updated_at DESC
  if (/SELECT \* FROM projects ORDER BY updated_at DESC/.test(sql)) {
    const result = [...tables.projects.values()].sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT * FROM projects WHERE id = ?
  if (/SELECT \* FROM projects WHERE id = \?/.test(sql)) {
    const row = tables.projects.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  // SELECT id FROM projects WHERE id = ? AND status != 'archived'
  if (/SELECT id FROM projects WHERE id = \?/.test(sql)) {
    const row = tables.projects.get(args[0] as string);
    const result = row && row.status !== 'archived' ? { id: row.id } : undefined;
    return mode === 'get' ? result : result ? [result] : [];
  }

  // SELECT * FROM agents WHERE archived = 0
  if (/SELECT \* FROM agents WHERE archived = 0/.test(sql)) {
    const result = rows.filter(r => (r.archived as number) === 0);
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM agents$/.test(sql)) {
    return [...tables.agents.values()];
  }

  // SELECT * FROM agents WHERE id = ?
  if (/SELECT \* FROM agents WHERE id = \?/.test(sql)) {
    const row = tables.agents.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  // SELECT id FROM agents WHERE name = ? AND archived = 0 AND lifecycle = 'READY'
  if (/SELECT id FROM agents WHERE name = \?/.test(sql)) {
    const found = rows.find(r => r.name === args[0] && r.archived === 0 && r.lifecycle === 'READY');
    return mode === 'get' ? (found ? { id: found.id } : undefined) : found ? [{ id: found.id }] : [];
  }

  // SELECT * FROM tasks WHERE id = ?
  if (/SELECT \* FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    const visible = row && (!/deleted_at IS NULL/.test(sql) || row.deleted_at == null) ? row : undefined;
    return mode === 'get' ? visible : visible ? [visible] : [];
  }

  // SELECT * FROM tasks WHERE status = 'RUNNING' ...
  if (/SELECT \* FROM tasks WHERE status = 'RUNNING'/.test(sql)) {
    const result = rows.filter(r => r.status === 'RUNNING');
    return mode === 'get' ? result[0] : result;
  }

  // 看门狗:SELECT id, agent_id, title, started_at FROM tasks WHERE status = 'RUNNING' AND started_at < ?
  if (/SELECT id, agent_id, title, started_at FROM tasks WHERE status = 'RUNNING'/.test(sql)) {
    const result = [...tables.tasks.values()]
      .filter(r => r.status === 'RUNNING' && r.started_at != null && (r.started_at as number) < (args[0] as number))
      .map(r => ({ id: r.id, agent_id: r.agent_id, title: r.title, started_at: r.started_at }));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT id FROM agents WHERE id = \? AND archived = 0/.test(sql)) {
    const row = tables.agents.get(args[0] as string);
    const result = row && row.archived === 0 ? { id: row.id } : undefined;
    return mode === 'get' ? result : result ? [result] : [];
  }

  if (/SELECT \* FROM tasks WHERE status = 'COMPLETED'/.test(sql)) {
    const result = rows.filter(r => r.status === 'COMPLETED')
      .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT id FROM tasks WHERE status IN ('RUNNING','WAITING_APPROVAL','PAUSED')
  if (/SELECT id FROM tasks WHERE status IN/.test(sql)) {
    const statuses = ['RUNNING', 'WAITING_APPROVAL', 'PAUSED'];
    const result = [...tables.tasks.values()].filter(r => statuses.includes(r.status as string));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT * FROM tasks WHERE status IN (...) ORDER BY created_at DESC
  if (/SELECT \* FROM tasks WHERE status IN \('RUNNING','QUEUED','WAITING_APPROVAL','PAUSED'\)/.test(sql)) {
    const statuses = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'];
    const result = [...tables.tasks.values()].filter(r => statuses.includes(r.status as string));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT * FROM tasks [WHERE deleted_at IS NULL] ORDER BY created_at DESC
  if (/SELECT \* FROM tasks (?:WHERE deleted_at IS NULL )?ORDER BY created_at DESC/.test(sql)) {
    const result = [...tables.tasks.values()]
      .filter((row) => !/deleted_at IS NULL/.test(sql) || row.deleted_at == null)
      .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT * FROM tasks WHERE agent_id = ? AND status = 'QUEUED' ORDER BY created_at LIMIT 1
  if (/SELECT \* FROM tasks WHERE agent_id = \? AND status = 'QUEUED'/.test(sql)) {
    const result = [...tables.tasks.values()]
      .filter(r => r.agent_id === args[0] && r.status === 'QUEUED')
      .sort((a, b) => (a.created_at as number) - (b.created_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT id FROM tasks WHERE agent_id = ? AND status IN (...)
  if (/SELECT id FROM tasks WHERE agent_id = \? AND status IN/.test(sql)) {
    const statuses = ['RUNNING', 'QUEUED', 'PAUSED', 'WAITING_APPROVAL'];
    const result = [...tables.tasks.values()].filter(r => r.agent_id === args[0] && statuses.includes(r.status as string));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT COUNT(*) c FROM tasks WHERE agent_id = ? AND status IN (...)
  if (/SELECT COUNT\(\*\) c FROM tasks WHERE agent_id = \? AND status IN/.test(sql)) {
    const statuses = ['RUNNING', 'WAITING_APPROVAL', 'PAUSED'];
    const count = [...tables.tasks.values()].filter(r => r.agent_id === args[0] && statuses.includes(r.status as string)).length;
    return { c: count };
  }

  // SELECT COUNT(*) c FROM tasks WHERE status IN (...)
  if (/SELECT COUNT\(\*\) c FROM tasks WHERE status IN/.test(sql)) {
    const statuses = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'];
    const count = [...tables.tasks.values()].filter(r => statuses.includes(r.status as string)).length;
    return { c: count };
  }

  // SELECT COUNT(*) c FROM tasks WHERE status = 'COMPLETED' AND ended_at >= ?
  if (/SELECT COUNT\(\*\) c FROM tasks WHERE status = 'COMPLETED'/.test(sql)) {
    const count = [...tables.tasks.values()].filter(r => r.status === 'COMPLETED' && r.deleted_at == null && (r.ended_at as number) >= (args[0] as number)).length;
    return { c: count };
  }

  // SELECT COUNT(*) c FROM approvals WHERE status = 'pending'
  if (/SELECT COUNT\(\*\) c FROM approvals/.test(sql)) {
    const count = [...tables.approvals.values()].filter(r => r.status === 'pending').length;
    return { c: count };
  }

  // SELECT agent_id FROM tasks WHERE id = ?
  if (/SELECT agent_id FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    return mode === 'get' ? (row ? { agent_id: row.agent_id } : undefined) : [];
  }

  // SELECT parent_id FROM tasks WHERE id = ?
  if (/SELECT parent_id FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    return mode === 'get' ? (row ? { parent_id: row.parent_id } : undefined) : [];
  }

  if (/SELECT agent_id, status FROM tasks WHERE id = \? AND deleted_at IS NULL/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    const result = row && row.deleted_at == null ? { agent_id: row.agent_id, status: row.status } : undefined;
    return mode === 'get' ? result : result ? [result] : [];
  }

  if (/SELECT id FROM tasks WHERE parent_id = \? AND deleted_at IS NULL/.test(sql)) {
    const active = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'];
    const result = [...tables.tasks.values()].find((row) => row.parent_id === args[0] && row.deleted_at == null && active.includes(row.status as string));
    return mode === 'get' ? (result ? { id: result.id } : undefined) : result ? [{ id: result.id }] : [];
  }

  // SELECT project_id FROM tasks WHERE id = ?
  if (/SELECT project_id FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    return mode === 'get' ? (row ? { project_id: row.project_id ?? null } : undefined) : [];
  }

  // SELECT title FROM tasks WHERE id = ?
  if (/SELECT title FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    return mode === 'get' ? (row ? { title: row.title } : undefined) : [];
  }

  // SELECT result FROM tasks WHERE id = ?
  if (/SELECT result FROM tasks WHERE id = \?/.test(sql)) {
    const row = tables.tasks.get(args[0] as string);
    return mode === 'get' ? (row ? { result: row.result } : undefined) : [];
  }

  // SELECT name, status FROM engines WHERE id = ?（编码委派就绪探测）
  if (/SELECT name, status FROM engines WHERE id = \?/.test(sql)) {
    const row = tables.engines.get(args[0] as string);
    return mode === 'get' ? (row ? { name: row.name, status: row.status } : undefined) : [];
  }

  // SELECT status FROM engines WHERE id = ?
  if (/SELECT status FROM engines WHERE id = \?/.test(sql)) {
    const row = tables.engines.get(args[0] as string);
    return mode === 'get' ? (row ? { status: row.status } : undefined) : [];
  }

  // SELECT id, name FROM engines
  if (/SELECT id, name FROM engines/.test(sql)) {
    return [...tables.engines.values()].map(e => ({ id: e.id, name: e.name }));
  }

  // SELECT * FROM approvals WHERE status = 'pending'
  if (/SELECT \* FROM approvals WHERE status = 'pending'/.test(sql)) {
    return [...tables.approvals.values()].filter(r => r.status === 'pending');
  }

  // SELECT * FROM approvals WHERE id = ?
  if (/SELECT \* FROM approvals WHERE id = \?/.test(sql)) {
    const row = tables.approvals.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  // SELECT * FROM task_events WHERE task_id = ?
  if (/SELECT \* FROM task_events WHERE task_id = \?/.test(sql)) {
    return [...tables.task_events.values()].filter(r => r.task_id === args[0]);
  }

  // SELECT * FROM team_runs WHERE id = ?
  if (/SELECT \* FROM team_runs WHERE id = \?/.test(sql)) {
    const row = tables.team_runs.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  // SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC [LIMIT 20]
  if (/SELECT \* FROM team_runs WHERE team_id = \? ORDER BY created_at DESC/.test(sql)) {
    const result = [...tables.team_runs.values()]
      .filter(r => r.team_id === args[0])
      .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    const limited = /LIMIT 20/.test(sql) ? result.slice(0, 20) : result;
    return mode === 'get' ? limited[0] : limited;
  }

  if (/SELECT \* FROM team_runs WHERE phase = 'done'/.test(sql)) {
    const result = rows.filter(r => r.phase === 'done')
      .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // SELECT project_id FROM team_runs WHERE id = ?
  if (/SELECT project_id FROM team_runs WHERE id = \?/.test(sql)) {
    const row = tables.team_runs.get(args[0] as string);
    return mode === 'get' ? (row ? { project_id: row.project_id ?? null } : undefined) : [];
  }

  // SELECT id FROM team_runs WHERE phase IN ('clarify','decompose','execute','review')
  if (/SELECT id FROM team_runs WHERE phase IN/.test(sql)) {
    const phases = ['clarify', 'decompose', 'execute', 'review'];
    return [...tables.team_runs.values()].filter(r => phases.includes(r.phase as string)).map(r => ({ id: r.id }));
  }

  // SELECT * FROM teams ORDER BY created_at DESC
  if (/SELECT \* FROM teams ORDER BY created_at DESC/.test(sql)) {
    return [...tables.teams.values()].sort((a, b) => (b.created_at as number) - (a.created_at as number));
  }

  // SELECT * FROM channels WHERE status IN (...)
  if (/SELECT \* FROM channels WHERE status IN/.test(sql)) {
    return [...tables.channels.values()].filter(r => ['ERROR', 'AUTH_EXPIRED'].includes(r.status as string));
  }

  // SELECT name FROM agents WHERE id = ?
  if (/SELECT name FROM agents WHERE id = \?/.test(sql)) {
    const row = tables.agents.get(args[0] as string);
    return mode === 'get' ? (row ? { name: row.name } : undefined) : [];
  }

  // SELECT agent_id, MIN(started_at) AS since FROM agent_runs ...
  if (/SELECT agent_id, MIN\(started_at\) AS since FROM agent_runs/.test(sql)) {
    return [];
  }

  // SELECT c.type, cr.agent_id FROM channel_routes ...
  if (/SELECT c\.type, cr\.agent_id FROM channel_routes/.test(sql)) {
    return [];
  }

  // SELECT agent_id FROM channel_routes WHERE channel_id = ? LIMIT 1（渠道路由/指令）
  if (/SELECT agent_id FROM channel_routes WHERE channel_id = \?/.test(sql)) {
    const row = [...tables.channel_routes.values()].find(r => r.channel_id === args[0]);
    return mode === 'get' ? (row ? { agent_id: row.agent_id } : undefined) : row ? [{ agent_id: row.agent_id }] : [];
  }

  // SELECT id, title, status, progress, stage FROM tasks WHERE agent_id = ? ... status IN（渠道 /状态 指令）
  if (/SELECT id, title, status, progress, stage FROM tasks WHERE agent_id = \?/.test(sql)) {
    const statuses = ['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'PAUSED'];
    const result = [...tables.tasks.values()]
      .filter(r => r.agent_id === args[0] && r.deleted_at == null && statuses.includes(r.status as string))
      .sort((a, b) => (a.created_at as number) - (b.created_at as number))
      .map(r => ({ id: r.id, title: r.title, status: r.status, progress: r.progress, stage: r.stage }));
    return mode === 'get' ? result[0] : result;
  }

  // ---------- 成果验收 ----------
  if (/SELECT \* FROM deliverables ORDER BY updated_at DESC/.test(sql)) {
    const result = [...tables.deliverables.values()]
      .sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM deliverables WHERE source_type = \? AND source_id = \?/.test(sql)) {
    const row = [...tables.deliverables.values()].find(r => r.source_type === args[0] && r.source_id === args[1]);
    return mode === 'get' ? row : row ? [row] : [];
  }

  if (/SELECT \* FROM deliverables WHERE id = \?/.test(sql)) {
    const row = tables.deliverables.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  if (/SELECT \* FROM deliverable_versions ORDER BY deliverable_id, version DESC/.test(sql)) {
    const result = [...tables.deliverable_versions.values()].sort((a, b) =>
      String(a.deliverable_id).localeCompare(String(b.deliverable_id)) || (b.version as number) - (a.version as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM deliverable_versions WHERE deliverable_id = \? ORDER BY version DESC/.test(sql)) {
    const result = [...tables.deliverable_versions.values()].filter(r => r.deliverable_id === args[0])
      .sort((a, b) => (b.version as number) - (a.version as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM deliverable_reviews WHERE deliverable_id = \? ORDER BY created_at DESC, rowid DESC/.test(sql)) {
    const result = [...tables.deliverable_reviews.values()].reverse().filter(r => r.deliverable_id === args[0])
      .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // ---------- 项目知识库 ----------
  if (/SELECT \* FROM knowledge_entries ORDER BY pinned DESC, updated_at DESC/.test(sql)) {
    const result = [...tables.knowledge_entries.values()].sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || (b.updated_at as number) - (a.updated_at as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM knowledge_entries WHERE source_type = \? AND source_id = \?/.test(sql)) {
    const row = [...tables.knowledge_entries.values()].find(r => r.source_type === args[0] && r.source_id === args[1]);
    return mode === 'get' ? row : row ? [row] : [];
  }

  if (/SELECT \* FROM knowledge_entries WHERE id = \?/.test(sql)) {
    const row = tables.knowledge_entries.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }

  if (/SELECT \* FROM knowledge_versions ORDER BY knowledge_id, version DESC/.test(sql)) {
    const result = [...tables.knowledge_versions.values()].sort((a, b) =>
      String(a.knowledge_id).localeCompare(String(b.knowledge_id)) || (b.version as number) - (a.version as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM knowledge_versions WHERE knowledge_id = \? ORDER BY version DESC/.test(sql)) {
    const result = [...tables.knowledge_versions.values()].filter(r => r.knowledge_id === args[0])
      .sort((a, b) => (b.version as number) - (a.version as number));
    return mode === 'get' ? result[0] : result;
  }

  if (/SELECT \* FROM action_dismissals ORDER BY dismissed_at DESC/.test(sql)) {
    const result = [...tables.action_dismissals.values()].sort((a, b) => (b.dismissed_at as number) - (a.dismissed_at as number));
    return mode === 'get' ? result[0] : result;
  }

  // ---------- 经营自动化 / 自动计划 ----------
  if (/SELECT \* FROM schedules WHERE enabled = 1 AND next_run_at <= \?/.test(sql)) {
    const result = [...tables.schedules.values()].filter(row => row.enabled === 1 && Number(row.next_run_at) <= Number(args[0]));
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM schedules ORDER BY next_run_at/.test(sql)) {
    const result = [...tables.schedules.values()].sort((a, b) => Number(a.next_run_at) - Number(b.next_run_at));
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM schedules WHERE id = \?/.test(sql)) {
    const row = tables.schedules.get(args[0] as string);
    return mode === 'get' ? row : row ? [row] : [];
  }
  if (/SELECT id, title, created_at FROM automation_reports WHERE schedule_id = \?/.test(sql)) {
    const result = [...tables.automation_reports.values()].filter(row => row.schedule_id === args[0])
      .sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 20);
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM automation_reports ORDER BY created_at DESC LIMIT 100/.test(sql)) {
    const result = [...tables.automation_reports.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 100);
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM project_budgets/.test(sql)) {
    const result = [...tables.project_budgets.values()];
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM customer_deliveries ORDER BY updated_at DESC/.test(sql)) {
    const result = [...tables.customer_deliveries.values()].sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM usage_records ORDER BY created_at DESC/.test(sql)) {
    const result = [...tables.usage_records.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return mode === 'get' ? result[0] : result;
  }
  if (/SELECT \* FROM audit_logs ORDER BY created_at DESC LIMIT 100/.test(sql)) {
    const result = [...tables.audit_logs.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 100);
    return mode === 'get' ? result[0] : result;
  }

  // Fallback
  return mode === 'get' ? undefined : [];
}

function executeRun(tables: Tables, sql: string, args: unknown[]): { changes: number } {
  if (/INSERT INTO automation_reports/.test(sql)) {
    const [id, scheduleId, projectId, kind, title, periodStart, periodEnd, metricsJson, findingsJson, content, trigger, createdAt] = args;
    tables.automation_reports.set(id as string, { id, schedule_id: scheduleId, project_id: projectId, kind, title,
      period_start: periodStart, period_end: periodEnd, metrics_json: metricsJson, findings_json: findingsJson, content, trigger, created_at: createdAt });
    return { changes: 1 };
  }
  if (/INSERT INTO project_budgets/.test(sql)) {
    const [projectId, tokenLimit, costLimit, warningPercent, updatedAt] = args;
    tables.project_budgets.set(projectId as string, { project_id: projectId, token_limit: tokenLimit, cost_limit: costLimit, warning_percent: warningPercent, updated_at: updatedAt });
    return { changes: 1 };
  }
  if (/INSERT INTO customer_deliveries/.test(sql)) {
    const [id, projectId, customerName, title, deliverableIdsJson, note, createdAt, updatedAt] = args;
    tables.customer_deliveries.set(id as string, { id, project_id: projectId, customer_name: customerName, title, status: 'draft',
      deliverable_ids_json: deliverableIdsJson, note, delivered_at: null, accepted_at: null, created_at: createdAt, updated_at: updatedAt });
    return { changes: 1 };
  }
  if (/UPDATE customer_deliveries SET status = \?/.test(sql)) {
    const [status, deliveredAt, acceptedAt, updatedAt, id] = args;
    const row = tables.customer_deliveries.get(id as string);
    if (!row) return { changes: 0 };
    Object.assign(row, { status, delivered_at: deliveredAt, accepted_at: acceptedAt, updated_at: updatedAt });
    return { changes: 1 };
  }
  if (/INSERT INTO schedules/.test(sql)) {
    const [id, agentId, projectId, automationKind, title, content, cronKind, cronValue, nextRunAt] = args;
    tables.schedules.set(id as string, { id, agent_id: agentId, project_id: projectId, automation_kind: automationKind,
      title, content, cron_kind: cronKind, cron_value: cronValue, enabled: 1, last_run_at: null, next_run_at: nextRunAt });
    return { changes: 1 };
  }
  if (/UPDATE schedules SET last_run_at = \?, next_run_at = \? WHERE id = \?/.test(sql)) {
    const [lastRunAt, nextRunAt, id] = args; const row = tables.schedules.get(id as string);
    if (!row) return { changes: 0 }; row.last_run_at = lastRunAt; row.next_run_at = nextRunAt; return { changes: 1 };
  }
  if (/UPDATE schedules SET enabled = \?, next_run_at = \? WHERE id = \?/.test(sql)) {
    const [enabled, nextRunAt, id] = args; const row = tables.schedules.get(id as string);
    if (!row) return { changes: 0 }; row.enabled = enabled; row.next_run_at = nextRunAt; return { changes: 1 };
  }
  if (/UPDATE schedules SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string; const row = tables.schedules.get(id);
    if (!row) return { changes: 0 };
    const fields = (sql.match(/SET (.+) WHERE/)?.[1] ?? '').split(',').map(field => field.trim().split(' = ')[0]);
    fields.forEach((field, index) => { row[field] = args[index]; }); return { changes: 1 };
  }
  if (/DELETE FROM schedules WHERE id = \?/.test(sql)) return { changes: tables.schedules.delete(args[0] as string) ? 1 : 0 };

  if (/INSERT INTO action_dismissals/.test(sql)) {
    const [actionKey, fingerprint, dismissedAt] = args;
    tables.action_dismissals.set(actionKey as string, {
      action_key: actionKey, fingerprint, dismissed_at: dismissedAt
    });
    return { changes: 1 };
  }

  // INSERT INTO projects
  if (/INSERT INTO projects/.test(sql)) {
    const [id, name, objective, description, clientName, status, color, dueAt, createdAt, updatedAt] = args;
    tables.projects.set(id as string, {
      id, name, objective, description, client_name: clientName, status, color,
      due_at: dueAt, created_at: createdAt, updated_at: updatedAt
    });
    return { changes: 1 };
  }

  // UPDATE projects（通用字段更新）
  if (/UPDATE projects SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string;
    const project = tables.projects.get(id);
    if (!project) return { changes: 0 };
    const setClause = sql.match(/SET (.+) WHERE/)?.[1] ?? '';
    const fields = setClause.split(',').map(f => f.trim().split(' = ')[0]);
    for (let i = 0; i < fields.length; i++) project[fields[i]] = args[i];
    return { changes: 1 };
  }

  // INSERT INTO agents
  if (/INSERT INTO agents/.test(sql)) {
    const [id, name, role, systemPrompt, soulMd, agentsMd, userMd, engineId, workspace, permissionMode, concurrencyLimit, color, now, now2] = args;
    tables.agents.set(id as string, {
      id, name, role, system_prompt: systemPrompt, soul_md: soulMd, agents_md: agentsMd, user_md: userMd,
      lifecycle: 'READY', engine_id: engineId, workspace, permission_mode: permissionMode,
      concurrency_limit: concurrencyLimit, archived: 0, avatar_color: color, created_at: now, updated_at: now2
    });
    return { changes: 1 };
  }

  // INSERT INTO tasks
  if (/INSERT INTO tasks/.test(sql)) {
    const [id, agentId, projectId, title, source, parentId, status, stage, sessionId, workspaceOverride, engineOverride, now, startedAt] = args;
    tables.tasks.set(id as string, {
      id, agent_id: agentId, project_id: projectId, title, source, parent_id: parentId, status,
      priority: 0, progress: 0, stage, error: null, session_id: sessionId,
      workspace_override: workspaceOverride, engine_override: engineOverride ?? null,
      is_demo: 0, created_at: now, started_at: startedAt, ended_at: null, deleted_at: null, result: null, quality: null
    });
    return { changes: 1 };
  }

  // INSERT INTO team_runs
  if (/INSERT INTO team_runs/.test(sql)) {
    const [id, teamId, projectId, taskText, phase, createdAt] = args;
    tables.team_runs.set(id as string, {
      id, team_id: teamId, project_id: projectId, task_text: taskText, phase,
      current_step: 0, total_steps: 0, subtasks_json: '[]', events_json: '[]',
      final_result: null, error: null, created_at: createdAt, ended_at: null
    });
    return { changes: 1 };
  }

  // ---------- 成果验收 ----------
  if (/INSERT INTO deliverables/.test(sql)) {
    const [id, sourceType, sourceId, projectId, ownerType, ownerId, ownerName, ownerRole, title, type, tagsJson,
      reviewStatus, reviewNote, sourceHash, sourceUpdatedAt, createdAt, updatedAt] = args;
    tables.deliverables.set(id as string, {
      id, source_type: sourceType, source_id: sourceId, project_id: projectId, owner_type: ownerType,
      owner_id: ownerId, owner_name: ownerName, owner_role: ownerRole, title, type, tags_json: tagsJson,
      review_status: reviewStatus, review_note: reviewNote, source_hash: sourceHash,
      source_updated_at: sourceUpdatedAt, created_at: createdAt, updated_at: updatedAt
    });
    return { changes: 1 };
  }

  if (/INSERT INTO deliverable_versions/.test(sql)) {
    const [id, deliverableId, version, content, changeNote, origin, createdBy, createdAt] = args;
    tables.deliverable_versions.set(id as string, {
      id, deliverable_id: deliverableId, version, content, change_note: changeNote,
      origin, created_by: createdBy, created_at: createdAt
    });
    return { changes: 1 };
  }

  if (/INSERT INTO deliverable_reviews/.test(sql)) {
    const [id, deliverableId, status, note, reviewer, reworkRef, createdAt] = args;
    tables.deliverable_reviews.set(id as string, {
      id, deliverable_id: deliverableId, status, note, reviewer, rework_ref: reworkRef, created_at: createdAt
    });
    return { changes: 1 };
  }

  if (/UPDATE deliverables SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string;
    const deliverable = tables.deliverables.get(id);
    if (!deliverable) return { changes: 0 };
    const setClause = sql.match(/SET (.+) WHERE/)?.[1] ?? '';
    let argIndex = 0;
    for (const assignment of setClause.split(',').map(value => value.trim())) {
      const [field, rawValue] = assignment.split(' = ').map(value => value.trim());
      if (rawValue === '?') deliverable[field] = args[argIndex++];
      else if (/^'.*'$/.test(rawValue)) deliverable[field] = rawValue.slice(1, -1);
      else if (/^NULL$/i.test(rawValue)) deliverable[field] = null;
    }
    return { changes: 1 };
  }

  // ---------- 项目知识库 ----------
  if (/INSERT INTO knowledge_entries/.test(sql)) {
    const [id, projectId, sourceType, sourceId, title, category, tagsJson, pinned, status,
      sourceUpdatedAt, createdAt, updatedAt] = args;
    tables.knowledge_entries.set(id as string, {
      id, project_id: projectId, source_type: sourceType, source_id: sourceId, title, category,
      tags_json: tagsJson, pinned, status, usage_count: 0, last_used_at: null,
      source_updated_at: sourceUpdatedAt, created_at: createdAt, updated_at: updatedAt
    });
    return { changes: 1 };
  }

  if (/INSERT INTO knowledge_versions/.test(sql)) {
    const [id, knowledgeId, version, content, changeNote, origin, createdBy, createdAt] = args;
    tables.knowledge_versions.set(id as string, {
      id, knowledge_id: knowledgeId, version, content, change_note: changeNote,
      origin, created_by: createdBy, created_at: createdAt
    });
    return { changes: 1 };
  }

  if (/UPDATE knowledge_entries SET usage_count = usage_count \+ 1, last_used_at = \? WHERE id = \?/.test(sql)) {
    const [lastUsedAt, id] = args;
    const entry = tables.knowledge_entries.get(id as string);
    if (!entry) return { changes: 0 };
    entry.usage_count = Number(entry.usage_count) + 1;
    entry.last_used_at = lastUsedAt;
    return { changes: 1 };
  }

  if (/UPDATE knowledge_entries SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string;
    const entry = tables.knowledge_entries.get(id);
    if (!entry) return { changes: 0 };
    const setClause = sql.match(/SET (.+) WHERE/)?.[1] ?? '';
    let argIndex = 0;
    for (const assignment of setClause.split(',').map(value => value.trim())) {
      const [field, rawValue] = assignment.split(' = ').map(value => value.trim());
      if (rawValue === '?') entry[field] = args[argIndex++];
    }
    return { changes: 1 };
  }

  // INSERT INTO agent_runs
  if (/INSERT INTO agent_runs/.test(sql)) {
    const [id, agentId, taskId, pid, sessionId, status, startedAt] = args;
    tables.agent_runs.set(id as string, {
      id, agent_id: agentId, task_id: taskId, pid, session_id: sessionId, status, started_at: startedAt, ended_at: null
    });
    return { changes: 1 };
  }

  // INSERT INTO task_events
  if (/INSERT INTO task_events/.test(sql)) {
    const [id, taskId, eventType, payload, createdAt] = args;
    tables.task_events.set(id as string, {
      id, task_id: taskId, event_type: eventType, payload, created_at: createdAt
    });
    return { changes: 1 };
  }

  // INSERT INTO channel_routes
  if (/INSERT INTO channel_routes/.test(sql)) {
    const [id, channelId, convKey, agentId, policy] = args;
    tables.channel_routes.set(id as string, {
      id, channel_id: channelId, conversation_key: convKey, agent_id: agentId, policy
    });
    return { changes: 1 };
  }

  // INSERT INTO conversations
  if (/INSERT INTO conversations/.test(sql)) {
    const [id, agentId, title, lastMsgAt, msgCount] = args;
    tables.conversations.set(id as string, {
      id, agent_id: agentId, title, last_message_at: lastMsgAt, message_count: msgCount
    });
    return { changes: 1 };
  }

  // UPDATE agents SET lifecycle = 'READY'
  if (/UPDATE agents SET lifecycle = 'READY'/.test(sql)) {
    const [now, id] = args;
    const agent = tables.agents.get(id as string);
    if (agent) { agent.lifecycle = 'READY'; agent.updated_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE agents SET lifecycle = 'DISABLED'
  if (/UPDATE agents SET lifecycle = 'DISABLED'/.test(sql)) {
    const [now, id] = args;
    const agent = tables.agents.get(id as string);
    if (agent) { agent.lifecycle = 'DISABLED'; agent.updated_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE agents SET ... (generic persona update)
  if (/UPDATE agents SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string;
    const agent = tables.agents.get(id);
    if (agent) {
      // Parse field assignments from SQL
      const setClause = sql.match(/SET (.+) WHERE/)?.[1] ?? '';
      const fields = setClause.split(',').map(f => f.trim().split(' = ')[0]);
      for (let i = 0; i < fields.length; i++) {
        (agent as Record<string, unknown>)[fields[i]] = args[i];
      }
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  /** 解析 SQL 里的 `status IN ('A','B')` 守卫；无该子句返回 null 表示不设限 */
  const statusGuard = (s: string): string[] | null => {
    const m = s.match(/status IN \(([^)]+)\)/);
    return m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : null;
  };

  // UPDATE tasks SET status = 'COMPLETED'（可带终态守卫 AND status IN (...)）
  if (/UPDATE tasks SET status = 'COMPLETED'/.test(sql)) {
    const [result, now, id] = args;
    const task = tables.tasks.get(id as string);
    if (!task) return { changes: 0 };
    const guard = statusGuard(sql);
    if (guard && !guard.includes(task.status as string)) return { changes: 0 };
    task.status = 'COMPLETED'; task.progress = 100; task.stage = '完成'; task.result = result; task.ended_at = now;
    return { changes: 1 };
  }

  if (/UPDATE tasks SET quality = \? WHERE id = \?/.test(sql)) {
    const [quality, id] = args;
    const task = tables.tasks.get(id as string);
    if (task) { task.quality = quality; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = ?, error = ?, ended_at = ?（可带终态守卫）
  if (/UPDATE tasks SET status = \?, error = \?, ended_at = \?/.test(sql)) {
    const [status, error, now, id] = args;
    const task = tables.tasks.get(id as string);
    if (!task) return { changes: 0 };
    const guard = statusGuard(sql);
    if (guard && !guard.includes(task.status as string)) return { changes: 0 };
    task.status = status; task.error = error; task.ended_at = now;
    return { changes: 1 };
  }

  // UPDATE tasks SET status = 'CANCELLED'
  if (/UPDATE tasks SET status = 'CANCELLED'/.test(sql)) {
    const [now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task) { task.status = 'CANCELLED'; task.ended_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  if (/UPDATE tasks SET deleted_at = \? WHERE id = \? AND deleted_at IS NULL/.test(sql)) {
    const [deletedAt, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.deleted_at == null) { task.deleted_at = deletedAt; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'PAUSED' WHERE id = ? AND status = 'RUNNING'
  if (/UPDATE tasks SET status = 'PAUSED' WHERE id = \? AND status = 'RUNNING'/.test(sql)) {
    const [id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'RUNNING') { task.status = 'PAUSED'; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'PAUSED'
  if (/UPDATE tasks SET status = 'RUNNING', started_at = \? WHERE id = \? AND status = 'PAUSED'/.test(sql)) {
    const [now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'PAUSED') { task.status = 'RUNNING'; task.started_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'RUNNING', stage = ?, started_at = ?
  if (/UPDATE tasks SET status = 'RUNNING', stage = \?, started_at = \?/.test(sql)) {
    const [stage, now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task) { task.status = 'RUNNING'; task.stage = stage; task.started_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'WAITING_APPROVAL'
  if (/UPDATE tasks SET status = 'RUNNING', started_at = \? WHERE id = \? AND status = 'WAITING_APPROVAL'/.test(sql)) {
    const [now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'WAITING_APPROVAL') { task.status = 'RUNNING'; task.started_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'FAILED' ... WHERE id = ? AND status = 'WAITING_APPROVAL'
  if (/UPDATE tasks SET status = 'FAILED'.+WHERE id = \? AND status = 'WAITING_APPROVAL'/.test(sql)) {
    const [now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'WAITING_APPROVAL') { task.status = 'FAILED'; task.ended_at = now; task.error = '审批被拒绝'; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET stage = ? WHERE id = ? AND status = 'RUNNING'
  if (/UPDATE tasks SET stage = \? WHERE id = \? AND status = 'RUNNING'/.test(sql)) {
    const [stage, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'RUNNING') { task.stage = stage; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET progress = ? WHERE id = ? AND status = 'RUNNING'
  if (/UPDATE tasks SET progress = \? WHERE id = \? AND status = 'RUNNING'/.test(sql)) {
    const [progress, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'RUNNING') { task.progress = progress; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET session_id = ?
  if (/UPDATE tasks SET session_id = \?/.test(sql)) {
    const [sessionId, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.session_id === null) { task.session_id = sessionId; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'INTERRUPTED' ... WHERE id = ? AND status = 'RUNNING'（看门狗,带 error 参数）
  if (/UPDATE tasks SET status = 'INTERRUPTED', ended_at = \?, error = \? WHERE id = \? AND status = 'RUNNING'/.test(sql)) {
    const [now, error, id] = args;
    const task = tables.tasks.get(id as string);
    if (task && task.status === 'RUNNING') { task.status = 'INTERRUPTED'; task.ended_at = now; task.error = error; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE tasks SET status = 'INTERRUPTED'
  if (/UPDATE tasks SET status = 'INTERRUPTED'/.test(sql)) {
    const [now, id] = args;
    const task = tables.tasks.get(id as string);
    if (task) { task.status = 'INTERRUPTED'; task.ended_at = now; task.error = '客户端异常退出，任务中断'; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE agent_runs SET ended_at = ?
  if (/UPDATE agent_runs SET ended_at = \?/.test(sql)) {
    const [now, status, taskId] = args;
    for (const run of tables.agent_runs.values()) {
      if (run.task_id === taskId && run.ended_at === null) {
        run.ended_at = now;
        run.status = status;
        return { changes: 1 };
      }
    }
    return { changes: 0 };
  }

  // UPDATE approvals SET status = ?
  if (/UPDATE approvals SET status = \?/.test(sql)) {
    const [status, now, id] = args;
    const ap = tables.approvals.get(id as string);
    if (ap) { ap.status = status; ap.decided_at = now; return { changes: 1 }; }
    return { changes: 0 };
  }

  if (/UPDATE approvals SET status = 'rejected', decided_at = \? WHERE task_id = \?/.test(sql)) {
    const [now, taskId] = args;
    let changes = 0;
    for (const approval of tables.approvals.values()) {
      if (approval.task_id === taskId && approval.status === 'pending') {
        approval.status = 'rejected'; approval.decided_at = now; changes++;
      }
    }
    return { changes };
  }

  // UPDATE engines SET status = 'AUTH_REQUIRED'
  if (/UPDATE engines SET status = 'AUTH_REQUIRED'/.test(sql)) {
    const [id] = args;
    const engine = tables.engines.get(id as string);
    if (engine) { engine.status = 'AUTH_REQUIRED'; engine.auth_status = 'required'; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE conversations
  if (/UPDATE conversations SET/.test(sql)) {
    return { changes: 1 };
  }

  // UPDATE team_runs SET ... WHERE id = ?（通用字段更新）
  if (/UPDATE team_runs SET .+ WHERE id = \?/.test(sql)) {
    const id = args[args.length - 1] as string;
    const run = tables.team_runs.get(id);
    if (run) {
      const setClause = sql.match(/SET (.+) WHERE/)?.[1] ?? '';
      const fields = setClause.split(',').map(f => f.trim().split(' = ')[0]);
      for (let i = 0; i < fields.length; i++) {
        (run as Record<string, unknown>)[fields[i]] = args[i];
      }
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  return { changes: 0 };
}

function detectTable(sql: string): keyof Tables | null {
  if (/\bprojects\b/.test(sql)) return 'projects';
  if (/\bagents\b/.test(sql) && !/agent_runs/.test(sql)) return 'agents';
  if (/\bagent_runs\b/.test(sql)) return 'agent_runs';
  if (/\btasks\b/.test(sql) && !/task_events/.test(sql)) return 'tasks';
  if (/\btask_events\b/.test(sql)) return 'task_events';
  if (/\bapprovals\b/.test(sql)) return 'approvals';
  if (/\bengines\b/.test(sql)) return 'engines';
  if (/\bchannels\b/.test(sql) && !/channel_routes/.test(sql)) return 'channels';
  if (/\bchannel_routes\b/.test(sql)) return 'channel_routes';
  if (/\bconversations\b/.test(sql)) return 'conversations';
  if (/\busage_records\b/.test(sql)) return 'usage_records';
  if (/\bteam_runs\b/.test(sql)) return 'team_runs';
  if (/\bteams\b/.test(sql)) return 'teams';
  if (/\bdeliverable_versions\b/.test(sql)) return 'deliverable_versions';
  if (/\bdeliverable_reviews\b/.test(sql)) return 'deliverable_reviews';
  if (/\bdeliverables\b/.test(sql)) return 'deliverables';
  if (/\bknowledge_versions\b/.test(sql)) return 'knowledge_versions';
  if (/\bknowledge_entries\b/.test(sql)) return 'knowledge_entries';
  if (/\baction_dismissals\b/.test(sql)) return 'action_dismissals';
  if (/\bschedules\b/.test(sql)) return 'schedules';
  if (/\bproject_budgets\b/.test(sql)) return 'project_budgets';
  if (/\bautomation_reports\b/.test(sql)) return 'automation_reports';
  if (/\bcustomer_deliveries\b/.test(sql)) return 'customer_deliveries';
  if (/\baudit_logs\b/.test(sql)) return 'audit_logs';
  return null;
}

// ---------- 工厂方法 ----------

export function seedAgent(db: ReturnType<typeof createMockDb>, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.tables.agents.set(id, {
    id,
    name: `测试员工-${id.slice(6)}`,
    role: '负责测试任务执行的数字员工，验证状态机转换逻辑',
    system_prompt: '',
    soul_md: '',
    agents_md: '',
    user_md: '',
    lifecycle: 'READY',
    engine_id: 'engine-sim',
    workspace: '',
    permission_mode: 'standard',
    concurrency_limit: 1,
    archived: 0,
    avatar_color: '#4d6bfe',
    created_at: now,
    updated_at: now,
    ...overrides
  });
  return id;
}

export function seedEngine(db: ReturnType<typeof createMockDb>, id = 'engine-sim'): void {
  db.tables.engines.set(id, {
    id,
    type: 'hermes',
    name: 'Hermes (内置)',
    version: '1.0.0',
    path: null,
    status: 'HEALTHY',
    auth_status: 'authed',
    is_default: 1,
    data_boundary: '本地'
  });
}

/** 种子项目：默认进行中。 */
export function seedProject(db: ReturnType<typeof createMockDb>, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = `project-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.tables.projects.set(id, {
    id, name: `测试项目-${id.slice(8)}`, objective: '验证项目归属闭环', description: '', client_name: '',
    status: 'active', color: '#4d6bfe', due_at: null, created_at: now, updated_at: now,
    ...overrides
  });
  return id;
}

/** 种子团队（teams） */
export function seedTeam(db: ReturnType<typeof createMockDb>, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? `team-${Math.random().toString(36).slice(2, 8)}`;
  db.tables.teams.set(id, {
    id,
    name: '测试团队',
    coordinator_id: 'coord',
    member_ids: JSON.stringify(['a1', 'a3']),
    mode: 'coordinate',
    workspace: '',
    created_at: Date.now(),
    ...overrides
  });
  return id;
}

/** 种子团队运行记录（team_runs）：phase/subtasks 可覆盖，默认处于 execute 活跃阶段 */
export function seedTeamRun(db: ReturnType<typeof createMockDb>, overrides: Partial<Record<string, unknown>> = {}): string {
  const id = `run-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.tables.team_runs.set(id, {
    id,
    team_id: 'team-test',
    task_text: '测试团队任务',
    phase: 'execute',
    current_step: 1,
    total_steps: 2,
    subtasks_json: '[]',
    events_json: '[]',
    final_result: null,
    error: null,
    created_at: now,
    ended_at: null,
    ...overrides
  });
  return id;
}

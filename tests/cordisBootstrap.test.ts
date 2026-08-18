import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, CreateAgentInput } from '../src/shared/types.js';
import { DSH_MANAGED_ENGINE_ID } from '../src/shared/types.js';
import {
  CORDIS_AGENT_NAME,
  CORDIS_AGENT_ROLE,
  CordisBootstrapConflictError,
  ensureCordisAgent
} from '../src/main/services/cordisBootstrap.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-bootstrap-'));
  roots.push(root);
  return join(root, 'aibox-data', 'workspaces', CORDIS_AGENT_NAME);
}

function agent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: 'agent-existing',
    kind: 'general',
    name: CORDIS_AGENT_NAME,
    role: CORDIS_AGENT_ROLE,
    systemPrompt: '',
    soulMd: '',
    agentsMd: '',
    userMd: '',
    lifecycle: 'READY',
    engineId: DSH_MANAGED_ENGINE_ID,
    workspace: 'C:\\existing-cordis',
    permissionMode: 'standard',
    capabilities: { network: false, shell: false, install: false, browser: false, computer: false, mobile: false },
    tags: [],
    concurrencyLimit: 1,
    archived: false,
    avatarColor: '#4d6bfe',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function port(initial: Agent[] = [], nameCheckpoint: Record<string, unknown> | null = null) {
  const agents = [...initial];
  const checkpointAgentCreation = vi.fn(() => ({
    existing: nameCheckpoint,
    autoWorkspacePath: null,
    autoWorkspaceExisted: false
  }));
  const createAgent = vi.fn((input: CreateAgentInput) => {
    const created = agent({
      id: 'agent-cordis',
      name: input.name,
      role: input.role,
      systemPrompt: input.systemPrompt,
      engineId: input.engineId,
      workspace: input.workspace,
      permissionMode: input.permissionMode,
      concurrencyLimit: input.concurrencyLimit,
      lifecycle: 'READY'
    });
    agents.push(created);
    return created;
  });
  return {
    agents,
    orchestrator: {
      listAgents: vi.fn(() => agents.filter((item) => !item.archived)),
      checkpointAgentCreation,
      createAgent
    }
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Cordis v2 bootstrap', () => {
  it('creates one READY Cordis employee through Orchestrator with the managed DSH engine', () => {
    const fixture = port();
    const cordisWorkspace = workspace();

    const result = ensureCordisAgent(fixture.orchestrator as never, cordisWorkspace);

    expect(result).toMatchObject({
      created: true,
      agent: {
        name: CORDIS_AGENT_NAME,
        role: CORDIS_AGENT_ROLE,
        lifecycle: 'READY',
        engineId: DSH_MANAGED_ENGINE_ID,
        workspace: cordisWorkspace,
        permissionMode: 'autonomous',
        concurrencyLimit: 1
      }
    });
    expect(fixture.orchestrator.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: CORDIS_AGENT_NAME,
      role: CORDIS_AGENT_ROLE,
      engineId: DSH_MANAGED_ENGINE_ID,
      workspace: cordisWorkspace,
      channelIds: []
    }));
    expect(statSync(cordisWorkspace).isDirectory()).toBe(true);

    const repeated = ensureCordisAgent(fixture.orchestrator as never, cordisWorkspace);
    expect(repeated).toEqual({ created: false, agent: result.agent });
    expect(fixture.orchestrator.createAgent).toHaveBeenCalledOnce();
  });

  it('is idempotent and reuses any unarchived managed DSH employee', () => {
    const existing = agent({ id: 'agent-user-dsh', name: '用户的 DSH 负责人', lifecycle: 'DISABLED' });
    const fixture = port([existing]);

    const first = ensureCordisAgent(fixture.orchestrator as never, 'relative-path-is-unused');
    const second = ensureCordisAgent(fixture.orchestrator as never, 'relative-path-is-unused');

    expect(first).toEqual({ created: false, agent: existing });
    expect(second).toEqual(first);
    expect(fixture.orchestrator.checkpointAgentCreation).not.toHaveBeenCalled();
    expect(fixture.orchestrator.createAgent).not.toHaveBeenCalled();
  });

  it('does not treat unrelated user employees as Cordis or modify them', () => {
    const userEmployee = agent({ id: 'agent-user', name: '内容负责人', engineId: 'eng-codex' });
    const fixture = port([userEmployee]);

    const result = ensureCordisAgent(fixture.orchestrator as never, workspace());

    expect(result.created).toBe(true);
    expect(fixture.agents[0]).toBe(userEmployee);
    expect(userEmployee).toMatchObject({ name: '内容负责人', engineId: 'eng-codex', archived: false });
    expect(fixture.agents).toHaveLength(2);
  });

  it('fails without invoking createAgent when the reserved name belongs to another employee', () => {
    const fixture = port([], { id: 'agent-user-cordis', archived: 0, engine_id: 'eng-codex' });
    const cordisWorkspace = workspace();

    expect(() => ensureCordisAgent(fixture.orchestrator as never, cordisWorkspace))
      .toThrow(CordisBootstrapConflictError);
    expect(fixture.orchestrator.createAgent).not.toHaveBeenCalled();
  });

  it('also protects an archived same-name employee from createAgent reactivation', () => {
    const fixture = port([], { id: 'agent-archived-cordis', archived: 1, engine_id: 'eng-codex' });

    expect(() => ensureCordisAgent(fixture.orchestrator as never, workspace()))
      .toThrow('该名称已被现有数字员工占用');
    expect(fixture.orchestrator.createAgent).not.toHaveBeenCalled();
  });

  it('rejects a relative workspace before creating the employee', () => {
    const fixture = port();

    expect(() => ensureCordisAgent(fixture.orchestrator as never, 'aibox-data/workspaces/Cordis'))
      .toThrow('absolute app-data path');
    expect(fixture.orchestrator.createAgent).not.toHaveBeenCalled();
  });
});

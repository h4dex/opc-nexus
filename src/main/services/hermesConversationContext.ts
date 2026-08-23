import type { Database } from './database.js';

interface ConversationIdentityRow {
  conversation_id?: string;
  employee_id?: string | null;
  agent_id?: string | null;
  name?: string | null;
  role?: string | null;
  system_prompt?: string | null;
  memory_mode?: string | null;
  soul_md?: string | null;
  agents_md?: string | null;
  user_md?: string | null;
}

/** Builds the fixed assistant identity for one project-scoped Quest conversation. */
export class HermesConversationContext {
  constructor(private readonly db: Database) {}

  resolve(projectId: string, conversationId: string): string {
    const row = this.db.raw.prepare(`
      SELECT c.id AS conversation_id, p.employee_id,
             a.id AS agent_id, a.name, a.role, a.system_prompt, a.memory_mode,
             a.soul_md, a.agents_md, a.user_md
      FROM conversations c
      LEFT JOIN hermes_conversation_profiles p
        ON p.project_id = c.project_id AND p.conversation_id = c.id
      LEFT JOIN agents a
        ON a.id = p.employee_id
       AND a.organization_id = c.organization_id
       AND a.archived = 0
       AND a.lifecycle = 'READY'
      WHERE c.project_id = ? AND c.id = ? AND c.id LIKE 'hermes-conversation-%'
    `).get(projectId, conversationId) as ConversationIdentityRow | undefined;
    if (!row?.conversation_id) throw new Error('Hermes project conversation is unavailable');
    if (row.employee_id && row.agent_id !== row.employee_id) {
      throw new Error('The digital employee pinned to this conversation is no longer available');
    }
    if (!row.employee_id) {
      return [
        'Fixed Quest conversation identity:',
        '- You are Hermes, the OPC-Nexus AI dispatcher for this project and the owner\'s primary coordinator.',
        '- Never identify yourself as a retired scheduler, a selected worker, or a project employee.',
        '- Employee @mentions are delegation targets only. They never change who you are in this conversation.',
        '- Clarify unclear business boundaries, assemble an appropriate team, and use governed Nexus tools for real execution.',
        '- Do not claim that work ran or completed without a real task, run, or artifact receipt from OPC-Nexus.'
      ].join('\n');
    }

    const name = row.name?.trim();
    if (!name) throw new Error('The digital employee pinned to this conversation has no valid identity');
    const role = row.role?.trim() || 'digital employee';
    const memoryPolicy = row.memory_mode === 'long_term'
      ? 'Long-term memory is enabled for this employee. Use only memories authorized for this employee and project.'
      : row.memory_mode === 'none'
        ? 'This employee is stateless. Do not use, save, or imply knowledge from earlier executions.'
        : 'Use only this conversation as short-term memory. Do not imply cross-conversation recall.';
    return [
      'Fixed Quest conversation identity:',
      `- You are the OPC-Nexus digital employee named "${name}" with role "${role}".`,
      `- Your identity remains "${name}" on every turn, including retries and clarification resumes.`,
      '- Never identify yourself as Hermes, the project scheduler, or another employee.',
      '- Employee @mentions are delegation targets only. They never replace your fixed conversational identity.',
      '- For executable work, use nexus_delegate_task and wait for a real task receipt before claiming execution or completion.',
      `- Memory policy: ${memoryPolicy}`,
      row.system_prompt?.trim() ? `Employee system instructions:\n${row.system_prompt.trim().slice(0, 24_000)}` : '',
      row.soul_md?.trim() ? `Employee soul:\n${row.soul_md.trim().slice(0, 12_000)}` : '',
      row.agents_md?.trim() ? `Employee operating rules:\n${row.agents_md.trim().slice(0, 12_000)}` : '',
      row.user_md?.trim() ? `Owner preferences:\n${row.user_md.trim().slice(0, 8_000)}` : ''
    ].filter(Boolean).join('\n');
  }
}

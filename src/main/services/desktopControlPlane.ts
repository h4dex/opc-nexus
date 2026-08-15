import type { Task } from '../../shared/types.js';
import type { Database } from './database.js';
import type { ChannelControlPlane } from './channelControlPlane.js';
import { DesktopIngressService } from './desktopIngressService.js';

export interface DesktopDispatchInput {
  preferredAgentId: string;
  message: string;
  source?: 'desktop' | 'voice' | 'webhook';
  conversationId?: string;
  messageKey?: string;
  projectId?: string | null;
}

/** Routes desktop chat through the same durable kernel path as channels. */
export class DesktopControlPlane {
  constructor(
    private readonly db: Database,
    private readonly ingress: DesktopIngressService,
    private readonly control: Pick<ChannelControlPlane, 'dispatchCanonical'>
  ) {}

  async dispatch(input: DesktopDispatchInput): Promise<{ conversationId: string; task: Task }> {
    const ingress = this.ingress.ingest({
      agentId: input.preferredAgentId,
      message: input.message,
      conversationId: input.conversationId,
      messageKey: input.messageKey
    });
    if (ingress.taskId) {
      const existing = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ? LIMIT 1').get(ingress.taskId) as Record<string, unknown> | undefined;
      if (!existing) throw new Error('桌面消息关联的任务不存在');
      // The public Task mapper is intentionally owned by Orchestrator, so use
      // the already committed control-plane path to recover its canonical task.
      const task = await this.control.dispatchCanonical({
        source: input.source ?? 'desktop',
        organizationId: ingress.organizationId,
        principalId: ingress.principalId,
        channelId: null,
        conversationId: ingress.conversationId,
        inputMessageId: ingress.inputMessageId,
        message: input.message,
        preferredAgentId: input.preferredAgentId,
        projectId: input.projectId
      });
      return { conversationId: ingress.conversationId, task };
    }

    const task = await this.control.dispatchCanonical({
      source: input.source ?? 'desktop',
      organizationId: ingress.organizationId,
      principalId: ingress.principalId,
      channelId: null,
      conversationId: ingress.conversationId,
      inputMessageId: ingress.inputMessageId,
      message: input.message,
      preferredAgentId: input.preferredAgentId,
      projectId: input.projectId
    });
    this.ingress.linkTask(ingress, task.id);
    return { conversationId: ingress.conversationId, task };
  }
}

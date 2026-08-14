import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

const { ApprovalBroker } = await import('../src/main/services/approvalBroker.js');
const { notify } = await import('../src/main/services/notifier.js');

beforeEach(() => {
  vi.mocked(notify).mockClear();
});

function makeBrokerDb() {
  const writes: { sql: string; args: unknown[] }[] = [];
  return {
    writes,
    db: {
      raw: {
        prepare: (sql: string) => ({
          run: (...args: unknown[]) => {
            writes.push({ sql, args });
            return { changes: 1 };
          }
        })
      },
      transaction: (fn: () => void) => fn()
    }
  };
}

const request = {
  taskId: 'task-1',
  agentId: 'agent-1',
  type: 'write_workspace' as const,
  request: 'write a file',
  risk: 'medium' as const
};

describe('ApprovalBroker single-flight', () => {
  it('不会用重复请求覆盖同任务的未决审批 Promise', async () => {
    const { db, writes } = makeBrokerDb();
    const broker = new ApprovalBroker(db as never);
    broker.onChange(() => { throw new Error('listener failure'); });

    const firstDecision = broker.request(request);
    expect(() => broker.request(request)).toThrow('已有待处理审批');
    expect(writes.filter(({ sql }) => sql.includes('INSERT INTO approvals'))).toHaveLength(1);
    expect(writes.filter(({ sql }) => sql.includes('INSERT INTO task_events'))).toHaveLength(1);
    expect(writes.filter(({ sql }) => sql.includes("UPDATE tasks SET status = 'WAITING_APPROVAL'"))).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();

    broker.abandonTask(request.taskId);
    await expect(firstDecision).resolves.toBe(false);
    expect(writes).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("UPDATE approvals SET status = 'rejected'")
    }));

    const secondDecision = broker.request(request);
    const approvalWrites = writes.filter(({ sql }) => sql.includes('INSERT INTO approvals'));
    const secondApprovalId = approvalWrites.at(-1)!.args[0] as string;
    expect(broker.decide(secondApprovalId, true)).toBe(true);
    await expect(secondDecision).resolves.toBe(true);
  });

  it('数据库拒绝状态写入失败时仍释放 Promise 和单任务槽位', async () => {
    const { db } = makeBrokerDb();
    const broker = new ApprovalBroker(db as never);
    const firstDecision = broker.request(request);
    const originalPrepare = db.raw.prepare;
    let failedOnce = false;
    db.raw.prepare = (sql: string) => {
      if (!failedOnce && sql.includes("UPDATE approvals SET status = 'rejected'")) {
        failedOnce = true;
        return { run: () => { throw new Error('disk failure'); } };
      }
      return originalPrepare(sql);
    };

    expect(() => broker.abandonTask(request.taskId)).toThrow('disk failure');
    await expect(firstDecision).resolves.toBe(false);

    const secondDecision = broker.request(request);
    broker.abandonTask(request.taskId);
    await expect(secondDecision).resolves.toBe(false);
  });
});

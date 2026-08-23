import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));

import { TOOLS } from '../src/main/services/executor/tools.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('executor tool cancellation', () => {
  it('terminates the shell process tree before a delayed child can write a file', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'opc-tool-cancel-'));
    tempDirs.push(workspace);
    const marker = join(workspace, 'late-marker.txt');
    writeFileSync(
      join(workspace, 'delayed-write.cjs'),
      "setTimeout(() => require('node:fs').writeFileSync('late-marker.txt', 'late'), 4000);\n",
      'utf8'
    );
    const runCommand = TOOLS.find((tool) => tool.name === 'run_command');
    expect(runCommand).toBeDefined();
    const controller = new AbortController();

    const execution = runCommand!.execute(
      { command: 'node delayed-write.cjs' },
      {
        workspace,
        agentId: 'agent-cancel',
        taskId: 'task-cancel',
        host: null,
        signal: controller.signal
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort(new Error('测试取消'));

    await expect(execution).rejects.toThrow('测试取消');
    await new Promise((resolve) => setTimeout(resolve, 4_300));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);
});

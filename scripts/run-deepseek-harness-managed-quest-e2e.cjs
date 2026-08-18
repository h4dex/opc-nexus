'use strict';

const { spawn } = require('node:child_process');
const { resolve } = require('node:path');

const vitest = resolve(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
const child = spawn(process.execPath, [
  vitest,
  'run',
  'tests/dshManagedQuestTransportE2E.test.ts',
  '--reporter=verbose'
], {
  cwd: resolve(__dirname, '..'),
  env: { ...process.env, AIBOX_RUN_MANAGED_QUEST_E2E: '1' },
  stdio: 'inherit',
  windowsHide: true,
  shell: false
});

child.once('error', (error) => {
  console.error(`[deepseek-harness-managed] Quest E2E could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[deepseek-harness-managed] Quest E2E exited by signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

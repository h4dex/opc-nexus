const { spawn } = require('node:child_process');
const { join } = require('node:path');

const args = process.argv.slice(2);
const command = args[0] === 'preview' ? ['preview'] : [];
const projectId = args[0] === 'preview' ? args[1] : args[0];
const safeProjectId = typeof projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)
  ? projectId
  : null;
const electronArgs = [
  '--quest-only',
  ...(safeProjectId ? [`--quest-project=${safeProjectId}`] : [])
];
const entry = join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [entry, ...command, '--', ...electronArgs], {
  cwd: join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    AIBOX_QUEST_ONLY: '1',
    ...(safeProjectId ? { AIBOX_QUEST_PROJECT: safeProjectId } : {})
  }
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 0 : 1));
});
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

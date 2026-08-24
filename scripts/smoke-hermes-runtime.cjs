'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bundledPython, verifyAll } = require('./prepare-hermes.cjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'hermes-agent');
const webDist = path.join(source, 'hermes_cli', 'web_dist');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Hermes smoke port allocation failed'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Hermes smoke process exited with code ${child.exitCode}\n${logs.value.slice(-4_000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && body?.ok === true && typeof body.version === 'string' && body.version.startsWith('0.19.')) return body;
    } catch {
      // The service may still be importing its runtime dependencies.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes smoke health check timed out\n${logs.value.slice(-4_000)}`);
}

async function verifySessionToken(port) {
  // /api/health and /api/status are intentionally public liveness probes in
  // Hermes v0.19.0. Use a read-only project endpoint to verify the dashboard
  // session boundary without mutating the smoke profile.
  const url = `http://127.0.0.1:${port}/api/sessions`;
  const anonymous = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (anonymous.status !== 401) throw new Error(`Hermes protected API accepted an anonymous request (HTTP ${anonymous.status})`);
  const authenticated = await fetch(url, {
    signal: AbortSignal.timeout(2_000),
    headers: { 'x-hermes-session-token': 'smoke-private-token' }
  });
  if (!authenticated.ok) throw new Error(`Hermes protected API rejected the Main token (HTTP ${authenticated.status})`);
}

async function waitForGatewayHealth(port, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Hermes gateway smoke process exited with code ${child.exitCode}\n${logs.value.slice(-4_000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && body?.status === 'ok' && typeof body.version === 'string' && body.version.startsWith('0.19.')) return body;
    } catch {
      // The gateway imports its adapter registry before binding the API server.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes API gateway smoke health check timed out\n${logs.value.slice(-4_000)}`);
}

async function verifyGatewayToken(port, token) {
  const url = `http://127.0.0.1:${port}/api/sessions`;
  const anonymous = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (anonymous.status !== 401) throw new Error(`Hermes API Server accepted an anonymous session request (HTTP ${anonymous.status})`);
  const authenticated = await fetch(url, {
    signal: AbortSignal.timeout(2_000),
    headers: { authorization: `Bearer ${token}` }
  });
  if (!authenticated.ok) throw new Error(`Hermes API Server rejected the Main token (HTTP ${authenticated.status})`);

  const toolsetsResponse = await fetch(`http://127.0.0.1:${port}/v1/toolsets`, {
    // The first toolset read imports the real skill/MCP registry. On a cold
    // Windows runtime this can legitimately take several seconds; a 2s
    // transport timeout falsely reports a healthy gateway as broken.
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}` }
  });
  if (!toolsetsResponse.ok) throw new Error(`Hermes toolset probe failed (HTTP ${toolsetsResponse.status})`);
  const toolsets = await toolsetsResponse.json();
  const planning = toolsets?.data?.find((item) => item?.name === 'planning');
  const expected = ['nexus_delegate_task', 'nexus_mcp_call', 'nexus_submit_plan', 'nexus_image_generate'];
  if (!planning?.enabled || expected.some((name) => !planning.tools?.includes(name))) {
    throw new Error('Hermes project mode did not expose the OPC-Nexus planning tools');
  }
}

async function main() {
  const startedAt = Date.now();
  verifyAll();
  console.log(`[Hermes] runtime verification completed in ${Date.now() - startedAt}ms`);
  const port = await reservePort();
  const gatewayPort = await reservePort();
  const gatewayToken = 'opc-smoke-0123456789abcdef0123456789abcdef';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-hermes-smoke-'));
  const home = path.join(temp, 'home');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(home, 'config.yaml'), `${JSON.stringify({
    model: { default: 'smoke-model', provider: 'opcnexus' },
    providers: {
      opcnexus: {
        name: 'OPC-Nexus smoke', api: 'http://127.0.0.1:9/v1', key_env: 'OPENAI_API_KEY',
        default_model: 'smoke-model', transport: 'chat_completions'
      }
    },
    dashboard: { host: '127.0.0.1' },
    platforms: { api_server: { enabled: true } },
    platform_toolsets: { api_server: ['hermes-api-server', 'planning'] }
  }, null, 2)}\n`, 'utf8');
  const logs = { value: '' };
  const child = spawn(bundledPython(), [
    '-m', 'hermes_cli.main', 'dashboard', '--host', '127.0.0.1', '--port', String(port),
    '--no-open', '--skip-build', '--isolated'
  ], {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      HERMES_HOME: home,
      HERMES_CWD: workspace,
      TERMINAL_CWD: workspace,
      HERMES_DESKTOP: '1',
      HERMES_DASHBOARD_SESSION_TOKEN: 'smoke-private-token',
      HERMES_WEB_DIST: webDist,
      HERMES_QUIET: '1',
      OPENAI_API_KEY: 'smoke-not-a-real-secret',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      HERMES_INFERENCE_MODEL: 'smoke-model',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1'
    }
  });
  child.stdout?.on('data', (chunk) => { logs.value = `${logs.value}${chunk}`.slice(-32_000); });
  child.stderr?.on('data', (chunk) => { logs.value = `${logs.value}${chunk}`.slice(-32_000); });
  const gatewayLogs = { value: '' };
  const gateway = spawn(bundledPython(), [
    '-m', 'hermes_cli.main', 'gateway', 'run'
  ], {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      HERMES_HOME: home,
      HERMES_CWD: workspace,
      TERMINAL_CWD: workspace,
      HERMES_NEXUS_PROJECT_ID: 'smoke-project',
      HERMES_NEXUS_HOST_URL: 'http://127.0.0.1:9',
      HERMES_NEXUS_HOST_TOKEN: 'smoke-host-token',
      HERMES_QUIET: '1',
      API_SERVER_ENABLED: 'true',
      API_SERVER_KEY: gatewayToken,
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(gatewayPort),
      OPENAI_API_KEY: 'smoke-not-a-real-secret',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      HERMES_INFERENCE_MODEL: 'smoke-model',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1'
    }
  });
  gateway.stdout?.on('data', (chunk) => { gatewayLogs.value = `${gatewayLogs.value}${chunk}`.slice(-32_000); });
  gateway.stderr?.on('data', (chunk) => { gatewayLogs.value = `${gatewayLogs.value}${chunk}`.slice(-32_000); });
  const spawnedAt = Date.now();
  try {
    const [health, gatewayHealth] = await Promise.all([
      waitForHealth(port, child, logs).then((value) => {
        console.log(`[Hermes] dashboard became healthy in ${Date.now() - spawnedAt}ms`);
        return value;
      }),
      waitForGatewayHealth(gatewayPort, gateway, gatewayLogs).then((value) => {
        console.log(`[Hermes] API Server became healthy in ${Date.now() - spawnedAt}ms`);
        return value;
      })
    ]);
    await verifySessionToken(port);
    console.log(`[Hermes] dashboard authentication verified in ${Date.now() - spawnedAt}ms`);
    await verifyGatewayToken(gatewayPort, gatewayToken);
    console.log(`[Hermes] tool catalog verified in ${Date.now() - spawnedAt}ms`);
    console.log(`[Hermes] dashboard smoke passed on loopback: version=${health.version}, session-token=required`);
    console.log(`[Hermes] API Server smoke passed on loopback: version=${gatewayHealth.version}, bearer-token=required`);
  } finally {
    if (gateway.exitCode === null) gateway.kill('SIGTERM');
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      Promise.all([
        new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve()),
        new Promise((resolve) => gateway.exitCode === null ? gateway.once('exit', resolve) : resolve())
      ]),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (gateway.exitCode === null) gateway.kill('SIGKILL');
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[Hermes] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

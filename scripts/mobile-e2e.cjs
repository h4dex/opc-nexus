const { _electron: electron } = require('playwright');
const {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir, homedir } = require('node:os');
const { delimiter, join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const ARTIFACTS = join(ROOT, 'mobile', 'dist', 'e2e');
const HOST = process.env.OPCNEXUS_E2E_HOST || '192.168.121.105';
const PORT = Number(process.env.OPCNEXUS_E2E_PORT || 18765);
const SERIAL = process.env.OPCNEXUS_E2E_SERIAL || 'emulator-5554';
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const ADB = ANDROID_HOME && join(ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const KEEP = process.env.OPCNEXUS_E2E_KEEP === '1';
const SEED_USER_DATA = String(process.env.OPCNEXUS_E2E_SEED_USER_DATA || '').trim();
// The debug APK exposes an ADB-only receiver so CI can inject JSON without
// relying on `adb shell input text`, which cannot faithfully carry JSON punctuation.
// Release APKs do not declare this receiver. The default path remains the real UI.
const DEBUG_PAIR = process.env.OPCNEXUS_E2E_DEBUG_PAIR === '1';
const ACCESSIBILITY_COMPONENT =
  'com.senke.opcnexus.bridge/com.hermesandroid.bridge.service.BridgeAccessibilityService';
const NOTIFICATION_COMPONENT =
  'com.senke.opcnexus.bridge/com.hermesandroid.bridge.service.BridgeNotificationListener';
const DEBUG_PAIR_ACTION = 'com.senke.opcnexus.bridge.debug.PAIR';
const DEBUG_PAIR_RECEIVER =
  'com.senke.opcnexus.bridge/com.hermesandroid.bridge.debug.DebugPairingReceiver';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function adb(...args) {
  check(ADB && existsSync(ADB), 'Android adb was not found; set ANDROID_HOME');
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 60_000 }).trim();
}

function adbOptional(...args) {
  try {
    return adb(...args);
  } catch {
    return '';
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function addSecureSetting(name, component) {
  const current = adb('shell', 'settings', 'get', 'secure', name);
  const values = current === 'null' || current === ''
    ? []
    : current.split(':').filter(Boolean);
  if (!values.includes(component)) values.push(component);
  adb('shell', 'settings', 'put', 'secure', name, values.join(':'));
}

function prepareEmulator() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  // A previous manual scan can leave ZXing's CaptureActivity on top of MainActivity.
  adb('shell', 'am', 'force-stop', 'com.senke.opcnexus.bridge');
  addSecureSetting('enabled_accessibility_services', ACCESSIBILITY_COMPONENT);
  adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1');
  adb('shell', 'cmd', 'notification', 'allow_listener', NOTIFICATION_COMPONENT);
  adb('shell', 'cmd', 'location', 'set-location-enabled', 'true');
  for (const permission of [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.CALL_PHONE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_CONTACTS',
    'android.permission.RECORD_AUDIO',
    'android.permission.SEND_SMS',
  ]) {
    adb('shell', 'pm', 'grant', 'com.senke.opcnexus.bridge', permission);
  }
  adb('shell', 'am', 'start', '-W', '-n', 'com.senke.opcnexus.bridge/com.hermesandroid.bridge.MainActivity');
}

function setMockLocation(latitude, longitude) {
  adb('shell', 'appops', 'set', '2000', 'android:mock_location', 'allow');
  adbOptional('shell', 'cmd', 'location', 'providers', 'remove-test-provider', 'gps');
  adb('shell', 'cmd', 'location', 'providers', 'add-test-provider', 'gps', '--requiresSatellite', '--supportsAltitude');
  adb('shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true');
  adb(
    'shell', 'cmd', 'location', 'providers', 'set-test-provider-location', 'gps',
    '--location', `${latitude},${longitude}`, '--accuracy', '3',
  );
}

function clearMockLocation() {
  adbOptional('shell', 'cmd', 'location', 'providers', 'remove-test-provider', 'gps');
  adbOptional('shell', 'appops', 'set', '2000', 'android:mock_location', 'deny');
}

function androidUiNodes() {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?\s*>/g)) {
    const attributes = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = attribute[2];
    }
    const bounds = /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(attributes.bounds || '');
    if (bounds) attributes.boundsValue = bounds.slice(1).map(Number);
    nodes.push(attributes);
  }
  return nodes;
}

async function tapAndroidNode(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const node = androidUiNodes().find((candidate) => candidate.boundsValue && predicate(candidate));
    if (node) {
      const [left, top, right, bottom] = node.boundsValue;
      adb('shell', 'input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)));
      return node;
    }
    const scroller = androidUiNodes().find((candidate) => candidate.scrollable === 'true' && candidate.boundsValue);
    if (scroller) {
      const [left, top, right, bottom] = scroller.boundsValue;
      const x = Math.round((left + right) / 2);
      adb('shell', 'input', 'swipe', String(x), String(Math.max(top + 80, bottom - 180)), String(x), String(top + 100), '350');
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Android UI node did not appear');
}

function escapeAndroidInputText(value) {
  return value
    .replace(/%/g, '\\%')
    .replace(/ /g, '%s')
    .replace(/[&<>"'()|;*?~`$\\]/g, (character) => `\\${character}`);
}

function submitDebugPairingPayload(payload) {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const output = adb(
    'shell', 'am', 'broadcast',
    '-n', DEBUG_PAIR_RECEIVER,
    '-a', DEBUG_PAIR_ACTION,
    '--es', 'payload_b64', encoded,
  );
  check(/result=0|Broadcast completed/i.test(output), `Debug pairing receiver rejected the payload: ${output}`);
}

async function setAndroidText(resourceId, value, timeoutMs = 10_000) {
  const node = await tapAndroidNode((candidate) => candidate['resource-id'] === resourceId, timeoutMs);
  adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
  adb('shell', 'input', 'keyevent', '--longpress', 'KEYCODE_DEL');
  adb('shell', 'input', 'text', escapeAndroidInputText(value));
  return node;
}

function findFile(root, predicate, depth = 0) {
  if (!existsSync(root) || depth > 7) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && predicate(path)) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, predicate, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function decodeQr(path) {
  const cache = join(homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', 'com.google.zxing', 'core');
  const core = findFile(cache, (value) => /[\\/]core-[\d.]+\.jar$/.test(value));
  check(core, 'ZXing core jar is missing from the Gradle cache; build the Android app first');
  const classes = join(ARTIFACTS, 'qr-decoder-classes');
  const source = join(ROOT, 'scripts', 'DecodeQr.java');
  try {
    rmSync(classes, { recursive: true, force: true });
    mkdirSync(classes, { recursive: true });
    execFileSync('javac', ['-cp', core, '-d', classes, source], { encoding: 'utf8', timeout: 30_000 });
    return execFileSync('java', ['-cp', `${core}${delimiter}${classes}`, 'DecodeQr', path], { encoding: 'utf8', timeout: 30_000 });
  } finally {
    rmSync(classes, { recursive: true, force: true });
  }
}

async function waitForDevice(api, deviceId = null, status = 'online', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const devices = await api.listMobileDevices();
    const device = deviceId ? devices.find((item) => item.id === deviceId) : devices[0];
    if (device?.status === status) return device;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Android emulator did not reach ${status} state`);
}

async function waitForPermission(api, deviceId, permission, expected = 'granted', timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const devices = await api.listMobileDevices();
    const device = devices.find((item) => item.id === deviceId);
    if (device?.permissions?.[permission] === expected) return device;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Android permission ${permission} did not become ${expected}`);
}

async function waitForAccessibility(invoke, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const ping = await invoke('android_ping');
    if (ping.accessibilityService === true) return ping;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('Android accessibility service did not bind');
}

async function waitForMicrophone(invoke, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await invoke('android_mic_status');
    if (status.phase === 'ready' && status.latest && Number(status.latestSize) > 44) return status;
    if (status.phase === 'error') throw new Error(`Android microphone failed: ${status.error || 'unknown error'}`);
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('Android microphone recording did not finish');
}

async function waitForTask(call, taskId, timeoutMs = 180_000) {
  const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot = await call('getSnapshot');
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (task && terminal.has(task.status)) return task;
    await delay(750);
  } while (Date.now() < deadline);
  throw new Error(`Hermes Android task ${taskId} did not reach a terminal state`);
}

function eventPayloads(events) {
  return events.map((event) => ({ type: event.eventType, payload: event.payload }));
}

function artifactHeader(userData, artifact, byteCount = 16) {
  check(/^[a-f0-9-]{8,100}$/.test(artifact.id), 'Artifact ID is invalid');
  const directory = join(userData, 'aibox-data', 'mobile-artifacts');
  const filename = readdirSync(directory).find((name) => name.startsWith(`${artifact.id}.`));
  check(filename, `Artifact file ${artifact.id} is missing from isolated user data`);
  const data = readFileSync(join(directory, filename));
  return {
    ok: true,
    mimeType: artifact.mimeType,
    length: data.length,
    bytes: Array.from(data.subarray(0, byteCount)),
  };
}

async function main() {
  check(Number.isInteger(PORT) && PORT >= 1024 && PORT <= 65535, 'OPCNEXUS_E2E_PORT is invalid');
  check(existsSync(join(ROOT, 'out', 'main', 'index.js')), 'Run npm run build before mobile E2E');
  mkdirSync(ARTIFACTS, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), 'opcnexus-mobile-e2e-'));
  if (SEED_USER_DATA) {
    const seedPath = resolve(SEED_USER_DATA);
    check(existsSync(seedPath), `OPCNEXUS_E2E_SEED_USER_DATA does not exist: ${seedPath}`);
    cpSync(seedPath, userData, { recursive: true, force: true });
  }
  const resultPath = join(ARTIFACTS, 'result.json');
  let app;
  let profileHome = null;
  let mockLocationActive = false;
  const result = { host: HOST, port: PORT, serial: SERIAL, startedAt: Date.now(), steps: [], warnings: [] };
  const record = (step, value = {}) => {
    result.steps.push({ step, at: Date.now(), ...value });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  };

  try {
    adb('get-state');
    prepareEmulator();
    record('emulator_prepared');
    app = await electron.launch({
      args: ['.', `--aibox-user-data=${userData}`],
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      timeout: 60_000,
    });
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Android 执行设备' }).click();
    await page.getByRole('heading', { name: 'Android 执行设备' }).waitFor();
    const api = await page.evaluateHandle(() => window.aibox);
    const call = (name, ...args) => api.evaluate((bridge, input) => bridge[input.name](...input.args), { name, args });

    // Exercise the owner-visible recovery flow before first pairing. The
    // isolated profile may contain a certificate copied from another LAN.
    await page.getByRole('button', { name: '连接修复与证书重置' }).click();
    await page.getByRole('dialog', { name: '重置 Android Worker 连接证书' }).waitFor();
    await page.getByRole('button', { name: '确认重置证书' }).click();
    await page.getByRole('dialog', { name: '重置 Android Worker 连接证书' }).waitFor({ state: 'detached' });
    record('desktop_certificate_reset');

    await page.getByLabel('局域网地址').selectOption(HOST);
    await page.getByLabel('网关端口').fill(String(PORT));
    await page.getByRole('button', { name: '启动 Android 网关' }).click();
    await page.getByText(`wss://${HOST}:${PORT}/v1/device`).waitFor();
    const status = await call('getMobileStatus');
    check(status.running && status.host === HOST, 'Mobile Gateway did not start on the requested LAN address');
    record('gateway_started', { status });

    await page.getByRole('button', { name: '配对 Android Worker' }).click();
    const pairingDialog = page.getByRole('dialog', { name: '配对 Android Worker' });
    await pairingDialog.waitFor();
    const pairingImage = pairingDialog.getByRole('img', { name: 'Android Worker 配对二维码' });
    await pairingImage.waitFor();
    const qrPath = join(ARTIFACTS, 'pairing-qr.png');
    let pairing;
    let qrUri = '';
    let rawQr;
    for (let scanAttempt = 1; scanAttempt <= 3 && !pairing; scanAttempt += 1) {
      const previousUri = qrUri;
      if (scanAttempt > 1) {
        await pairingDialog.getByRole('button', { name: '重新生成' }).click();
        const refreshDeadline = Date.now() + 10_000;
        do {
          qrUri = await pairingImage.getAttribute('src') || '';
          if (qrUri && qrUri !== previousUri) break;
          await delay(100);
        } while (Date.now() < refreshDeadline);
        check(qrUri !== previousUri, 'Pairing QR did not refresh after regeneration');
      } else {
        qrUri = await pairingImage.getAttribute('src') || '';
      }
      check(qrUri.startsWith('aibox-mobile://pairing/'), 'Pairing image did not use the restricted mobile protocol');
      rawQr = await app.evaluate(async ({ net }, url) => {
        const response = await net.fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Pairing image returned HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          bytes: Array.from(bytes),
          contentType: response.headers.get('content-type'),
          cacheControl: response.headers.get('cache-control'),
        };
      }, qrUri);
      check(rawQr.contentType === 'image/png', 'Pairing protocol did not return a PNG');
      check(rawQr.cacheControl === 'no-store', 'Pairing protocol response is cacheable');
      try {
        writeFileSync(qrPath, Buffer.from(rawQr.bytes));
        pairing = JSON.parse(decodeQr(qrPath));
      } catch (error) {
        if (scanAttempt === 3) throw error;
        record('pairing_qr_scan_retry', { attempt: scanAttempt });
      } finally {
        rmSync(qrPath, { force: true });
      }
    }
    const pairingOfferId = qrUri.slice('aibox-mobile://pairing/'.length);
    check(pairing && rawQr, 'Pairing QR could not be decoded');
    check(pairing.url === `wss://${HOST}:${PORT}/v1/device`, 'QR gateway URL does not match the requested endpoint');
    check(typeof pairing.secret === 'string' && pairing.secret.length >= 40, 'QR pairing secret is missing');
    record('pairing_qr_decoded', {
      pairingId: pairing.pairingId,
      expiresAt: pairing.expiresAt,
      spki: pairing.spki,
      offerId: pairingOfferId,
      protocolBytes: rawQr.bytes.length,
    });

    await pairingDialog.getByRole('button', { name: '复制完整配置' }).click();
    const copyError = page.getByText(/Android Worker 配对配置未能写入系统剪贴板/);
    const copyOutcome = await Promise.race([
      page.getByText('完整配对配置已复制', { exact: true }).waitFor().then(() => ({ ok: true })),
      copyError.waitFor().then(async () => ({
        ok: false,
        error: await copyError.textContent(),
      })),
    ]);
    // Main verifies the system clipboard before resolving the typed preload
    // call. Clipboard access can be unavailable for the whole Windows desktop
    // session; QR scanning remains the primary pairing route in that case.
    const copiedPayload = JSON.stringify(pairing);
    if (copyOutcome.ok) {
      record('pairing_config_copied', { pairingId: pairing.pairingId, bytes: Buffer.byteLength(copiedPayload), ipc: 'ok' });
    } else {
      result.warnings.push({ code: 'SYSTEM_CLIPBOARD_UNAVAILABLE', message: copyOutcome.error });
      record('pairing_copy_blocked', { pairingId: pairing.pairingId, error: copyOutcome.error });
    }

    if (DEBUG_PAIR) {
      submitDebugPairingPayload(copiedPayload);
      record('pairing_config_submitted', { mode: 'debug_receiver' });
    } else {
      await setAndroidText('com.senke.opcnexus.bridge:id/etPairingConfig', copiedPayload);
      await tapAndroidNode((node) => node['resource-id'] === 'com.senke.opcnexus.bridge:id/btnParsePairingConfig');
      record('pairing_config_submitted', { mode: 'manual_ui' });
    }

    const device = await waitForDevice({ listMobileDevices: () => call('listMobileDevices') });
    record('device_paired', { deviceId: device.id, apiLevel: device.apiLevel, status: device.status, permissions: device.permissions });

    const catalog = await call('getMobileToolCatalog');
    const allowedTools = catalog.tools.map((tool) => tool.name);
    const agent = await call('createAgent', {
      name: `Android E2E ${Date.now()}`,
      role: 'Operate the assigned Android emulator for OPC-Nexus end-to-end verification.',
      systemPrompt: 'Verify Android controls and report concise results.',
      soulMd: 'You are a careful Android test operator.',
      agentsMd: 'Use only the assigned Android device and OPC-Nexus Android tools.',
      userMd: '',
      engineId: 'eng-hermes-cli',
      workspace: '',
      permissionMode: 'standard',
      concurrencyLimit: 1,
      channelIds: [],
      kind: 'android_operator',
      deviceId: device.id,
      mobileAllowedTools: allowedTools,
      mobileAuthorizationConfirmed: true,
    });
    profileHome = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'profiles', `opcnexus-mobile-${agent.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12)}`);
    record('agent_bound', { agentId: agent.id, profileHome, toolCount: allowedTools.length });

    await call('saveEngineConfig', 'eng-hermes-cli', { env: { HERMES_HOME: profileHome } });
    const hermesAuth = await call('authEngine', 'eng-hermes-cli');
    check(hermesAuth.ok, `Hermes v0.19.0 profile probe failed: ${hermesAuth.message}`);
    record('hermes_engine_verified', { version: '0.19.0', message: hermesAuth.message });

    const invoke = async (toolName, args = {}) => {
      const value = await call('executeMobileTool', { deviceId: device.id, toolName, args });
      record(toolName, { success: value.success !== false, keys: Object.keys(value) });
      return value;
    };
    const ping = await waitForAccessibility(invoke);
    check(ping.success !== false, 'android_ping failed');
    const tree = await call('readMobileUiTree', device.id);
    check(Number(tree.count || 0) > 0 || Array.isArray(tree.tree), 'UI tree was empty');
    record('android_read_screen', { count: tree.count || 0 });

    const naturalLanguageTask = await call(
      'createTask',
      agent.id,
      'Use android_current_app and android_read_screen now. Report the current Android package name and one visible UI label. You must call both Android tools; do not guess and do not use any non-Android tool.',
    );
    const completedTask = await waitForTask(call, naturalLanguageTask.id);
    const taskEvents = await call('getTaskEvents', naturalLanguageTask.id);
    const taskResult = await call('getTaskResult', naturalLanguageTask.id);
    const taskCommands = (await call('listMobileCommands', device.id))
      .filter((command) => command.taskId === naturalLanguageTask.id);
    const calledTools = new Set(taskCommands.map((command) => command.toolName));
    check(completedTask.status === 'COMPLETED', `Hermes Android task ended as ${completedTask.status}: ${completedTask.error || taskResult || 'no detail'}`);
    check(calledTools.has('android_current_app'), 'Hermes did not call android_current_app');
    check(calledTools.has('android_read_screen'), 'Hermes did not call android_read_screen');
    check(typeof taskResult === 'string' && taskResult.trim().length > 0, 'Hermes Android task returned no result');
    const timeline = eventPayloads(taskEvents);
    check(timeline.some((event) => event.type === 'tool_call' && event.payload.name === 'android_current_app'), 'Task timeline is missing android_current_app');
    check(timeline.some((event) => event.type === 'tool_call' && event.payload.name === 'android_read_screen'), 'Task timeline is missing android_read_screen');
    const screenResult = timeline.find((event) => event.type === 'tool_result' && event.payload.name === 'android_read_screen');
    check(screenResult?.payload?.result?.redacted === true, 'UI tree result was not redacted in the task timeline');
    const androidToolEvents = timeline.filter((event) =>
      (event.type === 'tool_call' || event.type === 'tool_result') && event.payload.source === 'android',
    );
    const persistedAndroidTelemetry = JSON.stringify({ events: androidToolEvents, commands: taskCommands });
    check(!persistedAndroidTelemetry.includes('OPC-Nexus 手机桥'), 'Visible Android UI text leaked into Android command telemetry');
    record('hermes_natural_language_task_verified', {
      taskId: naturalLanguageTask.id,
      status: completedTask.status,
      calledTools: [...calledTools],
      eventCount: taskEvents.length,
      resultLength: taskResult.length,
    });

    const previewUri = await call('refreshMobilePreview', device.id);
    check(previewUri.startsWith('aibox-mobile://preview/'), 'Preview URI was not task-safe mobile protocol data');
    record('android_preview', { uriScheme: previewUri.split(':')[0] });
    await page.screenshot({ path: join(ARTIFACTS, 'desktop-mobile-console.png'), fullPage: false });

    await invoke('android_open_app', { package: 'com.android.settings' });
    await invoke('android_press_key', { key: 'back' });
    await invoke('android_swipe', { direction: 'up', distance: 'short' });
    const screenshot = await invoke('android_screenshot');
    check(screenshot.artifact?.kind === 'screenshot', 'Screenshot did not create a mobile artifact');

    await call('stopMobileGateway');
    await waitForDevice({ listMobileDevices: () => call('listMobileDevices') }, device.id, 'offline');
    const restarted = await call('startMobileGateway', HOST, PORT);
    check(restarted.certificateFingerprint === status.certificateFingerprint, 'Gateway restart changed the pinned certificate');
    const reconnected = await waitForDevice({ listMobileDevices: () => call('listMobileDevices') }, device.id, 'online', 45_000);
    check(reconnected.id === device.id, 'Challenge reconnect created a different device identity');
    const reconnectPing = await invoke('android_ping');
    check(reconnectPing.authenticated === true, 'Challenge reconnect did not authenticate the device');
    record('challenge_reconnect_verified', { deviceId: reconnected.id, spki: restarted.certificateFingerprint });

    setMockLocation(31.2304, 121.4737);
    mockLocationActive = true;
    const location = await invoke('android_location');
    const locationData = location.data || {};
    check(location.success === true, `Android location failed: ${location.message || 'unknown error'}`);
    check(Math.abs(Number(locationData.latitude) - 31.2304) < 0.02, 'Android latitude did not match the injected location');
    check(Math.abs(Number(locationData.longitude) - 121.4737) < 0.02, 'Android longitude did not match the injected location');
    record('location_verified', { provider: locationData.provider, latitude: locationData.latitude, longitude: locationData.longitude });

    const notificationMarker = `OPCNexus-${Date.now()}`;
    adb('shell', 'cmd', 'notification', 'post', '-t', notificationMarker, 'opcnexus_e2e', 'mobile notification e2e');
    await delay(500);
    const notifications = await invoke('android_notifications', { limit: 20, since: Date.now() - 60_000 });
    check(notifications.listenerActive === true, 'Android notification listener is not active');
    check(
      Array.isArray(notifications.notifications) && notifications.notifications.some((item) => item.title === notificationMarker),
      'Injected Android notification was not returned by the Bridge',
    );
    record('notification_verified', { count: notifications.count });

    const micStart = await invoke('android_mic_record', { duration: 2 });
    check(micStart.status === 'starting', 'Android microphone recording did not start');
    const micStatus = await waitForMicrophone(invoke);
    const micFetch = await invoke('android_mic_fetch', { remote_path: micStatus.latest });
    check(micFetch.artifact?.kind === 'audio', 'Microphone fetch did not create an audio artifact');
    const wav = artifactHeader(userData, micFetch.artifact, 12);
    const ascii = (bytes) => String.fromCharCode(...bytes);
    check(wav.ok && wav.length > 44, 'WAV artifact is empty or inaccessible');
    check(ascii(wav.bytes.slice(0, 4)) === 'RIFF' && ascii(wav.bytes.slice(8, 12)) === 'WAVE', 'Audio artifact is not a valid WAV');
    record('wav_verified', { size: wav.length, mimeType: wav.mimeType });

    await invoke('android_open_app', { package: 'com.senke.opcnexus.bridge' });
    await delay(500);
    let row;
    for (let attempt = 0; attempt < 4 && !row; attempt += 1) {
      const screenRows = await invoke('android_find_nodes', { text: '屏幕读取', limit: 5 });
      row = screenRows.data?.nodes?.[0];
      if (!row) {
        await invoke('android_swipe', { direction: 'up', distance: 'long' });
        await delay(300);
      }
    }
    check(typeof row?.bounds === 'string', 'Could not locate the screen-capture permission row');
    const labelBounds = row.bounds.split(',').map(Number);
    check(labelBounds.length === 4 && labelBounds.every(Number.isFinite), 'Screen-capture row returned invalid bounds');
    const permissionButtons = await invoke('android_find_nodes', { text: '授权', class_name: 'android.widget.Button', clickable: true, limit: 5 });
    const labelY = (labelBounds[1] + labelBounds[3]) / 2;
    const candidates = (permissionButtons.data?.nodes || []).map((node) => ({
      node,
      bounds: String(node.bounds || '').split(',').map(Number),
    })).filter((item) => item.bounds.length === 4 && item.bounds.every(Number.isFinite));
    const permissionButton = candidates.sort((left, right) =>
      Math.abs((left.bounds[1] + left.bounds[3]) / 2 - labelY) - Math.abs((right.bounds[1] + right.bounds[3]) / 2 - labelY),
    )[0];
    check(permissionButton, 'Could not locate the screen-capture permission button');
    await invoke('android_tap', { node_id: permissionButton.node.nodeId });
    await tapAndroidNode((node) =>
      node['resource-id'] === 'android:id/button1' ||
      /Start now|立即开始|Allow|允许/i.test(node.text || ''),
    );
    await delay(750);
    await invoke('android_ping');
    const permissionDevice = await waitForPermission(
      { listMobileDevices: () => call('listMobileDevices') },
      device.id,
      'media_projection',
    );
    const recording = await invoke('android_screen_record', { duration_ms: 1500 });
    check(recording.artifact?.kind === 'screen_recording', `Screen recording failed: ${recording.message || recording.error || 'no artifact'}`);
    const mp4 = artifactHeader(userData, recording.artifact, 12);
    check(mp4.ok && mp4.length > 1024, 'MP4 artifact is empty or inaccessible');
    check(ascii(mp4.bytes.slice(4, 8)) === 'ftyp', 'Screen recording artifact is not an MP4');
    record('screen_recording_verified', { size: mp4.length, mimeType: mp4.mimeType });

    const script = await call('saveMobileScript', {
      name: 'API 34 smoke', description: 'Generated by mobile-e2e.cjs', agentId: agent.id, deviceId: device.id,
      steps: [
        { tool: 'android_ping', args: {}, delayAfterMs: 0, onFailure: 'stop' },
        { tool: 'android_press_key', args: { key: 'home' }, delayAfterMs: 100, onFailure: 'stop' },
      ],
    });
    const scriptResult = await call('runMobileScript', script.id);
    check(scriptResult.completed === 2, 'Mobile JSON DSL did not complete both steps');
    record('script_completed', { scriptId: script.id, completed: scriptResult.completed });

    const commands = await call('listMobileCommands', device.id);
    const artifacts = await call('listMobileArtifacts', device.id);
    check(commands.length >= 15, 'Mobile command log is unexpectedly short');
    check(artifacts.some((artifact) => artifact.kind === 'screenshot'), 'Screenshot artifact was not persisted');
    check(artifacts.some((artifact) => artifact.kind === 'audio'), 'WAV artifact was not persisted');
    check(artifacts.some((artifact) => artifact.kind === 'screen_recording'), 'MP4 artifact was not persisted');
    record('audit_verified', { commandCount: commands.length, artifactCount: artifacts.length });

    result.completedAt = Date.now();
    result.ok = true;
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.completedAt = Date.now();
    result.ok = false;
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    if (mockLocationActive) clearMockLocation();
    if (!KEEP) {
      rmSync(userData, { recursive: true, force: true });
      if (profileHome && existsSync(profileHome)) rmSync(profileHome, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

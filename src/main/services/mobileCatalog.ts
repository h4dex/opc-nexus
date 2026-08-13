import Ajv, { type ValidateFunction } from 'ajv';
import rawCatalog from '../../../mobile/tool-catalog.json';
import type {
  MobilePermissionName,
  MobileScriptDefinition,
  MobileScriptStep,
  MobileToolCatalog,
  MobileToolCatalogEntry,
  MobileToolName
} from '../../shared/types.js';

const EXPECTED_TOOL_COUNT = 42;
const MAX_SCRIPT_STEPS = 100;
const MAX_SCRIPT_DURATION_MS = 5 * 60_000;
const MAX_STEP_DELAY_MS = 30_000;

const catalog = rawCatalog as MobileToolCatalog;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<MobileToolName, ValidateFunction>();
const entries = new Map<MobileToolName, MobileToolCatalogEntry>();

for (const entry of catalog.tools) {
  if (entries.has(entry.name)) throw new Error(`Mobile tool catalog contains duplicate ${entry.name}`);
  entries.set(entry.name, entry);
  validators.set(entry.name, ajv.compile(entry.parameters));
}
if (entries.size !== EXPECTED_TOOL_COUNT) {
  throw new Error(`Mobile tool catalog must contain exactly ${EXPECTED_TOOL_COUNT} tools (got ${entries.size})`);
}

export const MOBILE_TOOL_NAMES = Object.freeze(catalog.tools.map((entry) => entry.name));
export const MOBILE_PROTOCOL_VERSION = catalog.protocolVersion;

export function getMobileToolCatalog(): MobileToolCatalog {
  return catalog;
}

export function getMobileTool(name: string): MobileToolCatalogEntry {
  const entry = entries.get(name as MobileToolName);
  if (!entry) throw new Error(`Unknown Android tool: ${name}`);
  return entry;
}

export function isMobileToolName(name: unknown): name is MobileToolName {
  return typeof name === 'string' && entries.has(name as MobileToolName);
}

export function validateMobileToolArgs(name: MobileToolName, args: unknown): Record<string, unknown> {
  const value = args === undefined ? {} : args;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} arguments must be an object`);
  const validator = validators.get(name)!;
  if (!validator(value)) {
    const detail = validator.errors?.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ') || 'invalid arguments';
    throw new Error(`${name}: ${detail}`);
  }
  return value as Record<string, unknown>;
}

export interface MobileBridgeCommand {
  method: 'GET' | 'POST';
  path: string;
  params: Record<string, unknown>;
  body: Record<string, unknown>;
  stream?: 'audio';
}

const GET_PATHS: Partial<Record<MobileToolName, string>> = {
  android_ping: '/ping',
  android_read_screen: '/screen',
  android_screenshot: '/screenshot',
  android_get_apps: '/apps',
  android_current_app: '/current_app',
  android_location: '/location',
  android_search_contacts: '/contacts',
  android_clipboard_read: '/clipboard',
  android_notifications: '/notifications',
  android_events: '/events',
  android_mic_status: '/mic_status',
  android_mic_fetch: '/mic_file',
  android_read_widgets: '/widgets',
  android_screen_hash: '/screen_hash'
};

const POST_PATHS: Partial<Record<MobileToolName, string>> = {
  android_tap: '/tap',
  android_tap_text: '/tap_text',
  android_type: '/type',
  android_swipe: '/swipe',
  android_scroll: '/scroll',
  android_open_app: '/open_app',
  android_press_key: '/press_key',
  android_wait: '/wait',
  android_long_press: '/long_press',
  android_drag: '/drag',
  android_pinch: '/pinch',
  android_find_nodes: '/find_nodes',
  android_describe_node: '/describe_node',
  android_diff_screen: '/diff_screen',
  android_send_sms: '/send_sms',
  android_call: '/call',
  android_media: '/media',
  android_send_intent: '/intent',
  android_broadcast: '/broadcast',
  android_clipboard_write: '/clipboard',
  android_event_stream: '/events/stream',
  android_screen_record: '/screen_record',
  android_mic_record: '/mic_start',
  android_mic_stop: '/mic_stop',
  android_speak: '/speak',
  android_speak_stop: '/stop_speaking'
};

const CAMEL_KEYS: Record<string, string> = {
  node_id: 'nodeId',
  clear_first: 'clearFirst',
  class_name: 'className',
  timeout_ms: 'timeoutMs',
  start_x: 'startX',
  start_y: 'startY',
  end_x: 'endX',
  end_y: 'endY',
  previous_hash: 'previousHash',
  duration_ms: 'durationMs',
  data: 'dataUri'
};

function bridgeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) mapped[CAMEL_KEYS[key] ?? key] = value;
  return mapped;
}

export function toMobileBridgeCommand(name: MobileToolName, args: Record<string, unknown>): MobileBridgeCommand {
  if (name === 'android_setup' || name === 'android_macro') throw new Error(`${name} is handled by OPC-Nexus`);
  const mapped = bridgeArgs(args);
  if (name === 'android_send_intent' && typeof args.package === 'string') {
    delete mapped.package;
    mapped.packageOverride = args.package;
  }
  if (name === 'android_read_screen') {
    return { method: 'GET', path: '/screen', params: { bounds: !!args.include_bounds, system_ui: !!args.include_system_ui }, body: {} };
  }
  if (name === 'android_notifications' || name === 'android_events' || name === 'android_search_contacts') {
    return { method: 'GET', path: GET_PATHS[name]!, params: mapped, body: {} };
  }
  if (name === 'android_mic_fetch') {
    return { method: 'GET', path: '/mic_file', params: { name: args.remote_path ?? '' }, body: {}, stream: 'audio' };
  }
  if (name === 'android_speak') mapped.queue = args.flush ? 0 : 1;
  const getPath = GET_PATHS[name];
  if (getPath) return { method: 'GET', path: getPath, params: mapped, body: {} };
  const postPath = POST_PATHS[name];
  if (!postPath) throw new Error(`No Android bridge route for ${name}`);
  return { method: 'POST', path: postPath, params: {}, body: mapped };
}

export function validateMobileScriptSteps(steps: unknown): MobileScriptStep[] {
  if (!Array.isArray(steps)) throw new Error('Script steps must be an array');
  if (steps.length < 1 || steps.length > MAX_SCRIPT_STEPS) throw new Error(`Script must contain 1-${MAX_SCRIPT_STEPS} steps`);
  let totalDelay = 0;
  return steps.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Step ${index + 1} must be an object`);
    const step = raw as Partial<MobileScriptStep>;
    const candidate = (raw as Record<string, unknown>).tool;
    if (!isMobileToolName(candidate) || candidate === 'android_macro' || candidate === 'android_setup') {
      throw new Error(`Step ${index + 1} has a forbidden tool`);
    }
    const tool = candidate as Exclude<MobileToolName, 'android_macro' | 'android_setup'>;
    const args = validateMobileToolArgs(tool, step.args ?? {});
    const delayAfterMs = step.delayAfterMs ?? 0;
    if (!Number.isInteger(delayAfterMs) || delayAfterMs < 0 || delayAfterMs > MAX_STEP_DELAY_MS) {
      throw new Error(`Step ${index + 1} delayAfterMs must be 0-${MAX_STEP_DELAY_MS}`);
    }
    if (step.onFailure !== undefined && step.onFailure !== 'stop' && step.onFailure !== 'continue') {
      throw new Error(`Step ${index + 1} has an invalid failure policy`);
    }
    totalDelay += delayAfterMs;
    return { tool, args, delayAfterMs, onFailure: step.onFailure ?? 'stop' } as MobileScriptStep;
  }).map((step) => {
    if (totalDelay > MAX_SCRIPT_DURATION_MS) throw new Error('Script delay budget exceeds 5 minutes');
    return step;
  });
}

export function validateMobileScript(input: Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'>): Omit<MobileScriptDefinition, 'id' | 'createdAt' | 'updatedAt'> {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new Error('Script name must be 1-80 characters');
  const description = (input.description ?? '').trim();
  if (description.length > 500) throw new Error('Script description is too long');
  return { ...input, name, description, steps: validateMobileScriptSteps(input.steps) };
}

export function assertMobilePermissions(
  entry: MobileToolCatalogEntry,
  permissions: Partial<Record<MobilePermissionName, string>>
): void {
  for (const permission of entry.permissions) {
    if (permissions[permission] !== 'granted') throw new Error(`permission_denied:${permission}`);
  }
}

export function redactMobileValue(entry: MobileToolCatalogEntry, value: unknown, result = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (result && ['android_read_screen', 'android_find_nodes', 'android_describe_node', 'android_read_widgets'].includes(entry.name)) {
    const record = value as Record<string, unknown>;
    const nodes = Array.isArray(record.tree) ? record.tree.length : Array.isArray(record.nodes) ? record.nodes.length : record.count;
    return { redacted: true, nodeCount: typeof nodes === 'number' ? nodes : undefined };
  }
  if (result && ['android_notifications', 'android_events', 'android_search_contacts', 'android_clipboard_read'].includes(entry.name)) {
    const record = value as Record<string, unknown>;
    return { redacted: true, count: typeof record.count === 'number' ? record.count : undefined };
  }
  const sensitive = new Set(entry.sensitiveFields);
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 3) return '[truncated]';
    if (Array.isArray(input)) return input.slice(0, 20).map((item) => walk(item, depth + 1));
    if (!input || typeof input !== 'object') {
      if (result && typeof input === 'string' && input.length > 128 && /^(?:data:[^,]+,)?[a-zA-Z0-9+/=_-]+$/.test(input)) {
        return '[binary redacted]';
      }
      return typeof input === 'string' && input.length > 300 ? `${input.slice(0, 300)}...` : input;
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input as Record<string, unknown>).slice(0, 40)) {
      const binaryResult = result && /^(?:image|video|audio|base64|dataUri|bytes)$/i.test(key);
      output[key] = binaryResult
        ? '[binary redacted]'
        : sensitive.has(key) || /text|body|clipboard|contact|phone|number/i.test(key) && result
          ? '[redacted]'
          : walk(nested, depth + 1);
    }
    return output;
  };
  return walk(value, 0) as Record<string, unknown>;
}

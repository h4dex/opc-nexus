import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isAllowedExternalUrl(value: string): boolean {
  if (!value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!EXTERNAL_PROTOCOLS.has(url.protocol) || url.username || url.password) return false;
    if (url.protocol === 'mailto:') return url.pathname.length > 0;
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Restrict the privileged main window to its own Renderer entry/origin. */
export function isAllowedMainNavigation(value: string, rendererEntry: string): boolean {
  try {
    const target = new URL(value);
    const allowed = new URL(rendererEntry);
    if (allowed.protocol === 'http:' || allowed.protocol === 'https:') {
      return target.protocol === allowed.protocol && target.origin === allowed.origin;
    }
    if (allowed.protocol !== 'file:' || target.protocol !== 'file:') return false;
    return resolve(fileURLToPath(target)) === resolve(fileURLToPath(allowed));
  } catch {
    return false;
  }
}

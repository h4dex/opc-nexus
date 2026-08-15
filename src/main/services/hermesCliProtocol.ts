const SESSION_LINE = /^\s*session_id:\s*(\S+)\s*$/i;
const VALID_SESSION_ID = /^[^\s]{1,200}$/;

/** Hermes quiet-chat writes the resumable session anchor to stderr. */
export function parseHermesQuietSessionId(stderr: string): string | null {
  let sessionId: string | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const candidate = SESSION_LINE.exec(line)?.[1] ?? '';
    if (VALID_SESSION_ID.test(candidate)) sessionId = candidate;
  }
  return sessionId;
}

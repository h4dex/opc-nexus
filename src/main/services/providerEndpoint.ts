const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parse and canonicalize a Provider endpoint before it can be paired with a credential. */
export function normalizeProviderBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('Provider Base URL cannot be empty');
  if (/[?#]/.test(raw)) throw new Error('Provider Base URL cannot contain a query or fragment');
  if (/[\\\r\n\t]/.test(raw)) throw new Error('Provider Base URL contains invalid characters');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Provider Base URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider Base URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Provider Base URL cannot contain credentials');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Provider Base URL must use HTTPS unless it is loopback');
  }

  return url.href.replace(/\/+$/, '');
}

export function tryNormalizeProviderBaseUrl(value: string): string | null {
  try {
    return normalizeProviderBaseUrl(value);
  } catch {
    return null;
  }
}

export function providerOriginsMatch(left: string, right: string): boolean {
  const normalizedLeft = tryNormalizeProviderBaseUrl(left);
  const normalizedRight = tryNormalizeProviderBaseUrl(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
}

export function providerResourceUrl(baseUrl: string, resource: string): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return `${normalized}/${resource.replace(/^\/+/, '')}`;
}

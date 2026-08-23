import {
  ARTIFACT_PROTOCOL_SCHEME,
  ArtifactRefError,
  type ArtifactRefService
} from './artifactRef.js';

export interface PrivilegedProtocolRegistrar {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void | Promise<void>;
}

/** Convert one authorized artifact request without exposing storage errors or paths. */
export function createArtifactProtocolHandler(service: ArtifactRefService): (request: Request) => Response {
  return (request) => {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
    }
    try {
      const resolved = service.resolveAuthorizedUrl(request.url);
      return new Response(new Uint8Array(resolved.data), { status: 200, headers: resolved.headers });
    } catch (error) {
      const code = error instanceof ArtifactRefError ? error.code : null;
      const status = code === 'ARTIFACT_GRANT_EXPIRED'
        ? 410
        : code === 'ARTIFACT_GRANT_INVALID'
          ? 403
          : code === 'ARTIFACT_NOT_FOUND' || code === 'ARTIFACT_INTEGRITY_FAILED'
            ? 404
            : code === 'INVALID_ARTIFACT'
              ? 400
              : 500;
      return new Response(status === 500 ? 'Internal error' : 'Artifact unavailable', {
        status,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
      });
    }
  };
}

/** Must be called after `app.whenReady`; scheme privileges are registered separately before ready. */
export function registerArtifactProtocol(registrar: PrivilegedProtocolRegistrar, service: ArtifactRefService): void {
  void registrar.handle(ARTIFACT_PROTOCOL_SCHEME, createArtifactProtocolHandler(service));
}

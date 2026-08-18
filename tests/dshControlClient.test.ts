import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DshAmbiguousTransportError,
  DshControlClient,
  DshRpcError,
  parseDshTypedMuxFrame,
  type DshControlFetch
} from '../src/main/services/dshControlClient.js';

class FakeSocket extends EventEmitter {
  readyState = 0;
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from('closed'));
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from('terminated'));
  });
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('DshControlClient', () => {
  it('rejects non-loopback or non-http endpoints before making a request', () => {
    expect(() => new DshControlClient('http://0.0.0.0:3080')).toThrow(/loopback/);
    expect(() => new DshControlClient('https://127.0.0.1:3080')).toThrow(/loopback/);
    expect(() => new DshControlClient('http://127.0.0.1:3080/api')).toThrow(/origin/);
  });

  it('uses the caller commandId as rpcId and validates the response echo', async () => {
    const requests: unknown[] = [];
    const fetch: DshControlFetch = async (_input, init) => {
      requests.push(JSON.parse(init.body));
      return response({
        type: 'server-response',
        rpcId: 'command-1',
        result: { ok: true, value: { accepted: true } }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });
    await expect(client.prompt({
      sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hello' }]
    }, 'command-1')).resolves.toEqual({ accepted: true });
    expect(requests).toEqual([{
      type: 'client-request', rpcId: 'command-1', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }
    }]);
  });

  it('keeps business errors distinct from ambiguous transport failures', async () => {
    const businessFetch: DshControlFetch = async () => response({
      type: 'server-response', rpcId: 'read-1',
      result: { ok: false, error: { code: 'model-unavailable', message: 'no model', details: {} } }
    });
    const business = new DshControlClient('http://127.0.0.1:3080', { fetch: businessFetch });
    await expect(business.createSession({}, 'read-1')).rejects.toBeInstanceOf(DshRpcError);

    const dropped: DshControlFetch = async () => { throw new Error('socket reset'); };
    const ambiguous = new DshControlClient('http://127.0.0.1:3080', { fetch: dropped });
    await expect(ambiguous.prompt({
      sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'side effect' }]
    }, 'mutating-1')).rejects.toBeInstanceOf(DshAmbiguousTransportError);
  });

  it('creates and lists the official workspace before binding a project session', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const workspace = {
      workspaceId: 'workspace-project-1',
      path: 'E:/projects/project-1',
      title: 'project-1',
      sessionIds: ['session-project-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z'
    };
    const fetch: DshControlFetch = async (_input, init) => {
      const request = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(request);
      const value = request.method === 'workspace.create'
        ? { workspace, created: true }
        : { items: [workspace], archivedSessionIds: [] };
      return response({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });

    await expect(client.createWorkspace(
      { path: workspace.path },
      'workspace-create-1'
    )).resolves.toEqual({ workspace, created: true });
    await expect(client.listWorkspaces()).resolves.toEqual({
      items: [workspace],
      archivedSessionIds: []
    });
    expect(requests[0]).toEqual({
      type: 'client-request', rpcId: 'workspace-create-1', method: 'workspace.create',
      payload: { path: workspace.path }
    });
    expect(requests[1]).toMatchObject({ method: 'workspace.list', payload: {} });
  });

  it('parses session history and drops malformed stream payloads by failing the stream', async () => {
    const fetch: DshControlFetch = async () => response({
      type: 'server-response', rpcId: 'history-read', result: {
        ok: true,
        value: {
          events: [{ event: {
            type: 'user/message', seq: 0, time: 123,
            data: { source: { kind: 'user-rpc', rpcId: 'cmd-1' }, content: [{ type: 'text', text: 'hi' }] }
          } }],
          hasMore: false
        }
      }
    });
    // readHistory mints a read rpc id internally, so make the response echo
    // whichever id was sent.
    const echoFetch: DshControlFetch = async (_input, init) => {
      const request = JSON.parse(init.body) as { rpcId: string };
      return response({
        type: 'server-response', rpcId: request.rpcId, result: {
          ok: true,
          value: {
            events: [{ event: {
              type: 'user/message', seq: 0, time: 123,
              data: { source: { kind: 'user-rpc', rpcId: 'cmd-1' }, content: [{ type: 'text', text: 'hi' }] }
            } }],
            hasMore: false
          }
        }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch: echoFetch });
    await expect(client.readHistory({ sessionId: 's1' })).resolves.toMatchObject({
      events: [{ event: { seq: 0, type: 'user/message' } }], hasMore: false
    });
    void fetch;
  });

  it('receives mux frames over a downstream socket and stops on abort', async () => {
    const socket = new FakeSocket();
    const client = new DshControlClient('http://127.0.0.1:3080', {
      createSocket: () => socket
    });
    const controller = new AbortController();
    const received: unknown[] = [];
    const stream = client.observeMux((frame) => { received.push(frame); }, controller.signal);
    socket.readyState = 1;
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'server-request', rpcId: 'push-1',
      payload: {
        type: 'session/event', sessionId: 's1',
        event: { type: 'turn/end', seq: 1, time: 10, data: { turn: 0, reason: { kind: 'completed' } } }
      }
    })));
    await Promise.resolve();
    controller.abort();
    await expect(stream).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(socket.close).toHaveBeenCalled();
  });

  it('parses rc.6 typed question frames and ignores unrelated mux projections', () => {
    expect(parseDshTypedMuxFrame({
      type: 'question/requested',
      sessionId: 's1',
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan?',
        detail: '# Plan\n\n- step',
        options: [{ label: 'Approve' }, { label: 'Keep planning', description: 'Revise' }],
        intent: { kind: 'plan-review', approve: 'Approve' }
      }]
    })).toEqual({
      type: 'question/requested',
      sessionId: 's1',
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan?',
        detail: '# Plan\n\n- step',
        options: [{ label: 'Approve' }, { label: 'Keep planning', description: 'Revise' }],
        intent: { kind: 'plan-review', approve: 'Approve' }
      }]
    });
    expect(parseDshTypedMuxFrame({
      type: 'question/resolved', sessionId: 's1', questionRpcId: 'q1', outcome: 'answered'
    })).toEqual({ type: 'question/resolved', sessionId: 's1', questionRpcId: 'q1', outcome: 'answered' });
    expect(parseDshTypedMuxFrame({ type: 'session/event', sessionId: 's1' })).toBeNull();
    expect(() => parseDshTypedMuxFrame({
      type: 'question/requested', sessionId: 's1', questions: []
    })).toThrow(/questions/);
  });

  it('sends the rc.6 client-response envelope and validates the carrier receipt', async () => {
    const requests: unknown[] = [];
    const fetch: DshControlFetch = async (_input, init) => {
      requests.push({ input: _input, body: JSON.parse(init.body) });
      return response({ accepted: true });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });
    await expect(client.respondQuestion({
      rpcId: 'question-rpc-1',
      sessionId: 's1',
      answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
    })).resolves.toEqual({ accepted: true });
    expect(requests).toEqual([{
      input: 'http://127.0.0.1:3080/api/respond',
      body: {
        type: 'client-response',
        rpcId: 'question-rpc-1',
        result: {
          ok: true,
          value: {
            sessionId: 's1',
            answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
          }
        }
      }
    }]);
  });

  it('uses the rc.6 cancellation result shape for dismissed questions', async () => {
    let request: Record<string, unknown> | undefined;
    const fetch: DshControlFetch = async (_input, init) => {
      request = JSON.parse(init.body) as Record<string, unknown>;
      return response({ accepted: false, reason: 'not-pending' });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });
    await expect(client.cancelQuestion({ rpcId: 'q-cancel' })).resolves.toEqual({ accepted: false, reason: 'not-pending' });
    expect(request).toMatchObject({
      type: 'client-response', rpcId: 'q-cancel', result: {
        ok: false, error: { code: 'cancelled', message: 'cancelled by owner', details: {} }
      }
    });
  });

  it('reads the rc.6 model directory and selects a complete session model', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch: DshControlFetch = async (_input, init) => {
      const request = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(request);
      const method = request.method;
      const value = method === 'session.models'
        ? {
            current: { provider: 'deepseek-official', model: 'deepseek-chat' },
            routable: true,
            groups: [{
              id: 'deepseek-official', name: 'DeepSeek', models: [{
                id: 'deepseek-reasoner', name: 'Reasoner',
                reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
              }]
            }],
            failures: []
          }
        : { selected: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' } };
      return response({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });

    await expect(client.models({ sessionId: 's1' })).resolves.toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      routable: true,
      groups: [{ models: [{ reasoning: { defaultEffort: 'high' } }] }]
    });
    await expect(client.selectModel({
      sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high'
    }, 'select-model-1')).resolves.toEqual({
      selected: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' }
    });
    expect(requests[0]).toMatchObject({ method: 'session.models', payload: { sessionId: 's1' } });
    expect(requests[1]).toEqual({
      type: 'client-request', rpcId: 'select-model-1', method: 'session.selectModel',
      payload: {
        sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high'
      }
    });
  });

  it('treats an invalid selectModel receipt as ambiguous because the mutation may have applied', async () => {
    const fetch: DshControlFetch = async (_input, init) => {
      const request = JSON.parse(init.body) as { rpcId: string };
      return response({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { selected: { provider: 'deepseek-official' } } }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });
    await expect(client.selectModel({
      sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-reasoner'
    }, 'select-model-bad-receipt')).rejects.toBeInstanceOf(DshAmbiguousTransportError);
  });

  it('treats an invalid createSession receipt as ambiguous because the mutation may have applied', async () => {
    const fetch: DshControlFetch = async (_input, init) => {
      const request = JSON.parse(init.body) as { rpcId: string };
      return response({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { sessionId: 's1' } }
      });
    };
    const client = new DshControlClient('http://127.0.0.1:3080', { fetch });
    await expect(client.createSession({
      sessionId: 's1', agentPreset: 'cordis'
    }, 'create-session-bad-receipt')).rejects.toMatchObject({
      name: 'DshAmbiguousTransportError',
      method: 'session.create',
      rpcId: 'create-session-bad-receipt',
      requestMayHaveBeenApplied: true
    });
  });
});

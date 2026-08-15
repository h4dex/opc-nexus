// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./__mocks__/electron.js'));
vi.mock('../src/main/services/notifier.js', () => ({ notify: vi.fn() }));

const sdk = vi.hoisted(() => ({
  instances: [] as any[],
  start: vi.fn(async () => {}),
  chatList: vi.fn(async () => ({})),
  messageCreate: vi.fn(async () => ({}))
}));

const channelCommon = vi.hoisted(() => ({
  dispatchChannelTask: vi.fn(),
  tryChannelApproval: vi.fn(() => false),
  tryChannelCommand: vi.fn(() => false)
}));

vi.mock('../src/main/services/channels/common.js', () => channelCommon);

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      v1: {
        chat: { list: sdk.chatList },
        message: { create: sdk.messageCreate }
      }
    };
  }

  class EventDispatcher {
    register(handlers: Record<string, unknown>) {
      return { handlers };
    }
  }

  class WSClient {
    close = vi.fn();
    state = 'connected';

    constructor() {
      sdk.instances.push(this);
    }

    async start(params: unknown) {
      await sdk.start(params);
    }

    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    }
  }

  return {
    Client,
    EventDispatcher,
    WSClient,
    LoggerLevel: { error: 'error' }
  };
});

import { FeishuChannel } from '../src/main/services/channels/feishuChannel.js';

class FakeDb {
  settings = new Map<string, unknown>();
  statuses: string[] = [];
  audit = vi.fn();

  getSetting<T>(key: string, fallback: T): T {
    return this.settings.has(key) ? this.settings.get(key) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value);
  }

  raw = {
    prepare: (_sql: string) => ({
      run: (status: string) => {
        this.statuses.push(status);
        return { changes: 1 };
      },
      get: () => undefined
    })
  };
}

function makeChannel() {
  const db = new FakeDb();
  const channel = new FeishuChannel(db as never, {} as never, { dispatch: vi.fn() });
  channel.saveCredentials('cli_0123456789abcdef', 'app-secret');
  return { channel, db };
}

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.start.mockReset().mockResolvedValue(undefined);
  sdk.chatList.mockReset().mockResolvedValue({});
  sdk.messageCreate.mockReset().mockResolvedValue({});
  channelCommon.dispatchChannelTask.mockReset();
  channelCommon.tryChannelApproval.mockReset().mockReturnValue(false);
  channelCommon.tryChannelCommand.mockReset().mockReturnValue(false);
});

describe('FeishuChannel WebSocket lifecycle', () => {
  it('waits for start before reporting ONLINE and force-closes on disconnect', async () => {
    let finishStart!: () => void;
    sdk.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const { channel, db } = makeChannel();

    const connecting = channel.connect();
    await vi.waitFor(() => expect(sdk.instances).toHaveLength(1));
    expect(channel.isActive()).toBe(false);
    expect(db.statuses.at(-1)).toBe('CONNECTING');

    finishStart();
    await expect(connecting).resolves.toMatchObject({ ok: true });
    expect(channel.isActive()).toBe(true);
    expect(db.statuses.at(-1)).toBe('ONLINE');

    channel.disconnect();
    expect(sdk.instances[0].close).toHaveBeenCalledWith({ force: true });
    expect(channel.isActive()).toBe(false);
    expect(db.statuses.at(-1)).toBe('DISABLED');
  });

  it('closes the previous client before replacing a connection', async () => {
    const { channel } = makeChannel();

    await channel.connect();
    await channel.connect();

    expect(sdk.instances).toHaveLength(2);
    expect(sdk.instances[0].close).toHaveBeenCalledWith({ force: true });
    expect(sdk.instances[1].close).not.toHaveBeenCalled();
  });

  it('does not revive a connection whose pending start was disconnected', async () => {
    let finishStart!: () => void;
    sdk.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const { channel, db } = makeChannel();

    const connecting = channel.connect();
    await vi.waitFor(() => expect(sdk.instances).toHaveLength(1));
    channel.disconnect();
    finishStart();

    await expect(connecting).resolves.toMatchObject({ ok: false, message: '飞书连接已取消' });
    expect(sdk.instances[0].close).toHaveBeenCalledWith({ force: true });
    expect(channel.isActive()).toBe(false);
    expect(db.statuses.at(-1)).toBe('DISABLED');
  });

  it('releases the client on process disposal without changing reconnect state', async () => {
    const { channel, db } = makeChannel();

    await channel.connect();
    channel.dispose();

    expect(sdk.instances[0].close).toHaveBeenCalledWith({ force: true });
    expect(channel.isActive()).toBe(false);
    expect(db.statuses.at(-1)).toBe('ONLINE');
  });

  it('passes full text and stable identity scope to common ingress while truncating only platform replies', async () => {
    const { channel } = makeChannel();
    await channel.connect();
    const longText = `${'飞书长消息'.repeat(6_000)}END`;
    const startOptions = sdk.start.mock.calls[0][0];
    const receive = startOptions.eventDispatcher.handlers['im.message.receive_v1'];

    await receive({
      sender: {
        sender_id: { open_id: 'ou_sender', user_id: 'user_sender', union_id: 'on_sender' },
        sender_type: 'user',
        tenant_key: 'tenant-1'
      },
      message: {
        message_id: 'om_message_1',
        chat_id: 'oc_chat_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: longText })
      }
    });

    expect(channelCommon.dispatchChannelTask).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'ch-feishu',
      text: longText,
      externalIdentity: 'ou_sender',
      externalIdentityDisplayName: 'user_sender',
      conversationKey: 'chat:oc_chat_1',
      sourceKey: 'om_message_1',
      metadata: {
        chatType: 'group',
        messageType: 'text',
        senderType: 'user',
        tenantKey: 'tenant-1'
      }
    }));

    const dispatch = channelCommon.dispatchChannelTask.mock.calls[0][0];
    dispatch.final('R'.repeat(2_500));
    await vi.waitFor(() => expect(sdk.messageCreate).toHaveBeenCalledTimes(1));
    const payload = sdk.messageCreate.mock.calls[0][0];
    expect(JSON.parse(payload.data.content).text).toHaveLength(2_000);
  });
});

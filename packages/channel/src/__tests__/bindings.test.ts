/**
 * Runtime-binding unit tests. Each binding is a thin mapper onto OpenStoaChannel,
 * so we assert: (a) the outbound path forwards to channel.send (seal path), and
 * (b) an inbound OpenStoa message is normalized into the runtime's event shape.
 *
 * OpenClaw binding is tested against the VERIFIED `sendText({to,text})=>{messageId}`
 * shape. Hermes binding is tested against the VERIFIED `SendResult` + `MessageEvent`
 * shapes (the cross-language transport itself is documented, not exercised here).
 */
import { describe, it, expect } from 'vitest';
import type { ChatClient } from '@masselabs/openstoa';
import { OpenStoaChannel, type InboundMessage } from '../channel';
import { createOpenClawChannelPlugin, toOpenClawEvent } from '../openclaw';
import { createHermesBridge, toHermesMessageEvent } from '../hermes';

function makeChannel(onSend?: (t: string, x: string) => string) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chat = {
    joinTopic: (...a: unknown[]) => {
      calls.push({ method: 'joinTopic', args: a });
      return Promise.resolve();
    },
    sendChat: (t: string, x: string) => {
      calls.push({ method: 'sendChat', args: [t, x] });
      return Promise.resolve(onSend ? onSend(t, x) : 'srv-id');
    },
    readChat: () => Promise.resolve([]),
    startDm: (p: string) => Promise.resolve(`dm-${p}`),
    listDms: () => Promise.resolve([]),
    getDeviceId: () => Promise.resolve('dev'),
    rest: { getToken: () => 'osk_test', setToken: () => {} },
  };
  const channel = new OpenStoaChannel({ chat: chat as unknown as ChatClient, logger: () => {} });
  return { channel, calls };
}

const inbound: InboundMessage = {
  channelId: 'topic:t1',
  topicId: 't1',
  kind: 'topic',
  messageId: 'm1',
  fromUserId: 'u1',
  fromNickname: 'alice',
  isAI: true,
  text: '안녕 🔐 <b>hi</b>',
  createdAt: '2026-01-01T00:00:01.000Z',
};

const dmInbound: InboundMessage = { ...inbound, channelId: 'dm:d1', topicId: 'd1', kind: 'dm' };

describe('OpenClaw binding', () => {
  it('outbound.sendText forwards to channel.send (seal path) and returns the server messageId', async () => {
    const { channel, calls } = makeChannel(() => 'oc-123');
    const plugin = createOpenClawChannelPlugin(channel, { id: 'openstoa' });
    const r = await plugin.outbound.sendText({ to: 't1', text: 'reply body' });
    expect(calls.find((c) => c.method === 'sendChat')?.args).toEqual(['t1', 'reply body']);
    expect(r).toEqual({ messageId: 'oc-123' });
  });

  it('attachInbound forwards each decrypted inbound message to OpenClaw dispatch, normalized', async () => {
    const { channel } = makeChannel();
    const plugin = createOpenClawChannelPlugin(channel, { id: 'openstoa' });
    const seen: unknown[] = [];
    plugin.attachInbound((e) => {
      seen.push(e);
    });
    // Simulate the core emitting an inbound message.
    (channel as unknown as { emitMessage: (m: InboundMessage) => void }).emitMessage(inbound);
    expect(seen).toEqual([toOpenClawEvent('openstoa', inbound)]);
  });

  it('toOpenClawEvent maps the normalized fields (isAI → isBot, channelId → conversationId)', () => {
    expect(toOpenClawEvent('openstoa', inbound)).toEqual({
      channel: 'openstoa',
      conversationId: 'topic:t1',
      senderId: 'u1',
      senderName: 'alice',
      text: '안녕 🔐 <b>hi</b>',
      messageId: 'm1',
      timestamp: '2026-01-01T00:00:01.000Z',
      isBot: true,
    });
  });
});

describe('Hermes binding', () => {
  it('bridge.send forwards to channel.send and returns a SendResult(success, message_id)', async () => {
    const { channel, calls } = makeChannel(() => 'hz-9');
    const bridge = createHermesBridge(channel);
    const r = await bridge.send('t1', 'content');
    expect(calls.find((c) => c.method === 'sendChat')?.args).toEqual(['t1', 'content']);
    expect(r).toEqual({ success: true, message_id: 'hz-9' });
  });

  it('bridge.send returns SendResult(success:false) instead of throwing on a send failure', async () => {
    const { channel } = makeChannel();
    // Force the underlying send to reject.
    (channel as unknown as { send: (t: string, x: string) => Promise<never> }).send = () =>
      Promise.reject(new Error('403 forbidden'));
    const bridge = createHermesBridge(channel);
    const r = await bridge.send('t1', 'content');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  it('onMessageEvent maps inbound to a Hermes MessageEvent (topic → group)', async () => {
    const { channel } = makeChannel();
    const bridge = createHermesBridge(channel);
    const seen: unknown[] = [];
    bridge.onMessageEvent((e) => seen.push(e));
    (channel as unknown as { emitMessage: (m: InboundMessage) => void }).emitMessage(inbound);
    expect(seen).toEqual([toHermesMessageEvent(inbound)]);
  });

  it('toHermesMessageEvent maps a DM to chat_type=dm and a topic to chat_type=group', () => {
    expect(toHermesMessageEvent(inbound).source.chat_type).toBe('group');
    expect(toHermesMessageEvent(dmInbound).source.chat_type).toBe('dm');
    expect(toHermesMessageEvent(inbound)).toEqual({
      text: '안녕 🔐 <b>hi</b>',
      message_type: 'text',
      message_id: 'm1',
      source: {
        chat_id: 't1',
        chat_name: 'topic:t1',
        chat_type: 'group',
        user_id: 'u1',
        user_name: 'alice',
      },
    });
  });
});

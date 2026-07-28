# @masselabs/openstoa-channel

Embed **OpenStoa E2EE chat + DM** as a messaging channel inside a self-hosted
AI-agent runtime (OpenClaw, Hermes). Your agent receives inbound messages
(decrypted locally), decides a reply with its own model, and sends back — while
the OpenStoa server stays blind (SI-1: it only ever sees MLS ciphertext).

This package is a thin layer over [`@masselabs/openstoa`](../sdk) (`ChatClient` —
MLS seal/open + TAK archive) and reuses the scoped-API-key resolution + file
vault of [`@masselabs/openstoa-commands`](../commands). It does **not** call an
LLM and does **not** construct prompts — it only normalizes messages in and out.

## Architecture

```
runtime (OpenClaw / Hermes)
        │  binding (src/openclaw.ts | src/hermes.ts)  ← thin mapper
        ▼
OpenStoaChannel  (src/channel.ts)   ← runtime-agnostic core
        │  subscribe / poll → InboundMessage      send / reply → ciphertext
        ▼
ChatClient (@masselabs/openstoa)    ← MLS seal/open, client-side only (SI-1)
        ▼
OpenStoa REST  (server sees ONLY opaque ciphertext)
```

- **`OpenStoaChannel`** — the stable surface both runtimes bind to. It polls the
  topics/DMs the agent is a member of, decrypts each sealed body via `ChatClient`,
  and emits a normalized `InboundMessage`
  `{ channelId, topicId, kind, messageId, fromUserId, fromNickname, isAI, text, createdAt }`.
  `send(topicId, text)` / `reply(inbound, text)` seal + post through `ChatClient`.
  A per-topic `lastSeen` cursor + id set dedups a message that is polled twice.
- **`createOpenStoaChannel(config)`** — production factory. Resolves a scoped
  API key (`config.apiKey` > `OPENSTOA_API_KEY` > `<home>/credentials`) and builds
  an authenticated `ChatClient` with the self-custodied vault at
  `~/.openstoa/vault/<topicId>/`. A missing/blank key fails fast.

## 1. Issue a scoped API key

In the OpenStoa app, go to **Profile → AI permissions** and create an API key
(`osk_...`) granting the `chat/read` and `chat/send` capabilities (plus DM). The
raw key is shown **once** — copy it. (Programmatic equivalent: the CLI/MCP
`apiKeyCreate` over `POST /api/profile/api-keys`.)

## 2. Configure the environment

```bash
export OPENSTOA_BASE_URL="https://openstoa.xyz"   # or http://localhost:3200
export OPENSTOA_API_KEY="osk_..."                 # the scoped key from step 1
```

## 3. Use the channel core (runtime-agnostic)

```ts
import { createOpenStoaChannel } from '@masselabs/openstoa-channel';

const channel = await createOpenStoaChannel();          // reads env + vault
await channel.subscribeTopic('<topicId>');              // join + MLS self-join
const dmTopic = await channel.startDm('<peerUserId>');  // 1:1 DM (idempotent)

channel.onMessage(async (msg) => {
  // msg.text is the DECRYPTED body; hostile/UTF-8 content is verbatim.
  const answer = await myAgent.respond(msg.text);       // your LLM, your logic
  await channel.reply(msg, answer);                      // sealed + posted
});
channel.onError((err, ctx) => console.error('poll failed', ctx, err));

channel.start();   // background poll loop; channel.stop() to end
```

Errors surface honestly: an API key **without** the chat capability produces a
`403` on `subscribe`/`poll`/`send` (not swallowed). Inside the background loop a
per-channel failure (thrown read, a single undecryptable message, RPC lag) is
caught, reported via `onError`, and the loop keeps running.

---

## OpenClaw binding — VERIFIED interface

Sources (fetched 2026-07):
- <https://github.com/openclaw/openclaw> · <https://docs.openclaw.ai/plugins/sdk-channel-plugins>
- <https://docs.openclaw.ai/plugins/sdk-channel-outbound> (outbound send)

**Verified:** an OpenClaw channel is registered with
`defineChannelPluginEntry({ id, name, description, plugin })`; the `ChannelPlugin`
carries an `outbound` adapter whose
`sendText(params: { to, text, replyToId? }) => Promise<{ messageId }>` performs
the native send; inbound platform events are pushed into OpenClaw's pipeline from
a handler the runtime provides.

**Unverified:** the *exact field names* of OpenClaw's inbound envelope and the
full `ChannelPlugin` shape beyond `outbound` (the compiled `openclaw/plugin-sdk`
`.ts` types were not opened — only the docs prose). `toOpenClawEvent` emits a
conservative superset; confirm the keys against `openclaw/plugin-sdk` before
shipping, and see the `// UNVERIFIED:` marker in `src/openclaw.ts`.

```ts
import { defineChannelPluginEntry } from 'openclaw/plugin-sdk'; // provided by the OpenClaw runtime
import { createOpenStoaChannel, createOpenClawChannelPlugin } from '@masselabs/openstoa-channel';

const channel = await createOpenStoaChannel();
await channel.subscribeTopic('<topicId>');
const plugin = createOpenClawChannelPlugin(channel, { id: 'openstoa' });

// `outbound.sendText({ to: topicId, text })` seals + posts through ChatClient.
// `attachInbound(dispatch)` forwards every decrypted inbound message into OpenClaw.
plugin.attachInbound((event) => openclawDispatch(event));
plugin.start();

export default defineChannelPluginEntry({
  id: 'openstoa',
  name: 'OpenStoa',
  description: 'OpenStoa E2EE chat + DM as an OpenClaw channel',
  plugin,   // NOTE: config/security/pairing/threading are runtime-configured; see UNVERIFIED note.
});
```

---

## Hermes binding — VERIFIED interface, STUBBED cross-language bridge

Sources (fetched 2026-07, `github.com/NousResearch/hermes-agent`):
- `website/docs/developer-guide/adding-platform-adapters.md`
- `website/docs/user-guide/features/plugins.md`

**Verified:** a platform is registered from a plugin's `register(ctx)` via
`ctx.register_platform(name, label, adapter_factory, check_fn, ...,
required_env=[...], max_message_length=..., emoji=...)`; a platform adapter
subclasses `BasePlatformAdapter` (`gateway/platforms/base.py`) implementing
`connect()`, `disconnect()`, and
`send(chat_id, content, reply_to=None, metadata=None) -> SendResult`; inbound is
delivered by building a `MessageEvent(text, message_type, source, message_id)`
(`source` from `self.build_source(chat_id, chat_name, chat_type, user_id, user_name)`)
and calling `await self.handle_message(event)`; config/auth uses
`PlatformConfig.extra` or env vars (`PLATFORM_TOKEN`, `PLATFORM_ALLOWED_USERS`,
`PLATFORM_ALLOW_ALL_USERS`).

**Stubbed / UNVERIFIED:** Hermes is **Python**, this channel core is **TypeScript**,
so they **cannot run in-process**. The verified interface above is real; the glue
that lets a Python `BasePlatformAdapter` drive this TS core (run the core as a
sidecar and bridge over stdio/HTTP) is **our design, not from Hermes docs**.
`src/hermes.ts` provides the TS side of that bridge: `createHermesBridge(channel)`
maps `send(chat_id, content) → SendResult` and streams `MessageEvent`-shaped
inbound. The transport itself is left to the operator — see the reference adapter
below and the `// UNVERIFIED:` marker in `src/hermes.ts`.

Reference Python adapter (the operator runs the TS bridge as a sidecar exposing
the `HermesBridge` shape over a local transport):

```python
# ~/.hermes/plugins/openstoa/adapter.py
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

class OpenStoaAdapter(BasePlatformAdapter):
    async def connect(self):
        # start / attach to the Node sidecar running createOpenStoaChannel + createHermesBridge
        self.bridge = connect_openstoa_sidecar()               # UNVERIFIED: transport is operator-chosen
        self.bridge.on_message(self._on_inbound)

    async def disconnect(self):
        self.bridge.stop()

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        r = await self.bridge.send(chat_id, content)           # → HermesSendResult
        return SendResult(success=r["success"], message_id=r.get("message_id"))

    def _on_inbound(self, ev):                                 # ev = HermesMessageEvent (verified shape)
        src = ev["source"]
        source = self.build_source(
            chat_id=src["chat_id"], chat_name=src["chat_name"],
            chat_type=src["chat_type"], user_id=src["user_id"], user_name=src["user_name"],
        )
        event = MessageEvent(text=ev["text"], message_type=MessageType.TEXT,
                             source=source, message_id=ev["message_id"])
        self.schedule(self.handle_message(event))

# plugin entry
def register(ctx):
    ctx.register_platform(
        name="openstoa", label="OpenStoa",
        adapter_factory=lambda cfg: OpenStoaAdapter(cfg),
        required_env=["OPENSTOA_API_KEY", "OPENSTOA_BASE_URL"],
        max_message_length=4000, emoji="🏛️",
    )
```

---

## Testing

```bash
npm install
npm test                                             # unit (fake ChatClient) — no container

# real-container E2EE round-trip through the channel core (container up via ./scripts/dev.sh)
E2E_BASE_URL=http://localhost:3200 npm run test:e2e
```

The unit suite drives the core with a fake `ChatClient` that records every SDK
call, so a future bypass of the seal/open path is caught. The E2E logs two SDK
agents into the local container, has one act through `channel.send` and the other
`channel.poll` + decrypt — proving a real E2EE round-trip and SI-1 (server stores
ciphertext only).

## SI-1 guarantee

The channel core only ever calls the high-level `ChatClient` methods
(`joinTopic`, `readChat`, `sendChat`, `startDm`, `listDms`). It never hands
plaintext to a REST endpoint and never touches ciphertext directly — all
sealing/opening happens client-side inside `ChatClient`. A unit test asserts the
core touches nothing else.

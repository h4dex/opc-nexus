# DSH Vision Tool Boundary

`src/main/services/visionService.ts` is the built-in vision capability. It
keeps the v2 plugin boundary explicit:

- DSH/Cordis owns the `vision.describe` tool and decides when to call it.
- `opc-nexus-governance` owns attachment policy, Provider/model binding,
  size/pixel limits and audit projection; `aibox-native-host` performs the
  credential, file and network operations.
- Renderer and LAN callers exchange `VisionAttachmentRef`, never a host path,
  raw base64 payload, Provider key, or arbitrary URL.

## Contract

`DSH_VISION_PLUGIN_MANIFEST` declares:

```text
owner = dsh-cordis
capability = vision.describe (tool)
permissions = artifact.read + engine.use + network.request
```

The tool intentionally has no `executionAdapter`: that field is reserved for
worker transports such as Hermes/Codex/Pi CLI, ACP, and A2A. DSH invokes the
tool while the Main-process Host Contract acts only as the guarded proxy.
Its risk is `write`, because invoking it sends the selected attachment to the
configured external Provider even though it does not modify local task state.

The handler accepts `{ attachmentRef, prompt? }`. `path`, `data`, and `url`
inputs are rejected. Attachments are content addressed as
`vision-<sha256>` and stored below the application-owned vision directory.
Reads re-check `lstat`, byte count, hash, and image magic bytes.

The configured binding stores only `providerId`, `model`, `enabled`, and an
update timestamp in the settings table. The injected Provider resolver is the
only component allowed to obtain the credential. Requests use the OpenAI Chat
vision shape and are bounded below the 10 MiB credential-proxy limit; returned
results contain no endpoint or credential fields.

## Current Wiring

The v2 bootstrap now:

1. Creates the service under `userData/aibox-data/vision-attachments` with the
   existing `ProviderManager` and `Database`.
2. Registers and attaches `DSH_VISION_PLUGIN_MANIFEST` through `PluginHost`.
3. Exposes dedicated typed IPC/preload methods for binding configuration,
   Main-owned image selection, content-addressed ingest and description; it
   exposes neither `fs`, arbitrary paths nor a generic invoke bridge.
4. Provides a Settings control for Provider/model selection and a real image
   test while returning only renderer-safe binding state.
5. Routes description through the plugin handler. Legacy arbitrary-path OCR
   fails closed and instructs callers to use the shared attachment reference.

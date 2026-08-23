# Plugin and Runtime Boundary

This document records the v2 boundary for DSH/Cordis plugins and optional
native components. DSH/Cordis is the product kernel. The former OPC-Nexus
feature set is the built-in `opc-nexus-governance` Cordis plugin; the
privileged Electron side is a non-AI `aibox-native-host`, not another core.

## One plugin catalog

`PluginCatalogService`, exposed by `opc-nexus-governance`, is a read-only projection over the authoritative
sources below:

- `host`: in-process `CapabilityRegistry` manifests and attached handlers;
- `dsh`: the integrity-checked managed DSH package profile;
- `mcp`: legacy MCP server records (the MCP manager still owns processes);
- `skill`: legacy database Skills (the Skill manager still owns content and
  bindings).
- `cli`: Codex, Hermes, Pi, Claude Code and OpenCode worker adapters projected
  from `EngineManager`;
- `acp`: external ACP engines and reviewed ACP host declarations;
- `a2a`: reviewed A2A host declarations selected by DSH/Cordis.

The catalog exposes the lifecycle vocabulary `missing | installed | disabled |
review | live | restart | broken`. Installation, enablement and an attached
execution handler are separate facts. An unrecognized or declaration-only
plugin cannot be reported as `live` and cannot be invoked by `PluginHost`.

The Renderer receives only `PluginCatalogView`. It does not receive MCP
commands/arguments, environment values, Skill bodies, package manifests, or
credentials. The generic enable/disable action is intentionally limited to
Host, MCP, and Skill entries. DSH package activation remains a reviewed
managed-profile operation and cannot be changed by the generic toggle.

## Native extensions

Native modules are optional capabilities declared by Main-side code with
`NativeExtensionDeclaration`:

- paths are relative to explicitly trusted roots;
- symlinks and path traversal are rejected;
- platform and architecture constraints are checked;
- expected library suffixes (`.dll`, `.so`, `.dylib`, `.node`) are checked;
- detection only calls `lstat`; it never imports, `dlopen`s, or executes a
  native library.

This keeps a bad or incompatible addon from blocking the UI process. A plugin
may report `missing`, `platform unsupported`, or `architecture unsupported`
and select a WASM/JS fallback. `NativeAdapterHost` only dispatches native modes
to an injected Electron utility-process transport and WASM/JS modes to an
injected worker-thread transport. It never imports or dlopens a library in
Main or Renderer.

## Runtime selection

`EnvironmentDiagnosticsService` reports the always-available Electron-bundled
Node/Chromium runtime, the prepared DSH managed profile, optional system
toolchains (Node/npm/Python/Git), ffmpeg and local worker CLIs. The bundled
runtime is the default for first-run and managed DSH execution. A requested
system runtime that is unavailable explicitly falls back to bundled and writes
an audit event; presence never authorizes a plugin or transfers credentials.

## Artifact references

`ArtifactRefService` covers image, video, audio, Mermaid, chart, Markdown and
file artifacts with one content-addressed DTO. It validates kind/MIME/magic,
stores bytes under an application-owned root and issues short-lived opaque
`aibox-artifact:` grants. The scheme is privileged before `app.whenReady`, and
its protocol handler is installed after ready. Renderer receives no host path;
expired, forged or integrity-failed grants are rejected with no-store and
nosniff responses.

Required components determine the renderer-safe `ready` flag. Missing optional
components are warnings and can be repaired or disabled without preventing the
desktop shell from opening.

## Ownership

The catalog is descriptive and does not become a second orchestrator. DSH/
Cordis owns planning, Session/Run/Schedule state, subagent lifecycle and worker
dispatch. `opc-nexus-governance` owns project policy, employee/channel catalogs,
approvals, audit and compatibility projections. `aibox-native-host` performs
safeStorage, file, network, process, database and native operations through a
versioned Host Contract; it has no planning or dispatch role. MCP, Skill and
native worker managers remain replaceable adapters behind those boundaries.

## Quest community pack

The ten-part Quest community pack is a governed inventory, not an auto-load
list. Exact package versions or immutable Git commits, DSH compatibility and
runtime boundaries are projected by `DshCommunityPluginService`. The default
enabled count is zero. Profile plugins needing explicit host access, Main
adapter candidates, standalone clients and blocked/incompatible sources remain
visible without receiving execution authority. See
`docs/QUEST-DEFAULT-PLUGIN-PACK.md`.

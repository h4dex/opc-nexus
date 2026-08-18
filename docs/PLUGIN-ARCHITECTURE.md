# OPC-Nexus Plugin Boundary

## Scope

`src/main/services/pluginHost.ts` provides a small, declarative registry for
optional Cordis capabilities backed by Main-process adapters. A manifest can declare six capability families:

- `engine`: an execution-engine adapter
- `tool`: a model-callable tool
- `skill`: a prompt/skill bundle
- `artifact`: a typed output or media handler
- `channel`: an inbound or outbound message adapter
- `a2a`: an A2A or ACP transport adapter

Every manifest has an explicit `owner` boundary. The normalized default is
`dsh-cordis`: DSH/Cordis is the single user-facing main AI and orchestrator.
`nexus-governance` identifies capabilities exported by the built-in
`opc-nexus-governance` Cordis plugin. There is no `nexus-secretary` owner, no
implicit Nexus planning role and no second product kernel. A capability cannot
override its manifest owner.

Execution is a separate concern. `executionAdapter` values such as
`hermes-cli`, `codex-cli`, `pi-cli`, `local-cli`, `acp`, and `a2a` identify a
worker transport selected by DSH/Cordis; they do not gain orchestration or
governance authority. The owner and adapter are carried into the permission
resolver and invocation context so policy can audit the distinction.

The registry validates manifest schema, plugin and capability semver, host API
range, identifiers, metadata bounds, duplicate IDs, and a fixed permission
vocabulary. Capability permissions must be declared by the plugin and are
checked again by `PluginHost` before every invocation.

## Ownership Boundary

The non-AI `aibox-native-host` deliberately does **not** expose a database, `safeStorage`, audit
writer, Agent/Task state transition, or arbitrary `ipcRenderer` bridge to a
plugin. Secrets remain behind the existing provider/credential services;
approvals and audit remain behind the governance plugin's versioned contracts; and
engine, channel, and skill managers remain authoritative for their entities.

Registering a manifest is only a declaration. This first slice does not load
packages from npm or disk, execute untrusted entrypoints, install plugins, or
publish new IPC channels. An adapter explicitly attaches a handler to a
registered capability. DSH/Cordis owns orchestration and selects the execution
adapter; `opc-nexus-governance` supplies policy and `aibox-native-host` supplies
the credential and process boundary.
The handler receives only input, an abort signal, and immutable identity
metadata. A permission resolver supplied by the host must allow every declared
permission; missing, failing, or denying policy fails closed.

## Incremental Adoption

Existing managers can adopt the registry without moving their state machines:

1. The engine manager may publish an `engine` descriptor while continuing to
   own installation and `EngineStatus` transitions. DSH/Cordis can select a
   matching CLI/ACP adapter from that descriptor.
2. The tool/skill managers may publish descriptors while continuing to own
   tool schemas, skill content, and Agent bindings.
3. Artifact and channel adapters may publish descriptors while the deliverable
   and channel control planes retain persistence, authentication, and audit.
4. A2A/ACP adapters may publish transport descriptors while DSH/Cordis retains
   session planning and child-agent coordination; `opc-nexus-governance`
   retains policies, approvals and compatibility projections, while the thin
   host retains credentials and process isolation.

The application registers `opc-nexus-governance` and the DSH-owned Vision tool
at startup. Registration is still only declaration: `PluginHost` reports a
capability as `live` only after Main explicitly attaches a handler, and checks
permissions again on every invocation. CLI and ACP rows are read-only
projections of `EngineManager`; A2A/ACP manifest declarations remain `review`
until a concrete handler is attached. This preserves one source of truth and
prevents an unknown or merely installed package from executing automatically.

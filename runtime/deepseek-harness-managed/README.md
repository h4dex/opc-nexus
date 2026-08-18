# DeepSeek Harness Managed Runtime

This directory defines the pinned full DeepSeek Harness Web runtime prepared
for the future OPC-Nexus managed execution path. It is separate from
`runtime/deepseek-harness`, which remains the restricted ACP compatibility
runtime.

The prepared runtime is supervised by the Electron native host, remains
loopback-only, and is reused by the isolated desktop Workbench and authenticated
LAN gateway. DSH/Cordis owns the conversation, plan, goal, job, and child-agent
facts; `opc-nexus-governance` supplies the bounded host policy and projections.

## Prepare and verify

Run from the repository root with Node `^22.19.0 || >=24.0.0` and npm
`>=11.16.0`:

```powershell
npm run harness:managed:prepare
npm run harness:managed:verify
npm run harness:managed:probe
```

Preparation installs the locked production dependency closure in a temporary
staging directory, verifies package integrity and the reviewed capability
fixture, then atomically publishes `dist/`. The generated `dist/` is
platform-specific, ignored by Git, and must not be edited directly.

Lifecycle scripts are fail-closed through npm `allowScripts`. The reviewed
runtime permits only Koffi's prebuilt selector, node-pty's platform prebuilt
selector/cleanup, and DSH's executable-bit repair for node-pty's Unix spawn
helper. The unrelated Google GenAI and protobufjs lifecycle scripts are denied.

The capability fixture distinguishes installed packages from the packages
actually authorized in every managed preset. Jobs, Goals, Plan mode, Ask User,
Todo, and bounded in-process Subagents are enabled. Package presence alone does
not authorize any other capability.

The build verifies the pinned SHA-256 of all four shipped preset compositions,
then replaces them with the reviewed governed variants under `opc-managed/`.
The variants retain a depth-2 delegation cap, four concurrent jobs per owner,
and bounded completion wakeups. Shell, raw filesystem access, workflows, Web
fetch, package installation, skill-directory loading, and runtime authoring stay
unavailable until a versioned governance/host contract explicitly grants them.
The managed Web profile also disables DSH's native directory picker. Quest
creates each upstream Session with the Main-approved project cwd, avoiding the
Koffi picker worker used by upstream desktop builds on Windows. Preparation
applies the minimal reviewed `dsh-desktop` API-proxy contract for this shape:
`directoryPicker` is an optional Host service and its three RPC methods return
`directory-picker-unavailable` with capability `none` when absent. Both the
upstream and patched rc.6 files are SHA-256 pinned before publication.

The local Jobs registry is process-memory state. Persistent Session, Goal, and
child-session facts support an explicit resume after restart, but a running Job
is not claimed to survive a process crash.

The upstream Web application must remain loopback-only when it is integrated.
LAN clients connect through the native host's authenticated reverse proxy rather
than binding the DSH server directly to a LAN interface.

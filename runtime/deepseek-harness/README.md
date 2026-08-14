# DeepSeek Harness ACP Sidecar

This directory defines the pinned, pre-release DeepSeek Harness runtime used by
OPC-Nexus. It is a dedicated JSON-RPC-over-stdio sidecar, not an Electron Main
dependency and not a general `dsh` profile.

## Scope

The P0 composition provides:

- the official DeepSeek streaming adapter;
- an `openai-completions` adapter for the OPC-Nexus provider endpoint;
- the automation-only ACP server;
- append-only JSONL Session persistence and its derived SQLite query index;
- native filesystem Skills only from the OPC-Nexus-managed
  `AIBOX_DSH_MANAGED_SKILLS_DIR` root.

It intentionally provides no command execution, filesystem mutation tools,
MCP servers, web search/fetch, telemetry exporter, stdout logger, Claude Code
agent integration, or arbitrary executable plugins. Add those capabilities
only through a separately reviewed composition.

## Prepare

Run from the repository root with a supported Node.js installation:

```powershell
node scripts/prepare-deepseek-harness.cjs
```

The script requires Node `^22.19.0 || >=24.0.0` and npm `>=11.16.0`. The npm
minimum is intentional: preparation uses npm's `allowScripts` policy in strict
mode, permits only Koffi's pinned native install script, and explicitly denies
the Google GenAI and protobufjs lifecycle scripts. The script copies this
manifest and configuration to a temporary staging directory, runs the pinned
production install, performs a real ACP `initialize` plus `session/new` smoke
test, and atomically replaces `runtime/deepseek-harness/dist`.

Preparation also applies a fail-closed patch to the pinned rc.6 anonymous-id
helper. Persistence remains exclusive-create-only; a conflicting path is read
or ignored and is never reopened for an ordinary overwrite.

To validate an already prepared runtime without installing or replacing it:

```powershell
node scripts/prepare-deepseek-harness.cjs --verify
```

Verification also rejects a `dist` made from stale manifest, lockfile, or
configuration sources. Both modes load the target Koffi native module and run
the ACP smoke tests. `--verify-only` is retained as an alias.

`dist` is generated and must not be edited or committed. Run the preparation on
each target operating system and architecture because npm selects native
optional packages during `npm ci`. The generated runtime deliberately contains
no `node.exe`; packaging must supply a supported target Node runtime separately.

## Launch

Launch with a supported Node executable. OPC-Nexus uses its packaged Electron
binary in Node mode, rather than an npm `.cmd` shim:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
<electron> runtime/deepseek-harness/dist/opc-acp-entry.mjs `
  --config runtime/deepseek-harness/dist/config/cordis.yml
```

Set the child process working directory to the Agent workspace. Reserve stdout
for ACP frames and collect diagnostics from stderr. Check `process.versions.node`
before launch and fail closed below `22.19.0`. The currently locked Electron
37.10.3 embeds Node 22.21.1 and passes the native-module and ACP smoke tests.
Re-run those tests whenever Electron or the sidecar dependency closure changes.
The OPC-owned entry never reads a `.env` file and disposes the root Cordis
context on stdin EOF, `SIGINT`, or `SIGTERM` before exiting.

Pass these values from Electron Main when spawning the process:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | yes | Decrypted credential used by the DeepSeek adapter. |
| `DEEPSEEK_BASE_URL` | no | Trusted DeepSeek-compatible endpoint override. |
| `OPENAI_API_KEY` | for compatible endpoints | Decrypted credential used by the `aibox-openai` route. |
| `OPENAI_BASE_URL` | for compatible endpoints | Trusted OpenAI-compatible `/v1` endpoint. |
| `AIBOX_DSH_PROVIDER` | no | `deepseek-official` or `aibox-openai`; defaults to the former. |
| `AIBOX_DSH_MODEL` | no | Model id; defaults to `deepseek-chat`. |
| `AIBOX_DSH_SESSIONS_ROOT` | yes in production | Per-user durable Session directory. |
| `AIBOX_DSH_MANAGED_SKILLS_DIR` | yes | The only filesystem root from which this composition discovers Skills. |
| `DSH_HOME` | yes in production | Harness data root; its default Skills directory is not scanned. |

Use absolute paths below Electron `userData` for all production data roots.
Never write the API key into this configuration, a profile, the Renderer, or a
Session log.

The filesystem provider has `includeDefaultRoots: false` and runtime watching is
disabled: project
`.dsh/skills`, project `.agents/skills`, user roots, and
`DSH_BUNDLED_SKILL_DIR` are deliberately ignored. OPC-Nexus synchronizes
approved database Skills into an immutable, per-sidecar
`AIBOX_DSH_MANAGED_SKILLS_DIR` snapshot before each start. A snapshot remains
owned by that child until the process closes, so overlapping tasks cannot
replace or delete one another's Skills. Each run also receives its own
`AIBOX_DSH_SESSIONS_ROOT`, which isolates the derived SQLite Session query index
from other Harness processes. P0 Skills load model-visible instructions from
their managed snapshot; they are not executable Cordis or npm plugins.

## ACP Limits

DeepSeek Harness rc.6 ACP creates fresh text-only sessions. It supports prompt,
cancel, and one-shot permission requests, but not list, resume, delete, fork,
per-session close, non-empty `mcpServers`, images, or live reasoning/tool
streaming. OPC-Nexus must treat this as the initial runtime adapter rather than
its final lifecycle protocol.

The rc.6 bridge maps an upstream `max-tokens` turn ending to ACP `end_turn`.
OPC-Nexus therefore cannot distinguish token-limit truncation from a normal
completion in this version. Do not use this adapter where the stop reason itself
must prove that a long response is complete; upgrade or patch the bridge once it
exposes a distinct truncation reason.

The package versions are exact and the complete resolved closure is fixed by
`package-lock.json`. Upgrade the pinned DeepSeek dependencies and regenerate
the lockfile as one reviewed change. The pi-ai multi-provider dependency closure
does contain `@anthropic-ai/sdk`; no Anthropic provider route or Claude agent
integration is mounted by this composition.

# OPC-Nexus · Digital Employee AI Box

> A local-first workbench for solo companies and small studios: the owner gives the order, Hermes understands and coordinates it, digital employees execute it, and the system delivers verifiable artifacts.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/h4dex/opc-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/h4dex/opc-nexus/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/h4dex/opc-nexus?display_name=tag)](https://github.com/h4dex/opc-nexus/releases)

## Current Version

| Component | Version | Notes |
| --- | --- | --- |
| OPC-Nexus desktop | `2.0.0` | Windows 10/11 and Ubuntu 22.04+ |
| Hermes Runtime | `0.19.0` | The only Quest orchestrator, pinned fork and upstream commit |
| Android Bridge | `0.4.3` | Optional mobile execution worker, not a Quest orchestrator |

Version 2.0.0 is the Hermes architecture release and is intentionally different from the Nexus orchestration architecture in 1.x. Back up user data before upgrading. The application migrates the legacy data directory, but it does not re-enable DSH as a second control plane.

## How It Works

```text
Owner
  -> Quest / Hermes conversation
  -> Clarification (for complex requests)
  -> Draft plan and staffing proposal
  -> OPC-Nexus Main validates, approves and dispatches
  -> Codex / Claude / Pi / Hermes Worker / mobile worker
  -> Project directory, preview, run command, screenshots and channel receipt
```

- **Hermes** handles conversation understanding, clarification, memory, plan content and delegation proposals.
- **OPC-Nexus Main** owns project scope, employee policy, permissions, budgets, task/Run state, approvals, cancellation, recovery, delivery and audit facts.
- **Digital employees** are independent entities. A project may use a dynamic employee pool or an explicit employee allow-list; one-to-one project binding is not required.
- **DSH** is not a scheduler or a second Web workbench. If a DSH CLI is retained, it can only execute work admitted by Main.

## Hermes Project Workbench

Every project needs a real, accessible working directory. Choose it in Quest, or use the default:

```text
%USERPROFILE%/opc-nexus/projects/<project-name>-<id>/
```

Each project runtime has an isolated `HERMES_HOME`, loopback ports, a short-lived authentication lease, sessions and memory. The Hermes Web UI is embedded in Quest. Renderer code never receives the service token and cannot read another project's files, sessions or memory.

### Configure a Provider

Open Quest's **Connection settings**, enter a Provider Base URL, model and API Key, then use **Fetch models** and **Test**. API keys are stored only through Electron `safeStorage`; they are never written to this README, logs, Renderer state or Hermes memory.

Hermes performs these checks before spawning a project runtime:

1. The project directory exists and is not a symbolic link.
2. The Provider has a decryptable API Key, Base URL and model.
3. Both the Dashboard and API Gateway pass the 0.19.x health checks.

Failures show the real cause and a recovery path to Connection settings. The application never reports a fake online or completed state.

## Main Capabilities

- Embedded Hermes Chat, clarification, plans, worker progress, independent acceptance and delivery panels in Quest.
- Simple requests can return directly; complex requests follow **clarify -> plan -> approve -> dispatch -> deliver**.
- Dynamic staffing or project employee allow-lists, `@employee` mentions, sub-agent teams and independent validation workers.
- Codex, Claude Code, Pi, Hermes CLI Worker and Android Worker through one execution policy.
- Project-scoped MCP and Skill selection from one capability center, without duplicate legacy DSH plugins.
- Delivery manifests, directory reveal, Markdown/file preview, run commands, runtime URLs, screenshots and channel delivery.
- Hermes mobile Web access using TLS, one-time pairing and viewer/operator roles.
- Real WeCom, Feishu and WeChat iLink channels can bind to project conversations; remote approve, pause and cancel actions are audited.
- Debug mode writes redacted JSONL to the user data `logs/` directory for runtime, proxy, gateway, task and channel diagnosis.

## Development and Verification

Requirements: Node.js 20+, npm 10+ and Python 3.11. The Hermes preparation scripts use `uv` to obtain the pinned Python runtime.

```bash
npm ci
npm run hermes:prepare
npm run typecheck
npm test
npm run hermes:verify
npm run hermes:smoke
npm run build
```

Run development mode with:

```bash
npm run dev
```

Build installers with:

```bash
npm run pack:win
npm run pack:linux
```

GitHub Actions repeats type checking, unit tests, Hermes runtime preparation, health smoke and production builds on Windows and Ubuntu. Release jobs also inspect the packaged Hermes runtime.

## Security Boundaries

- `contextIsolation: true` and `nodeIntegration: false`; Renderer code cannot use Node.js APIs.
- Renderer-to-Main calls go through typed preload APIs; the generic `ipcRenderer` object is never exposed.
- API keys, tokens and channel credentials remain inside Main/safeStorage.
- Every task is checked against its project directory, employee policy, permissions, budget and engine availability.
- If a Hermes process, proxy or Gateway crashes, the runtime becomes offline/error and related queue items stop; success is never inferred.

## Documentation

- [Chinese README](./README.md)
- [User guide](./docs/USER-GUIDE.md)
- [Changelog](./CHANGELOG.md)
- [Release guide](./docs/RELEASING.md)
- [Architecture](./src/docs/architecture.md)
- [API reference](./src/docs/api-reference.md)
- [Third-party notices](./THIRD-PARTY-NOTICES.md)

## License

[MIT](./LICENSE) © Senke


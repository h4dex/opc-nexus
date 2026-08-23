# OPC-Nexus Hermes fork

- Upstream: `https://github.com/NousResearch/hermes-agent.git`
- Pinned upstream commit: `2b0fb72acae67f51652de5c51db556bc15a68f0e`
- Upstream release: `v0.19.0`

This directory is a source fork used by the OPC-Nexus project-level Hermes
service. Keep upstream changes isolated here. Nexus governance, project scope,
owner approval, worker policy, and artifact admission belong in `src/main` and
must not be copied into Hermes Python code.

## Local integration contract

The Electron Main process starts `python -m hermes_cli.main dashboard` on a
loopback-only port with a per-project `HERMES_HOME`. Hermes UI traffic is
exposed to the desktop and LAN gateway only through the Main-owned proxy.

No generated `node_modules`, Python virtual environments, caches, or user
credentials belong in this fork.

### Local patches

- `tools/nexus_tool.py`: project-scoped plan submission through the authenticated
  loopback Main-process Host Contract. The tool is absent unless Nexus injects
  `HERMES_NEXUS_HOST_URL` and `HERMES_NEXUS_HOST_TOKEN`.
- `tools/nexus_tool.py`: employee delegation is classified as `execution`,
  `status_inquiry`, or `validation`, and exposes a separate
  `nexus_task_status` read. Progress questions never require artifacts;
  independent validation identifies completed Nexus task ids and cannot be
  treated as complete until Main returns an authoritative PASS verdict.
- `gateway/platforms/api_server.py` and `tools/nexus_tool.py`: managed project
  API sessions persist `clarify` questions through the authenticated Main Host
  Contract and return immediately. Project mode also force-enables the
  registry-backed `clarify` and `planning` toolsets so dashboard settings
  cannot silently remove owner clarification, Nexus plan, employee-dispatch,
  or MCP tools from real model turns.
  OPC-Nexus durable state, rather than a Python in-memory wait event, remains
  authoritative until the owner answers.
- `gateway/platforms/api_server.py`: confirmed locks retain the routable named
  custom-provider identity while accepting Hermes' normalized `custom` runtime
  class after provider resolution, so valid project endpoints do not fail after
  a successful model response.
- `gateway/platforms/api_server.py`: project session SSE requests retain the
  active AIAgent reference and call `agent.interrupt()` when Main aborts the
  stream. The Nexus interrupt endpoint waits for the executor and transcript
  finalizer, then writes an explicit cancelled-turn closure before Main drains
  the next queued instruction. Cancelling a Quest turn therefore stops real
  model/tool work instead of only closing the HTTP response or leaving an
  unfinished instruction in the next turn's context.
- `gateway/platforms/api_server.py`: an asyncio task cancellation is still
  re-raised after interrupting the active agent, while ordinary SSE client
  connection resets are treated as an acknowledged disconnect. This avoids
  user-facing `ClientConnectionResetError` tracebacks during normal Quest
  cancellation without swallowing server task cancellation.
- `gateway/platforms/api_server.py`: Nexus session turns persist an explicit
  assistant closure after owner cancellation or terminal upstream failure.
  Later turns therefore never replay a durable `user -> user` wedge or infer
  that a failed/cancelled instruction should continue automatically.
- `gateway/platforms/api_server.py`, `agent/agent_init.py`, `run_agent.py`, and
  `tools/memory_tool.py`: enforce the Main-owned session memory contract.
  Stateless employees retain UI transcripts but receive no prior model history;
  short-term employees receive only their current Hermes session; long-term
  employees use a validated project-local employee directory. External memory
  providers are disabled for these sessions so they cannot bypass the namespace.
- `agent/conversation_loop.py` and `agent/turn_retry_state.py`: when a custom
  OpenAI-compatible relay accepts a real tool call but rejects the completed
  assistant/tool history with a generic HTTP 400, retry once with an API-only
  text receipt. The canonical Hermes transcript remains unchanged and the tool
  side effect is never repeated.
- `gateway/config.py`: managed project mode enables only the API Server platform,
  preventing Hermes from reusing host channel credentials and creating duplicate
  ingress alongside OPC-Nexus channel adapters.
- `toolsets.py`: includes `nexus_submit_plan` in the core surface; its runtime
  availability check keeps it hidden in ordinary upstream Hermes sessions.
- `tools/delegate_tool.py`: hides and fail-closes native `delegate_task` while
  the Nexus Host Contract is active, preventing a second unmanaged worker
  state machine from spawning local child agents.
- `web/src/App.tsx` and `web/src/components/ChatSidebar.tsx`: honor the
  Main-injected project-mode flag, hide machine-global/profile navigation, and
  prevent project windows from changing the global model assignment. Main's
  proxy remains the authoritative route enforcement boundary.
- `web/src/pages/NexusChatPage.tsx`: project-mode chat uses the Main-owned
  Project Contract and Hermes API sessions instead of the POSIX-only PTY route,
  so native Windows builds retain real multi-turn chat without exposing the API
  Server Bearer token to browser code.
- `web/src/pages/NexusChatPage.tsx`: running-turn cancellation remains visibly
  `cancelling` until Main receives executor settlement. Failed turns require a
  second explicit owner confirmation before retry, preventing a stale click or
  replayed project request from repeating side effects.
- `web/src/pages/NexusChatPage.tsx` and `web/src/index.css`: replace the upstream
  project composer with the Nexus employee-aware workbench. Drafts and pending
  attachments are isolated per conversation; image, video, and file selection,
  paste, drag/drop, previews, bounded uploads, `@` employee selection, slash
  commands, and responsive Markdown/media rendering work in desktop and mobile
  project surfaces without exposing filesystem or service credentials.
- `web/src/contexts/ProfileProvider.tsx`: project mode never reads or mutates
  machine-global Hermes profiles. Provider/model authority remains in the
  Main-owned project runtime binding and global profile routes stay blocked by
  proxy policy.
- `web/src/components/NexusProjectBar.tsx`: shows Main-projected persistent clarification questions,
  approved plan identity, real Task/manifest counts, and owner-only approval,
  dispatch, and project-directory actions without giving the SPA database
  access.
- `web/src/plugins/usePlugins.ts` and `web/src/themes/context.tsx`: project-mode
  workbenches skip Hermes dashboard-plugin discovery (shared plugins remain
  Main-owned) and follow the host's explicit light/dark theme contract. This
  prevents a stalled plugin endpoint from blocking chat and prevents Hermes'
  saved machine theme from overriding the OPC-Nexus project surface.

# OPC-Nexus bundled agent runtimes

The release package may contain the following optional third-party CLI
runtimes under `agent-runtimes/`:

- `@openai/codex` (Apache-2.0)
- `@earendil-works/pi-coding-agent` (MIT)

The exact versions and package entry points are recorded in `manifest.json`.
These runtimes are optional execution tools. They are not enabled or marked
healthy until the host detects the executable and a real provider-backed task
probe succeeds.

The source repository intentionally does not commit `node_modules` or native
runtime binaries. Release preparation downloads the pinned packages into the
application resources directory and the package verification step fails if a
runtime is only partially present.

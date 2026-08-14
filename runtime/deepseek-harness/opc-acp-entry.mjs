#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  boot,
  installFailLoud,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot';

const NAME = 'opc-nexus-dsh-acp';

let rootContext;
let bootSettled = false;
let resolveContextReady;
let disposePromise;
let exitPromise;
const contextReady = new Promise((resolve) => {
  resolveContextReady = resolve;
});

async function disposeRoot() {
  if (!disposePromise) {
    disposePromise = (async () => {
      if (!rootContext && !bootSettled) await contextReady;
      if (rootContext) await rootContext.fiber.dispose();
    })();
  }
  return disposePromise;
}

function requestExit(code) {
  if (exitPromise) return;
  exitPromise = (async () => {
    try {
      await disposeRoot();
    } catch (error) {
      process.stderr.write(`${NAME}: shutdown failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    } finally {
      process.exit(code);
    }
  })();
}

installFailLoud(NAME, process, disposeRoot);
process.stdin.once('end', () => requestExit(0));
process.once('SIGINT', () => requestExit(130));
process.once('SIGTERM', () => requestExit(143));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: {
      type: 'string',
      short: 'c',
    },
  },
  strict: true,
});

try {
  const context = await boot(
    NAME,
    resolveConfigPath(values.config ?? './cordis.yml', process.env.DSH_SNAPSHOT),
    undefined,
    (ctx) => {
      rootContext = ctx;
      resolveContextReady();
    },
  );
  rootContext ??= context;
} finally {
  bootSettled = true;
  resolveContextReady();
}

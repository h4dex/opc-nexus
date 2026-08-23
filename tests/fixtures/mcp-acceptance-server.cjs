'use strict';

const fs = require('node:fs');

const invocationLog = String(process.env.MCP_ACCEPTANCE_LOG || '').trim();

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function appendInvocation(value) {
  if (!invocationLog) return;
  fs.appendFileSync(invocationLog, `${JSON.stringify(value)}\n`, 'utf8');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;

    if (request.method === 'initialize') {
      send(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'opc-nexus-acceptance-mcp', version: '1.0.0' }
      });
      continue;
    }
    if (request.method === 'tools/list') {
      send(request.id, {
        tools: [{
          name: 'echo_marker',
          description: 'Return a caller-provided acceptance marker from a real MCP process.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['marker'],
            properties: { marker: { type: 'string', minLength: 1, maxLength: 200 } }
          }
        }]
      });
      continue;
    }
    if (request.method === 'tools/call') {
      const marker = typeof request.params?.arguments?.marker === 'string'
        ? request.params.arguments.marker
        : '';
      appendInvocation({ method: request.method, name: request.params?.name, marker, at: Date.now() });
      send(request.id, {
        content: [{ type: 'text', text: `MCP-REAL-ECHO::${marker}` }],
        structuredContent: { marker, source: 'real-stdio-mcp' },
        isError: false
      });
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` }
    })}\n`);
  }
});


const registeredTools = [];

export const server = {
  tool(name, description, inputSchema, handler) {
    registeredTools.push({ name, description, inputSchema, handler });
  },
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[node-core-mcp] ${ts} ${msg}\n`);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function dispatch(msg) {
  switch (msg.method) {
    case 'initialize':
      log(`initialize (client: ${msg.params?.clientInfo?.name ?? 'unknown'})`);
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'node-core', version: '1.0.0' },
      };
    case 'notifications/initialized':
      log('initialized');
      return null;
    case 'tools/list':
      log(`tools/list -> ${registeredTools.length} tools`);
      return {
        tools: registeredTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case 'tools/call': {
      const toolName = msg.params?.name;
      log(`tools/call -> ${toolName}`);
      const tool = registeredTools.find((t) => t.name === toolName);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: -32601 });
      return tool.handler(msg.params?.arguments ?? {});
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

export function start() {
  log('server started, listening on stdin');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null) continue; // Notification — no response
      let result;
      try {
        result = await dispatch(msg);
      } catch (err) {
        log(`error: ${msg.method} -> ${err.message}`);
        send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
        continue;
      }
      if (result !== null) send({ jsonrpc: '2.0', id: msg.id, result });
    }
  });
}

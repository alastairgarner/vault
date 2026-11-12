import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Brain } from './brain.js';
import { createServer } from './server.js';
import { limitsFromEnv } from './limits.js';
import { assetsFromEnv } from './assets.js';

const [root, state, ...extra] = process.argv.slice(2);
if (!root || !state || extra.length) {
  console.error('Usage: pnpm dev /absolute/fixture-root /absolute/private-state-directory');
  process.exit(1);
}
// Reserve stdout exclusively for MCP JSON-RPC, including dependency diagnostics.
console.log = console.error;
console.info = console.error;
const brain = await Brain.open(root, state, limitsFromEnv(), assetsFromEnv());
const server = createServer(brain);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await brain.close();
};
process.once('SIGINT', () => close().then(() => process.exit(0)));
process.once('SIGTERM', () => close().then(() => process.exit(0)));
const transport = new StdioServerTransport();
await server.connect(transport);
// The SDK does not close itself on stdin EOF; release locks explicitly.
process.stdin.once('end', () => { void close(); });
const onclose = transport.onclose;
transport.onclose = () => { onclose?.(); void close(); };

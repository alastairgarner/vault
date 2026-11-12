import { isIP } from 'node:net';
import { z } from 'zod';
import { Brain } from './brain.js';
import { startHttp } from './http.js';
import { errorMessage } from './errors.js';
import { TokenAuth } from './auth.js';
import { limitsFromEnv } from './limits.js';
import { assetsFromEnv } from './assets.js';

const config = z.object({
  NOTES_ROOT: z.string().min(1),
  STATE_DIR: z.string().min(1),
  HTTP_HOST: z.string().refine(value => isIP(value) !== 0, 'Use an explicit IP address').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]'),
  HTTP_ALLOWED_ORIGINS: z.string().default(''),
  AUTH_CONFIG: z.string().min(1),
}).parse(process.env);
const split = (value: string) => value.split(',').map(part => part.trim()).filter(Boolean);
console.log = console.error;
console.info = console.error;
const limits = limitsFromEnv();
const assets = assetsFromEnv();
const auth = await TokenAuth.fromFile(config.AUTH_CONFIG);
const brain = await Brain.open(config.NOTES_ROOT, config.STATE_DIR, limits, assets);
let listener: Awaited<ReturnType<typeof startHttp>>;
try {
  listener = await startHttp({
    brain, auth, limits, host: config.HTTP_HOST, port: config.PORT,
    allowedHosts: split(config.HTTP_ALLOWED_HOSTS), allowedOrigins: split(config.HTTP_ALLOWED_ORIGINS),
  });
} catch (error) { await brain.close(); throw error; }
console.error(JSON.stringify({ event: 'http_listening', host: config.HTTP_HOST, port: listener.port, path: '/mcp' }));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await listener.close(); await brain.close(); }
  catch (error) {
    console.error(JSON.stringify({ event: 'shutdown_failed', error: errorMessage(error) }));
    process.exitCode = 1;
  }
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

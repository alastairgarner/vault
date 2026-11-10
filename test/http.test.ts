import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { MAX_SEARCH_DATA_BYTES, MAX_SEARCH_RESPONSE_BYTES, MAX_SEARCH_TITLE_LENGTH, MAX_SEARCH_EXCERPT_LENGTH } from '../src/limits.js';
import type { ResourceLimits } from '../src/limits.js';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { Brain } from '../src/brain.js';
import { startHttp, MAX_REQUEST_BYTES } from '../src/http.js';
import { TokenAuth, hashToken } from '../src/auth.js';
import { png } from './image-fixtures.js';

async function fixture(t: TestContext, limits: Partial<ResourceLimits> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-http-'));
  await fs.mkdir(path.join(base, 'notes', 'ai'), { recursive: true });
  const brain = await Brain.open(path.join(base, 'notes'), path.join(base, 'state'), limits);
  const token = randomBytes(32).toString('hex');
  const secondToken = randomBytes(32).toString('hex');
  const auth = TokenAuth.parse({ version: 1, tokens: [
    { name: 'agent-a', sha256: hashToken(token) },
    { name: 'agent-b', sha256: hashToken(secondToken) },
  ] });
  const http = await startHttp({ brain, auth, limits, host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  const endpoint = `http://127.0.0.1:${http.port}`;
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await http.close();
    await brain.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const connect = async (credential = token) => {
    const client = new Client({ name: 'http-fixture', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    }));
    return client;
  };
  return { endpoint, connect, brain, http, root: path.join(base, 'notes'), token, secondToken };
}

const mutationSchema = z.object({ hash: z.string(), committed: z.literal(true), freshness: z.object({ state: z.literal('snapshot') }) });
const readSchema = z.object({ hash: z.string(), content: z.string() });
const searchSchema = z.object({ results: z.array(z.object({ reference: z.string(), excerpt: z.string() })) });
const textResult = z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1);

test('stateless HTTP shares safe QMD-backed storage across independent clients', async t => {
  const { connect, secondToken, root } = await fixture(t);
  const [a, b] = await Promise.all([connect(), connect(secondToken)]);
  assert.equal((await a.listTools()).tools.length, 9);
  const created = await a.callTool({ name: 'note_create', arguments: { path: 'ai/http.md', content: '# HTTP\nNeptune exploration' } });
  assert.ok(!created.isError);
  const { hash } = mutationSchema.parse(created.structuredContent);
  const reads = await Promise.all([a, b].map(client => client.callTool({ name: 'note_read', arguments: { path: 'ai/http.md' } })));
  for (const result of reads) assert.equal(readSchema.parse(result.structuredContent).hash, hash);
  const conflicts = await Promise.all([a, b].map((client, index) => client.callTool({
    name: 'note_edit', arguments: { path: 'ai/http.md', expectedHash: hash, edits: [{ oldText: 'Neptune', newText: `Saturn${index}` }] },
  })));
  assert.equal(conflicts.filter(r => !r.isError).length, 1);
  const failed = conflicts.find(r => r.isError);
  assert.ok(failed);
  assert.match(JSON.stringify(textResult.parse(failed.content)), /hash conflict/);
  const search = await b.callTool({ name: 'note_search', arguments: { query: 'exploration' } });
  assert.equal(searchSchema.parse(search.structuredContent).results.length, 1);
  const duplicate = await b.callTool({ name: 'note_create', arguments: { path: 'ai/http.md', content: 'clobber' } });
  assert.equal(duplicate.isError, true);
  const escape = await b.callTool({ name: 'note_read', arguments: { path: '../secret.md' } });
  assert.equal(escape.isError, true);
  for (const client of [a, b]) {
    const rejected = await client.callTool({ name: 'note_create', arguments: { path: 'outside.md', content: 'forbidden' } });
    assert.equal(rejected.isError, true);
  }
  await assert.rejects(fs.stat(path.join(root, 'outside.md')), /ENOENT/);
  await fs.writeFile(path.join(root, 'existing.md'), 'outside ai');
  const existing = await b.callTool({ name: 'note_read', arguments: { path: 'existing.md' } });
  const edited = await a.callTool({ name: 'note_edit', arguments: {
    path: 'existing.md', expectedHash: readSchema.parse(existing.structuredContent).hash,
    edits: [{ oldText: 'outside ai', newText: 'still editable' }],
  } });
  assert.ok(!edited.isError);
  assert.equal(await fs.readFile(path.join(root, 'existing.md'), 'utf8'), 'still editable');
});

test('HTTP note_move commits once, updates links and is visible to other clients', async t => {
  const { connect, secondToken, root } = await fixture(t);
  const [a, b] = await Promise.all([connect(), connect(secondToken)]);
  await fs.writeFile(path.join(root, 'old.md'), 'Walrus');
  await fs.writeFile(path.join(root, 'linking.md'), '[[old]] [x](old.md)');
  const { hash } = readSchema.parse((await a.callTool({ name: 'note_read', arguments: { path: 'old.md' } })).structuredContent);
  const moves = await Promise.all([a, b].map((client, index) => client.callTool({
    name: 'note_move', arguments: { path: 'old.md', newPath: `new/${index}.md`, expectedHash: hash },
  })));
  assert.equal(moves.filter(result => !result.isError).length, 1);
  const moved = z.object({ to: z.string(), links: z.array(z.object({ path: z.literal('linking.md'), status: z.literal('updated') })) })
    .parse(moves.find(result => !result.isError)?.structuredContent);
  const name = path.posix.basename(moved.to, '.md');
  assert.equal(await fs.readFile(path.join(root, 'linking.md'), 'utf8'), `[[${name}]] [x](new/${name}.md)`);
  const listed = await b.callTool({ name: 'note_list', arguments: {} });
  assert.deepEqual(z.object({ paths: z.array(z.string()) }).parse(listed.structuredContent).paths, ['linking.md', moved.to]);
  const search = await a.callTool({ name: 'note_search', arguments: { query: 'Walrus' } });
  assert.ok(searchSchema.parse(search.structuredContent).results[0]?.reference.endsWith(moved.to));
});

test('HTTP image uploads validate bytes and boundaries before atomic publication', async t => {
  const { connect, secondToken, root } = await fixture(t);
  await fs.mkdir(path.join(root, 'ai', 'attachments'));
  const [a, b] = await Promise.all([connect(), connect(secondToken)]);
  const result = await a.callTool({ name: 'attachment_create', arguments: { path: 'ai/attachments/http.png', base64: png } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(z.object({ path: z.literal('ai/attachments/http.png'), committed: z.literal(true), mimeType: z.literal('image/png') }).parse(result.structuredContent).committed, true);
  assert.deepEqual(await fs.readFile(path.join(root, 'ai', 'attachments', 'http.png')), Buffer.from(png, 'base64'));
  for (const args of [
    { path: 'ai/attachments/http.png', base64: png },
    { path: 'outside.png', base64: png },
    { path: 'ai/attachments/mismatch.jpg', base64: png },
    { path: 'ai/attachments/fake.png', base64: Buffer.from('text').toString('base64') },
    { path: 'ai/attachments/invalid.png', base64: png + '\\n' },
    { path: 'ai/attachments/large.png', base64: 'A'.repeat(1_398_108) },
  ]) assert.equal((await b.callTool({ name: 'attachment_create', arguments: args })).isError, true);
  assert.deepEqual(await fs.readdir(path.join(root, 'ai', 'attachments')), ['http.png']);
  const listed = await b.callTool({ name: 'note_list', arguments: {} });
  assert.deepEqual(z.object({ paths: z.array(z.string()) }).parse(listed.structuredContent).paths, []);
});

test('authenticated HTTP still enforces Host/Origin, request size, routes and methods', async t => {
  const { endpoint, token } = await fixture(t);
  const authorization = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(endpoint + '/health')).status, 200);
  assert.equal((await fetch(endpoint + '/mcp', { headers: authorization })).status, 405);
  assert.equal((await fetch(endpoint + '/missing')).status, 404);
  // Fetch normalizes Host; use a raw Node request to actually send an attacker hostname.
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint + '/health', { headers: { host: 'evil.example' } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(endpoint + '/health', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(endpoint + '/health', { headers: { 'x-forwarded-host': 'evil.example' } })).status, 200);
  const headers = { ...authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', headers, body: ' '.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
});

test('HTTP rejects missing, wrong, malformed and duplicate credentials before MCP can write', async t => {
  const { endpoint, token, brain } = await fixture(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'note_create', arguments: { path: 'ai/forbidden.md', content: 'must not be written' },
  } });
  for (const credential of ['', `Bearer ${randomBytes(32).toString('hex')}`, `Basic ${token}`, 'Bearer short', `Bearer ${token}, Bearer ${token}`]) {
    const response = await fetch(endpoint + '/mcp', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(credential ? { authorization: credential } : {}) },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="markdown-brain"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(z.object({ message: z.literal('Unauthorized') }).parse(await response.json()).message, 'Unauthorized');
  }
  const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint + '/mcp', { method: 'POST', headers: ['Host', new URL(endpoint).host, 'Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`] }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end(body);
  });
  assert.equal(duplicateStatus, 401);
  assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', body: '{', headers: { 'x-forwarded-user': 'agent-a' } })).status, 401);
  assert.equal((await fetch(endpoint + '/mcp?access_token=' + token, { method: 'POST', body })).status, 404);
  assert.equal((await fetch(endpoint + '/mcp')).status, 401);
  assert.equal((await fetch(endpoint + '/health')).status, 200);
  assert.deepEqual((await brain.list()).paths, []);
});

const compactResponseSchema = z.object({ result: z.object({
  isError: z.boolean().optional(),
  structuredContent: z.object({
    resultsTruncated: z.boolean(),
    results: z.array(z.object({ reference: z.string(), title: z.string(), titleTruncated: z.boolean(), excerpt: z.string() })),
  }).passthrough(),
}) });
async function rawSearch(endpoint: string, token: string) {
  const response = await fetch(endpoint + '/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'note_search', arguments: { query: 'needle', limit: 50 } } }),
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.ok(Buffer.byteLength(wire) <= MAX_SEARCH_RESPONSE_BYTES, 'Full JSON-RPC response must remain compact');
  const parsed = compactResponseSchema.parse(JSON.parse(wire));
  assert.ok(!parsed.result.isError);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed.result.structuredContent)) <= MAX_SEARCH_DATA_BYTES);
  return parsed.result.structuredContent;
}

test('security regression: million-character QMD titles no longer amplify search responses', async t => {
  const { root, endpoint, token } = await fixture(t);
  const content = '# ' + 'word '.repeat(200_000) + '\nneedle\n';
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, `large-${i}.md`), content);
  const result = await rawSearch(endpoint, token);
  assert.equal(result.results.length, 4);
  for (const hit of result.results) {
    assert.ok(hit.title.length <= MAX_SEARCH_TITLE_LENGTH);
    assert.equal(hit.titleTruncated, true);
    assert.ok(hit.excerpt.length <= MAX_SEARCH_EXCERPT_LENGTH);
  }
  assert.equal(await fs.readFile(path.join(root, 'large-0.md'), 'utf8'), content);
});

test('search byte budget accounts for Unicode, escaping and repeated structured/text payloads', async t => {
  const { root, endpoint, token } = await fixture(t);
  const references = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const name = 'x'.repeat(200) + `-${i}.md`;
    references.add('qmd://notes/' + name);
    await fs.writeFile(path.join(root, name), '# ' + '控制😀"\\'.repeat(70) + '\nneedle ' + '控制😀"\\'.repeat(100));
  }
  const result = await rawSearch(endpoint, token);
  assert.equal(result.resultsTruncated, true);
  assert.ok(result.results.length > 0 && result.results.length < 50);
  for (const hit of result.results) assert.ok(references.has(hit.reference), 'References must never be shortened');
});

async function waitForIdle(http: { readonly activeRequests: number }) {
  const deadline = Date.now() + 5000;
  while (http.activeRequests && Date.now() < deadline) await setImmediate();
  assert.equal(http.activeRequests, 0);
}

test('HTTP admission rejects overflow without queuing, preserves health, and releases aborted slots', async t => {
  const held: ClientRequest[] = [];
  t.after(() => { for (const req of held) req.destroy(); });
  const { endpoint, token, http, brain, connect } = await fixture(t, { maxHttpRequests: 1 });
  const holdRequest = async () => {
    const req = request(endpoint + '/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, expect: '100-continue', 'content-length': '2',
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    } });
    req.on('error', () => {}); // Deliberate client disconnect is exercised below.
    held.push(req);
    const continued = once(req, 'continue', { signal: AbortSignal.timeout(5000) });
    req.flushHeaders();
    await continued;
    assert.equal(http.activeRequests, 1);
    return req;
  };
  const first = await holdRequest();
  const overloaded = await fetch(endpoint + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{' });
  assert.equal(overloaded.status, 503);
  assert.equal(overloaded.headers.get('retry-after'), '1');
  assert.equal((await fetch(endpoint + '/health')).status, 200);
  assert.equal(brain.status().pendingOperations, 0);
  const completed = new Promise<void>(resolve => first.once('response', res => { res.resume(); res.once('end', resolve); }));
  first.end('{}');
  await completed;
  await waitForIdle(http);
  const aborted = await holdRequest();
  aborted.destroy();
  await waitForIdle(http);
  const client = await connect();
  const created = await client.callTool({ name: 'note_create', arguments: { path: 'ai/after-overload.md', content: 'recovered' } });
  assert.ok(!created.isError);
  assert.equal((await brain.read('ai/after-overload.md')).content, 'recovered');
});

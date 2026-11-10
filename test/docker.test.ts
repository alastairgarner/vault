import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { hashToken } from '../src/auth.js';
import { MAX_SEARCH_TITLE_LENGTH, MAX_SEARCH_RESPONSE_BYTES } from '../src/limits.js';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const freshness = z.object({ state: z.enum(['stale', 'snapshot', 'pending']) });
const mutation = z.object({ hash: z.string(), committed: z.literal(true), freshness });
const note = z.object({ hash: z.string(), content: z.string() });
const search = z.object({ results: z.array(z.object({ reference: z.string(), excerpt: z.string() })), freshness });

test('Docker HTTP MCP: authenticated safe writes, token revocation, restart persistence, disposable index', {
  skip: process.env.DOCKER_SMOKE !== '1', timeout: 120_000,
}, async t => {
  const id = `brain-smoke-${randomUUID()}`;
  const image = process.env.DOCKER_IMAGE ?? 'markdown-brain:local';
  const volumes: string[] = [];
  const clients: Client[] = [];
  const token = randomBytes(32).toString('hex');
  const secondToken = randomBytes(32).toString('hex');
  const entries = [
    { name: 'agent-a', sha256: hashToken(token) },
    { name: 'agent-b', sha256: hashToken(secondToken) },
  ];
  const writeConfig = (tokens: typeof entries) => {
    const content = JSON.stringify({ version: 1, tokens });
    docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--mount', `type=volume,src=${id}-auth,dst=/config`, '--entrypoint', 'node', image, '-e',
      `require('node:fs').writeFileSync('/config/auth.json',${JSON.stringify(content)},{mode:0o600})`);
  };
  let created = false;
  t.after(async () => {
    try {
      await Promise.all(clients.map(client => client.close()));
      if (created) {
        const result = spawnSync('docker', ['logs', id], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.status, 0);
        const logs = result.stdout + result.stderr;
        assert.ok(!logs.includes(token) && !logs.includes(secondToken), 'Logs must not contain bearer tokens');
        t.diagnostic(logs);
      }
    } finally {
      if (created) docker('rm', '--force', id);
      for (const volume of volumes) docker('volume', 'rm', volume);
    }
  });
  for (const suffix of ['notes', 'state', 'auth']) {
    const name = `${id}-${suffix}`;
    docker('volume', 'create', name);
    volumes.push(name);
  }
  writeConfig(entries);
  docker('run', '--detach', '--name', id, '--init', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777',
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1', '--pids-limit', '128',
    '--env', 'NODE_OPTIONS=--max-old-space-size=384',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--publish', '127.0.0.1::3000', '--env', 'AUTH_CONFIG=/config/auth.json',
    '--env', 'MAX_COLLECTION_FILES=5', '--env', 'MAX_COLLECTION_BYTES=8388608',
    '--mount', `type=volume,src=${id}-auth,dst=/config,readonly`,
    '--mount', `type=volume,src=${id}-notes,dst=/data/notes`,
    '--mount', `type=volume,src=${id}-state,dst=/data/state`, image);
  created = true;
  const endpoint = () => {
    const published = docker('port', id, '3000/tcp');
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    return new URL(`http://${published}/mcp`);
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(new URL('/health', endpoint()), { signal: AbortSignal.timeout(1000) });
        if (response.ok && docker('inspect', '--format', '{{.State.Health.Status}}', id) === 'healthy') return;
      } catch { /* Container may still be starting. */ }
      await setTimeout(250);
    }
    throw new Error('Container did not become ready');
  };
  const connect = async (credential = token) => {
    const client = new Client({ name: 'docker-smoke', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    }));
    return client;
  };
  const call = async <T>(client: Client, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return schema.parse(result.structuredContent);
  };
  await ready();
  docker('exec', id, 'mkdir', '/data/notes/ai');
  assert.equal(docker('exec', id, 'id', '-u'), '1000');
  assert.equal(docker('inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}', id), '805306368 805306368 128 1000000000');
  const anonymous = await fetch(endpoint(), { method: 'POST', body: '{' });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="markdown-brain"');
  const [a, b] = await Promise.all([connect(), connect(secondToken)]);
  assert.equal((await a.listTools()).tools.length, 9);
  const createdNote = await call(a, 'note_create', { path: 'ai/docker.md', content: '# Docker\nOrion observatory\n' }, mutation);
  assert.equal(createdNote.freshness.state, 'snapshot');
  const found = await call(b, 'note_search', { query: 'Orion' }, search);
  assert.equal(found.results.length, 1);
  const [hit] = found.results;
  assert.ok(hit);
  assert.match(hit.excerpt, /Orion/);
  assert.ok(hit.reference.endsWith('/docker.md'));
  const read = await call(b, 'note_read', { path: 'ai/docker.md' }, note);
  assert.equal(read.hash, createdNote.hash);
  const edited = await call(a, 'note_edit', {
    path: 'ai/docker.md', expectedHash: read.hash, edits: [{ oldText: 'Orion', newText: 'Kepler' }],
  }, mutation);
  assert.equal((await call(b, 'note_search', { query: 'Orion' }, search)).results.length, 0);
  assert.equal((await call(b, 'note_search', { query: 'Kepler' }, search)).results.length, 1);
  const races = await Promise.all([a, b].map((client, index) => client.callTool({ name: 'note_edit', arguments: {
    path: 'ai/docker.md', expectedHash: edited.hash, edits: [{ oldText: 'Kepler', newText: `Star${index}` }],
  } })));
  assert.equal(races.filter(result => !result.isError).length, 1);
  const persisted = await call(a, 'note_read', { path: 'ai/docker.md' }, note);
  assert.match(persisted.content, /Star[01]/);
  assert.equal(docker('exec', id, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/data/notes/ai/docker.md','utf8'))"), persisted.content.trim());
  // The read-only container can still create destination folders inside the notes volume.
  const moveResult = z.object({ committed: z.literal(true), hash: z.string() });
  assert.equal((await call(a, 'note_move', { path: 'ai/docker.md', newPath: 'ai/moved/docker.md', expectedHash: persisted.hash }, moveResult)).hash, persisted.hash);
  assert.equal(docker('exec', id, 'node', '-e', "process.stdout.write(String(require('node:fs').existsSync('/data/notes/ai/docker.md')))"), 'false');
  await call(b, 'note_move', { path: 'ai/moved/docker.md', newPath: 'ai/docker.md', expectedHash: persisted.hash }, moveResult);
  for (const args of [
    { name: 'note_create', arguments: { path: 'ai/docker.md', content: 'clobber' } },
    { name: 'note_read', arguments: { path: '../outside.md' } },
    { name: 'note_edit', arguments: { path: 'ai/docker.md', expectedHash: read.hash, edits: [{ oldText: 'Docker', newText: 'clobber' }] } },
    { name: 'note_edit', arguments: { path: 'ai/docker.md', expectedHash: persisted.hash, edits: [{ oldText: 'o', newText: 'clobber' }] } },
  ]) assert.equal((await b.callTool(args)).isError, true);
  docker('exec', id, 'node', '-e', "const f=require('node:fs');f.writeFileSync('/tmp/outside.md','SecretNebula');f.symlinkSync('/tmp/outside.md','/data/notes/escape.md')");
  assert.equal((await b.callTool({ name: 'note_read', arguments: { path: 'escape.md' } })).isError, true);
  assert.equal((await call(a, 'note_search', { query: 'SecretNebula' }, search)).results.length, 0);
  assert.equal((await call(b, 'note_read', { path: 'ai/docker.md' }, note)).hash, persisted.hash);
  docker('exec', id, 'node', '-e', "const f=require('node:fs');const c='# '+'word '.repeat(200000)+'\\nneedle\\n';for(let i=0;i<4;i++)f.writeFileSync('/data/notes/large-'+i+'.md',c)");
  const compact = await a.callTool({ name: 'note_search', arguments: { query: 'needle', limit: 50 } });
  assert.ok(!compact.isError);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= MAX_SEARCH_RESPONSE_BYTES);
  const largeTitles = z.object({ results: z.array(z.object({ title: z.string(), titleTruncated: z.literal(true) })) }).parse(compact.structuredContent);
  assert.equal(largeTitles.results.length, 4);
  for (const hit of largeTitles.results) assert.ok(hit.title.length <= MAX_SEARCH_TITLE_LENGTH);
  assert.equal((await b.callTool({ name: 'note_create', arguments: { path: 'ai/over-budget.md', content: 'rejected before publication' } })).isError, true);
  assert.equal(docker('exec', id, 'node', '-e', "process.stdout.write(String(require('node:fs').existsSync('/data/notes/ai/over-budget.md')))"), 'false');
  assert.equal((await fetch(endpoint(), { headers: { origin: 'https://evil.example' } })).status, 403);
  await Promise.all([a.close(), b.close()]);
  docker('stop', '--time', '30', id);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', id), '0');
  // Erase ONLY this test's disposable state volume, never the Markdown volume.
  docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--mount', `type=volume,src=${id}-state,dst=/data/state`, '--entrypoint', 'node', image, '-e',
    "const f=require('node:fs');for(const p of f.readdirSync('/data/state'))f.rmSync('/data/state/'+p,{recursive:true,force:true})");
  writeConfig(entries.filter(entry => entry.name !== 'agent-a'));
  docker('start', id);
  await ready();
  const revoked = await fetch(endpoint(), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{' });
  assert.equal(revoked.status, 401);
  const restarted = await connect(secondToken);
  assert.equal((await call(restarted, 'note_read', { path: 'ai/docker.md' }, note)).hash, persisted.hash);
  const rebuilt = await call(restarted, 'note_search', { query: 'observatory' }, search);
  assert.equal(rebuilt.freshness.state, 'snapshot');
  assert.equal(rebuilt.results.length, 1);
  await restarted.close();
  docker('stop', '--time', '30', id);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', id), '0');
});

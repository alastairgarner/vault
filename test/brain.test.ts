import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import type { ExactEdit } from '../src/files.js';
import { errorMessage } from '../src/errors.js';
import type { ResourceLimits } from '../src/limits.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { hash, replaceExact } from '../src/files.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { png } from './image-fixtures.js';

async function fixture(t: TestContext, limits: Partial<ResourceLimits> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-test-'));
  const root = path.join(base, 'notes');
  const state = path.join(base, 'state');
  await fs.mkdir(path.join(root, 'ai'), { recursive: true });
  const brain = await Brain.open(root, state, limits);
  t.after(async () => { await brain.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { brain, root, base, state };
}

test('exact replacements use original content; reject empty, duplicate, overlapping matches', () => {
  assert.equal(replaceExact('alpha beta', [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: 'gamma' }]), 'beta gamma');
  const invalid: [string, ExactEdit[]][] = [
    ['aaa', [{ oldText: 'aa', newText: 'x' }]],
    ['abc', [{ oldText: '', newText: 'x' }]],
    ['abc', [{ oldText: 'missing', newText: 'x' }]],
    ['abc', [{ oldText: 'ab', newText: 'x' }, { oldText: 'bc', newText: 'y' }]],
  ];
  for (const [body, edits] of invalid) assert.throws(() => replaceExact(body, edits));
});

test('real QMD and MCP vertical slice: create/search/read/edit and external changes', async t => {
  const { brain, root } = await fixture(t);
  const server = createServer(brain);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const freshness = z.object({ state: z.enum(['stale', 'pending', 'snapshot']) });
  const statusSchema = z.object({ freshness });
  const mutationSchema = z.object({ committed: z.boolean(), hash: z.string(), freshness });
  const searchSchema = z.object({ results: z.array(z.object({ reference: z.string(), excerpt: z.string() })) });
  const readSchema = z.object({ hash: z.string(), content: z.string() });
  const call = async <T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return schema.parse(result.structuredContent);
  };
  assert.equal(client.getServerVersion()?.name, 'vault');
  assert.equal((await client.listTools()).tools.length, 8);
  assert.equal((await call('brain_status', {}, statusSchema)).freshness.state, 'stale');
  const created = await call('note_create', { path: 'ai/idea.md', content: '# Brain\n\nZeppelin knowledge garden.\n' }, mutationSchema);
  assert.equal(created.committed, true);
  assert.equal(created.freshness.state, 'snapshot');
  const search = await call('note_search', { query: 'Zeppelin' }, searchSchema);
  assert.equal(search.results.length, 1);
  const [hit] = search.results;
  assert.ok(hit);
  assert.ok(hit.reference.endsWith('/idea.md'));
  assert.match(hit.excerpt, /Zeppelin/);
  const read = await call('note_read', { path: 'ai/idea.md', fromLine: 3, maxLines: 1 }, readSchema);
  assert.equal(read.content, 'Zeppelin knowledge garden.');
  assert.equal(read.hash, created.hash);
  const edited = await call('note_edit', { path: 'ai/idea.md', expectedHash: read.hash, edits: [{ oldText: 'Zeppelin', newText: 'Submarine' }] }, mutationSchema);
  assert.notEqual(edited.hash, read.hash);
  assert.equal((await call('note_search', { query: 'Zeppelin' }, searchSchema)).results.length, 0);
  assert.equal((await call('note_search', { query: 'Submarine' }, searchSchema)).results.length, 1);
  await fs.writeFile(path.join(root, 'ai/idea.md'), '# External\nOrchid telescope\n');
  assert.equal((await call('note_search', { query: 'Orchid' }, searchSchema)).results.length, 1);
  await fs.unlink(path.join(root, 'ai/idea.md'));
  assert.equal((await call('note_search', { query: 'Orchid' }, searchSchema)).results.length, 0);
});

test('concurrent hash edits and creates: exactly one wins, rejected writes preserve content', async t => {
  const { brain, root } = await fixture(t);
  const original = '# Note\noriginal\n';
  const created = await brain.create('ai/note.md', original);
  const edits = await Promise.allSettled(['first', 'second'].map(newText => brain.edit('ai/note.md', created.hash, [{ oldText: 'original', newText }])));
  assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1);
  const failure = edits.find(r => r.status === 'rejected');
  assert.ok(failure);
  assert.match(errorMessage(failure.reason), /hash conflict/);
  const before = await fs.readFile(path.join(root, 'ai/note.md'), 'utf8');
  await assert.rejects(brain.create('ai/note.md', 'overwrite'), /EEXIST/);
  await assert.rejects(brain.edit('ai/note.md', hash(before), [{ oldText: 'absent', newText: 'x' }]), /exactly once/);
  assert.equal(await fs.readFile(path.join(root, 'ai/note.md'), 'utf8'), before);
  const creates = await Promise.allSettled(['one', 'two'].map(c => brain.create('ai/new.md', c)));
  assert.equal(creates.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(!(await fs.readdir(path.join(root, 'ai'))).some(n => n.endsWith('.tmp')));
});

test('traversal, symlinks, hardlinks, hidden files and special files cannot escape', async t => {
  const { brain, root, base } = await fixture(t);
  await fs.mkdir(path.join(base, 'outside'));
  const secret = path.join(base, 'outside', 'secret.md');
  await fs.writeFile(secret, 'outside-secret');
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'escape'));
  await fs.symlink(secret, path.join(root, 'linked.md'));
  for (const name of ['../outside/secret.md', '/etc/passwd.md', 'escape/secret.md', 'linked.md', 'a/../b.md', '.hidden.md', 'a\\b.md']) {
    await assert.rejects(brain.read(name));
    await assert.rejects(brain.create(name, 'overwrite'));
  }
  assert.deepEqual((await brain.list()).paths, []);
  assert.equal((await brain.search('outside-secret')).results.length, 0);
  await fs.link(secret, path.join(root, 'hard.md'));
  await assert.rejects(brain.read('hard.md'), /single-link/);
  assert.equal((await brain.refresh()).freshness.state, 'stale');
  assert.equal(await fs.readFile(secret, 'utf8'), 'outside-secret');
});

test('creation is confined to lowercase ai/ or meetings/ with existing parents; reads and edits remain vault-wide', async t => {
  const { brain, root, base } = await fixture(t);
  await fs.mkdir(path.join(root, 'ai', 'nested'));
  await fs.mkdir(path.join(root, 'meetings'));
  await fs.mkdir(path.join(root, 'meetings-other'));
  await fs.mkdir(path.join(root, 'Meetings'));
  await fs.mkdir(path.join(root, 'ai-other'));
  await fs.mkdir(path.join(root, 'AI'));
  await fs.mkdir(path.join(base, 'outside'));
  const secret = path.join(base, 'outside', 'secret.md');
  await fs.writeFile(secret, 'outside-secret');
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'ai', 'escape'));
  await fs.symlink(secret, path.join(root, 'ai', 'linked.md'));
  for (const name of [
    'note.md', 'ai-other/note.md', 'AI/note.md', 'Ai/note.md',
    '../outside/note.md', '/ai/note.md', 'ai/../note.md', 'ai/./note.md',
    'ai//note.md', 'ai/../../outside/note.md', 'ai/escape/new.md',
    'ai/linked.md', 'ai/.hidden.md', 'ai/note.MD', 'ai/a\\b.md', 'ai/a\0b.md',
    'ai/package.json', 'ai/index.js', 'ai/photo.png', 'ai/video.mp4',
    'ai/missing/note.md', 'ai/node_modules/package.md',
    'meetings-other/note.md', 'Meetings/note.md', 'meetings/../note.md', 'meetings/missing/note.md',
  ]) {
    await assert.rejects(brain.create(name, 'must not write'), name);
  }
  await assert.rejects(brain.create('ai/too-large.md', 'x'.repeat(1024 * 1024 + 1)), /File too large/);
  await fs.link(secret, path.join(root, 'ai', 'hard.md'));
  await assert.rejects(brain.create('ai/hard.md', 'clobber'));
  for (const name of ['ai/linked.md', 'ai/hard.md']) {
    await assert.rejects(brain.edit(name, hash('outside-secret'), [{ oldText: 'outside', newText: 'changed' }]));
  }
  assert.equal(await fs.readFile(secret, 'utf8'), 'outside-secret');
  await assert.rejects(fs.stat(path.join(base, 'outside', 'new.md')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(root, 'ai', 'missing')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(root, 'ai', 'node_modules')), /ENOENT/);
  await fs.unlink(path.join(root, 'ai', 'hard.md'));
  await assert.rejects(brain.edit('missing.md', hash(''), [{ oldText: 'x', newText: 'y' }]), /ENOENT/);
  await fs.writeFile(path.join(root, 'existing.md'), 'Orchid original');
  const existing = await brain.read('existing.md');
  await brain.edit('existing.md', existing.hash, [{ oldText: 'original', newText: 'edited' }]);
  assert.equal((await brain.read('existing.md')).content, 'Orchid edited');
  assert.equal((await brain.search('Orchid')).results.length, 1);
  for (const name of ['ai/note.md', 'ai/nested/note.md', 'meetings/2026-11-05-standup.md']) {
    assert.equal((await brain.create(name, 'valid Markdown')).committed, true);
    await assert.rejects(brain.create(name, 'clobber'), /EEXIST/);
    assert.equal((await brain.read(name)).content, 'valid Markdown');
  }
  await fs.writeFile(path.join(root, 'invalid.md'), Buffer.from([0xff]));
  await assert.rejects(brain.read('invalid.md'));
  await assert.rejects(brain.edit('invalid.md', hash(Buffer.from([0xff])), [{ oldText: 'x', newText: 'y' }]));
  assert.deepEqual(await fs.readFile(path.join(root, 'invalid.md')), Buffer.from([0xff]));
  assert.ok(!(await fs.readdir(path.join(root, 'ai'))).some(n => n.endsWith('.tmp')));
});

test('creation does not make ai/ or follow a symlink in its place', async t => {
  const { brain, root, base } = await fixture(t);
  await fs.rmdir(path.join(root, 'ai'));
  await assert.rejects(brain.create('ai/note.md', 'missing parent'), /ENOENT/);
  await assert.rejects(fs.stat(path.join(root, 'ai')), /ENOENT/);
  await fs.mkdir(path.join(base, 'outside'));
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'ai'));
  await assert.rejects(brain.create('ai/note.md', 'symlink parent'));
  assert.deepEqual(await fs.readdir(path.join(base, 'outside')), []);
});

test('index failure after write reports committed + stale and recovers', async t => {
  const { brain } = await fixture(t);
  const update = brain.store.update;
  brain.store.update = async () => { throw new Error('fixture indexing failure'); };
  const result = await brain.create('ai/note.md', 'still authoritative');
  assert.equal(result.committed, true);
  assert.ok(result.freshness.state === 'stale');
  assert.match(result.freshness.reason, /fixture indexing failure/);
  assert.equal((await brain.read('ai/note.md')).content, 'still authoritative');
  brain.store.update = update;
  assert.equal((await brain.refresh()).freshness.state, 'snapshot');
});

test('compiled TypeScript MCP entrypoint works over stdio and releases locks on EOF', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-stdio-'));
  const root = path.join(base, 'notes');
  const state = path.join(base, 'state');
  await fs.mkdir(path.join(root, 'ai'), { recursive: true });
  const client = new Client({ name: 'stdio-fixture', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/main.js', import.meta.url)), root, state],
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); await fs.rm(base, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  const result = await client.callTool({ name: 'note_create', arguments: { path: 'ai/hello.md', content: '# Hello\nfixture' } });
  assert.ok(!result.isError);
  assert.equal(await fs.readFile(path.join(root, 'ai/hello.md'), 'utf8'), '# Hello\nfixture');
  const rejected = await client.callTool({ name: 'note_create', arguments: { path: 'outside.md', content: 'forbidden' } });
  assert.equal(rejected.isError, true);
  await assert.rejects(fs.stat(path.join(root, 'outside.md')), /ENOENT/);
  await fs.mkdir(path.join(root, 'ai', 'attachments'));
  const image = await client.callTool({ name: 'attachment_create', arguments: { path: 'ai/attachments/stdio.png', base64: png } });
  assert.ok(!image.isError, JSON.stringify(image));
  assert.deepEqual(await fs.readFile(path.join(root, 'ai', 'attachments', 'stdio.png')), Buffer.from(png, 'base64'));
  const outsideImage = await client.callTool({ name: 'attachment_create', arguments: { path: 'outside.png', base64: png } });
  assert.equal(outsideImage.isError, true);
  await client.close();
  await assert.rejects(fs.stat(path.join(root, '.brain-writer.lock')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(state, 'writer.lock')), /ENOENT/);
});

test('second process/state opener cannot take ownership of live lock', async t => {
  const { brain, root, state } = await fixture(t);
  await assert.rejects(Brain.open(root, state), /EEXIST/);
  const otherState = path.join(path.dirname(state), 'other-state');
  await assert.rejects(Brain.open(root, otherState), /EEXIST/);
  await assert.rejects(fs.stat(path.join(otherState, 'writer.lock')), /ENOENT/);
  assert.equal((await brain.create('ai/works.md', 'works')).committed, true);
  await fs.stat(path.join(state, 'writer.lock'));
});

test('bounded operation queue rejects work before admission and recovers after success/error', async t => {
  const { brain, root } = await fixture(t, { maxPendingOperations: 2 });
  const created = await brain.create('ai/note.md', 'original');
  const read = brain.read('ai/note.md');
  const edit = brain.edit('ai/note.md', created.hash, [{ oldText: 'original', newText: 'changed' }]);
  assert.equal(brain.status().pendingOperations, 2);
  await assert.rejects(brain.create('ai/rejected.md', 'must not write'), /Server busy/);
  await Promise.all([read, edit]);
  assert.equal(brain.status().pendingOperations, 0);
  await assert.rejects(fs.stat(path.join(root, 'ai/rejected.md')), /ENOENT/);
  await assert.rejects(brain.read('missing.md'));
  assert.equal(brain.status().pendingOperations, 0);
  assert.equal((await brain.read('ai/note.md')).content, 'changed');
  const last = brain.create('ai/last.md', 'drains before shutdown');
  const closing = brain.close();
  await assert.rejects(brain.create('ai/late.md', 'must not write'), /shutting down/);
  await last;
  await closing;
  await assert.rejects(fs.stat(path.join(root, 'ai/late.md')), /ENOENT/);
});

test('collection file/UTF-8 byte budgets are enforced before create/edit publication', async t => {
  const { brain, root } = await fixture(t, { maxCollectionFiles: 2, maxCollectionBytes: 8 });
  const a = await brain.create('ai/a.md', 'abc');
  await brain.create('ai/b.md', 'def');
  await assert.rejects(brain.create('ai/c.md', 'x'), /Collection file limit/);
  await assert.rejects(fs.stat(path.join(root, 'ai/c.md')), /ENOENT/);
  await assert.rejects(brain.edit('ai/a.md', a.hash, [{ oldText: 'abc', newText: 'ééé' }]), /Collection byte limit/);
  assert.equal((await brain.read('ai/a.md')).hash, a.hash);
  const atLimit = await brain.edit('ai/a.md', a.hash, [{ oldText: 'abc', newText: '12345' }]);
  assert.equal(atLimit.committed, true);
  assert.equal(atLimit.freshness.state, 'snapshot');
  await assert.rejects(brain.create('ai/x.md', 'x'), /Collection file limit/);
  assert.equal((await brain.read('ai/a.md')).content, '12345');
});

test('external over-budget collections are explicitly stale and recover when repaired', async t => {
  const { brain, root } = await fixture(t, { maxCollectionFiles: 2, maxCollectionBytes: 8 });
  await brain.create('ai/a.md', 'fits');
  await fs.writeFile(path.join(root, 'ai/a.md'), 'too many bytes');
  const oversized = await brain.refresh();
  assert.ok(oversized.freshness.state === 'stale');
  assert.match(oversized.freshness.reason, /Collection byte limit/);
  await fs.writeFile(path.join(root, 'ai/a.md'), 'fits');
  assert.equal((await brain.refresh()).freshness.state, 'snapshot');
  await fs.writeFile(path.join(root, 'ai/b.md'), '');
  await fs.writeFile(path.join(root, 'ai/c.md'), '');
  assert.equal((await brain.refresh()).freshness.state, 'stale');
  await fs.unlink(path.join(root, 'ai/c.md'));
  assert.equal((await brain.refresh()).freshness.state, 'snapshot');
});

test('directory traversal has entry and depth budgets and closes iterators after rejection', async t => {
  const entries = await fixture(t, { maxScanEntries: 3 });
  await fs.writeFile(path.join(entries.root, 'a.txt'), '');
  await fs.writeFile(path.join(entries.root, 'b.txt'), '');
  await assert.rejects(entries.brain.list(), /scan entry limit/); // Includes the hidden root lock.
  await fs.unlink(path.join(entries.root, 'b.txt'));
  assert.deepEqual((await entries.brain.list()).paths, []);
  const depth = await fixture(t, { maxScanDepth: 1 });
  await fs.mkdir(path.join(depth.root, 'one', 'two'), { recursive: true });
  await assert.rejects(depth.brain.list(), /scan depth limit/);
  await fs.rmdir(path.join(depth.root, 'one', 'two'));
  assert.deepEqual((await depth.brain.list()).paths, []);
});

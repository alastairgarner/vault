import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Brain } from '../src/brain.js';
import { assetsFromEnv, assetUrl, markdownImage, parseBaseUrl } from '../src/assets.js';
import { createServer } from '../src/server.js';
import { hash } from '../src/files.js';
import { png } from './image-fixtures.js';

const base = 'https://files.example.net';

async function fixture(t: TestContext, options: { maxCollectionFiles?: number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-assets-'));
  const root = path.join(dir, 'notes');
  const assets = path.join(dir, 'assets');
  await fs.mkdir(path.join(root, 'ai', 'attachments'), { recursive: true });
  await fs.mkdir(assets);
  const brain = await Brain.open(root, path.join(dir, 'state'), options, { root: assets, baseUrl: parseBaseUrl(base) });
  t.after(async () => { await brain.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { brain, dir, root, assets };
}

test('assets config: both or neither, absolute root, plain http(s) base URL', () => {
  assert.equal(assetsFromEnv({}), undefined);
  assert.equal(assetsFromEnv({ ASSETS_ROOT: '', ASSETS_BASE_URL: '' }), undefined);
  assert.throws(() => assetsFromEnv({ ASSETS_ROOT: '/data/assets' }), /both/);
  assert.throws(() => assetsFromEnv({ ASSETS_BASE_URL: base }), /both/);
  assert.throws(() => assetsFromEnv({ ASSETS_ROOT: 'relative', ASSETS_BASE_URL: base }), /absolute/);
  assert.equal(assetsFromEnv({ ASSETS_ROOT: '/data/assets', ASSETS_BASE_URL: base })?.baseUrl.href, `${base}/`);
  for (const bad of ['files.example.net', 'ftp://x/', 'https://u:p@x/', 'https://x/?a=1', 'https://x/#a', 'javascript:alert(1)']) {
    assert.throws(() => parseBaseUrl(bad), bad);
  }
});

test('asset URLs encode each segment and keep any base path', () => {
  assert.equal(assetUrl(parseBaseUrl(base), 'a/b.png'), `${base}/a/b.png`);
  assert.equal(assetUrl(parseBaseUrl(`${base}/`), 'b.png'), `${base}/b.png`);
  assert.equal(assetUrl(parseBaseUrl(`${base}/vault`), 'b.png'), `${base}/vault/b.png`);
  assert.equal(assetUrl(parseBaseUrl(`${base}/vault/`), 'b.png'), `${base}/vault/b.png`);
  assert.equal(assetUrl(parseBaseUrl(base), 'My shot (1)!.png'), `${base}/My%20shot%20%281%29%21.png`);
  assert.equal(assetUrl(parseBaseUrl(base), 'c:x/#?%.png'), `${base}/c%3Ax/%23%3F%25.png`);
  assert.equal(assetUrl(parseBaseUrl(base), 'café.png'), `${base}/caf%C3%A9.png`);
  assert.equal(markdownImage('dir/My [shot].png', `${base}/x.png`), `![My \\[shot\\]](${base}/x.png)`);
});

test('attachments go to the assets root with URLs, created parents, no overwrite and no vault writes', async t => {
  const { brain, root, assets } = await fixture(t, { maxCollectionFiles: 1 });
  assert.deepEqual(brain.status().attachments, { storage: 'assets', baseUrl: `${base}/` });
  const name = 'competitor ux/2026/home.png';
  const result = await brain.createAttachment(name, png);
  assert.equal(result.path, name);
  assert.equal(result.committed, true);
  assert.equal(result.hash, hash(Buffer.from(png, 'base64')));
  assert.equal('url' in result && result.url, `${base}/competitor%20ux/2026/home.png`);
  assert.equal('markdown' in result && result.markdown, `![home](${base}/competitor%20ux/2026/home.png)`);
  assert.deepEqual(await fs.readFile(path.join(assets, name)), Buffer.from(png, 'base64'));
  // Collision fails; content is untouched.
  await assert.rejects(brain.createAttachment(name, png), /already exists/);
  await assert.rejects(brain.createAttachment('competitor ux/2026/home.jpg', png), /extension/);
  // Vault budgets don't apply: the vault limit is 1 file, yet more assets fit.
  await brain.createAttachment('second.png', png);
  await brain.createAttachment('ai/attachments/looks-like-vault.png', png);
  assert.deepEqual(await fs.readdir(path.join(root, 'ai', 'attachments')), []);
  assert.ok(!(await fs.readdir(assets)).some(entry => entry.endsWith('.tmp')));
});

test('asset writes stay contained; rejected writes create nothing', async t => {
  const { brain, dir, assets } = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(assets, 'escape'));
  for (const name of [
    '../outside/new.png', '/new.png', 'a/../new.png', 'a/./new.png', 'a//new.png', '.hidden.png',
    'a/.git/new.png', 'a\\b.png', 'a\0b.png', 'escape/new.png', 'note.md', 'image.PNG', 'image.svg',
    'a/'.repeat(40) + 'deep.png',
  ]) await assert.rejects(brain.createAttachment(name, png), name);
  await assert.rejects(brain.createAttachment('new/dir/bad.png', Buffer.from('not an image').toString('base64')), /signature/);
  assert.deepEqual((await fs.readdir(assets)).sort(), ['.brain-writer.lock', 'escape']);
  assert.deepEqual(await fs.readdir(outside), []);
  // Any existing entry, even a directory, counts as a collision.
  await fs.mkdir(path.join(assets, 'taken.png'));
  await assert.rejects(brain.createAttachment('taken.png', png), /already exists/);
});

test('assets root must exist, be writable-locked and be disjoint from notes and state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-assets-open-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'notes');
  const state = path.join(dir, 'state');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  const baseUrl = parseBaseUrl(base);
  await assert.rejects(Brain.open(root, state, {}, { root: path.join(dir, 'missing'), baseUrl }), /ENOENT/);
  await assert.rejects(Brain.open(root, state, {}, { root: path.join(root, 'assets'), baseUrl }), /disjoint/);
  await assert.rejects(Brain.open(root, state, {}, { root: dir, baseUrl }), /disjoint/);
  await fs.mkdir(path.join(state, 'assets'), { recursive: true });
  await assert.rejects(Brain.open(root, state, {}, { root: path.join(state, 'assets'), baseUrl }), /disjoint/);
  // Failed opens release every lock, so a valid open still succeeds.
  const assets = path.join(dir, 'assets');
  await fs.mkdir(assets);
  const brain = await Brain.open(root, state, {}, { root: assets, baseUrl });
  await assert.rejects(Brain.open(path.join(dir, 'other-notes'), path.join(dir, 'other-state'), {}, { root: assets, baseUrl }));
  await brain.close();
  assert.deepEqual(await fs.readdir(assets), []);
});

test('MCP attachment_create returns the URL and describes external storage', async t => {
  const { brain } = await fixture(t);
  const server = createServer(brain);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(entry => entry.name === 'attachment_create');
  assert.match(tool?.description ?? '', /files\.example\.net/);
  assert.match(tool?.description ?? '', /Do not use !\[\[/);
  const result = await client.callTool({ name: 'attachment_create', arguments: { path: 'x/y.png', base64: png } });
  assert.ok(!result.isError, JSON.stringify(result));
  const parsed = z.object({ url: z.string(), markdown: z.string() }).parse(result.structuredContent);
  assert.equal(parsed.url, `${base}/x/y.png`);
  assert.equal(parsed.markdown, `![y](${base}/x/y.png)`);
});

test('without assets config, attachments stay in the vault', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-assets-off-'));
  const root = path.join(dir, 'notes');
  await fs.mkdir(path.join(root, 'ai', 'attachments'), { recursive: true });
  const brain = await Brain.open(root, path.join(dir, 'state'));
  t.after(async () => { await brain.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(brain.status().attachments, { storage: 'vault', prefix: 'ai/attachments/' });
  const result = await brain.createAttachment('ai/attachments/a.png', png);
  assert.ok(!('url' in result));
  await assert.rejects(brain.createAttachment('elsewhere/a.png', png), /ai\/attachments/);
});

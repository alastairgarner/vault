import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createStore, extractSnippet } from '@tobilu/qmd';
import type { QMDStore } from '@tobilu/qmd';
import { Notes, replaceExact, MAX_BYTES } from './files.js';
import { limitsSchema, MAX_SEARCH_TITLE_LENGTH, MAX_SEARCH_EXCERPT_LENGTH, MAX_SEARCH_DATA_BYTES } from './limits.js';
import type { ResourceLimits } from './limits.js';
import type { ExactEdit } from './files.js';
import { errorMessage, hasErrorCode } from './errors.js';
import { decodeImage, VAULT_ATTACHMENTS } from './images.js';
import { assetUrl, markdownImage } from './assets.js';
import type { AssetsConfig } from './assets.js';
import { assertLinkableName, planMove } from './links.js';
import type { LinkChange } from './links.js';

type ReadResult = Awaited<ReturnType<Notes['read']>>;
type LinkUpdate = { path: string; changes: LinkChange[] } & (
  | { status: 'updated'; hash: string }
  | { status: 'conflict' }
  | { status: 'failed'; error: string }
);

const createRoots = ['ai/', 'meetings/'];
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

type Attachments = { storage: 'assets'; baseUrl: string } | { storage: 'vault'; prefix: string };

export type Freshness = { externalChanges: 'not-monitored' } & (
  | { state: 'pending' }
  | { state: 'stale'; reason: string }
  | { state: 'snapshot'; indexedAt: string; files: number }
);

type BrainStatus = {
  root: string; searchMode: 'qmd-bm25'; freshness: Freshness; attachments: Attachments;
  limits: ResourceLimits; pendingOperations: number;
};

export class Brain {
  static async open(root: string, state: string, options: Partial<ResourceLimits> = {}, assetsConfig?: AssetsConfig): Promise<Brain> {
    const limits = limitsSchema.parse(options);
    const notes = await Notes.open(root, limits);
    let assets: Notes | undefined;
    let lock: string | undefined;
    let store: QMDStore | undefined;
    let ownsStateLock = false;
    let ownsRootLock = false;
    let ownsAssetsLock = false;
    try {
      state = path.resolve(state);
      await fs.mkdir(state, { recursive: true, mode: 0o700 });
      if (await fs.realpath(state) !== state) throw new Error('State path must not contain symlinks');
      if (overlaps(state, notes.root)) throw new Error('Root and state must be disjoint');
      // Never created on demand: a missing assets root is a deployment error.
      if (assetsConfig) assets = await Notes.open(assetsConfig.root, limits);
      if (assets && (overlaps(assets.root, notes.root) || overlaps(assets.root, state))) throw new Error('Assets root must be disjoint from root and state');
      lock = path.join(state, 'writer.lock');
      await fs.mkdir(lock); // Stale locks require manual recovery, never automatic stealing.
      ownsStateLock = true;
      await notes.acquireWriter();
      ownsRootLock = true;
      await assets?.acquireWriter(); // Also proves the assets root is writable.
      ownsAssetsLock = !!assets;
      const snapshot = path.join(state, 'snapshot');
      await fs.mkdir(snapshot, { recursive: true, mode: 0o700 });
      store = await createStore({ dbPath: path.join(state, 'index.sqlite'), config: {
        collections: { notes: { path: snapshot, pattern: '**/*.md' } },
      } });
      return new Brain({ notes, snapshot, store, lock, limits,
        assets: assets && assetsConfig && { notes: assets, baseUrl: assetsConfig.baseUrl } });
    } catch (error) {
      await store?.close();
      // Never remove a lock owned by another process.
      if (ownsStateLock && lock) await fs.rmdir(lock);
      if (ownsRootLock) await notes.releaseWriter();
      if (ownsAssetsLock) await assets?.releaseWriter();
      await assets?.close();
      await notes.close();
      throw error;
    }
  }
  private readonly notes: Notes;
  private readonly assets: { notes: Notes; baseUrl: URL } | undefined;
  private readonly snapshot: string;
  readonly store: QMDStore;
  private readonly lock: string;
  private tail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private accepting = true;
  private closing: Promise<void> | undefined;
  private readonly limits: ResourceLimits;
  private freshness: Freshness = { state: 'stale', reason: 'Not refreshed this session', externalChanges: 'not-monitored' };

  private constructor({ notes, assets, snapshot, store, lock, limits }: {
    notes: Notes; assets: { notes: Notes; baseUrl: URL } | undefined;
    snapshot: string; store: QMDStore; lock: string; limits: ResourceLimits;
  }) {
    this.notes = notes;
    this.assets = assets;
    this.snapshot = snapshot;
    this.store = store;
    this.lock = lock;
    this.limits = limits;
  }
  // Global serialization is intentionally stronger than per-file serialization.
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Server is shutting down'));
    if (this.pendingOperations >= this.limits.maxPendingOperations) return Promise.reject(new Error('Server busy: operation capacity reached; retry later'));
    this.pendingOperations++;
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result.finally(() => { this.pendingOperations--; });
  }
  status(): BrainStatus {
    return { root: this.notes.root, searchMode: 'qmd-bm25', freshness: { ...this.freshness }, attachments: this.attachments,
      limits: { ...this.limits }, pendingOperations: this.pendingOperations };
  }
  get attachments(): Attachments {
    return this.assets ? { storage: 'assets', baseUrl: this.assets.baseUrl.href } : { storage: 'vault', prefix: VAULT_ATTACHMENTS };
  }
  // `undefined` bytes means the write removes that file.
  private async checkWriteCapacity(writes: ReadonlyMap<string, number | undefined>) {
    if ([...writes.values()].some(bytes => bytes !== undefined && bytes > MAX_BYTES)) throw new Error('File too large');
    const names = await this.notes.list(true);
    const existing = new Set(names);
    let files = names.length;
    let bytes = 0;
    for (const [name, size] of writes) {
      if (!existing.has(name) && size !== undefined) files++;
      if (existing.has(name) && size === undefined) files--;
      bytes += size ?? 0;
    }
    if (files > names.length && files > this.limits.maxCollectionFiles) throw new Error('Collection file limit exceeded');
    for (const name of names) {
      if (!writes.has(name)) bytes += await this.notes.size(name);
      if (bytes > this.limits.maxCollectionBytes) throw new Error('Collection byte limit exceeded');
    }
    if (bytes > this.limits.maxCollectionBytes) throw new Error('Collection byte limit exceeded');
  }
  private async refreshInternal() {
    this.freshness = { externalChanges: 'not-monitored', state: 'pending' };
    try {
      // Stage only reads that passed the same containment rules as note_read.
      const names = await this.notes.list();
      await fs.rm(this.snapshot, { recursive: true, force: true });
      await fs.mkdir(this.snapshot, { mode: 0o700 });
      let bytes = 0;
      for (const name of names) {
        const file = await this.notes.read(name);
        bytes += Buffer.byteLength(file.content);
        if (bytes > this.limits.maxCollectionBytes) throw new Error('Collection byte limit exceeded');
        const target = path.join(this.snapshot, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, file.content, { mode: 0o600 });
      }
      const result = await this.store.update({ collections: ['notes'] });
      this.freshness = { state: 'snapshot', indexedAt: new Date().toISOString(), externalChanges: 'not-monitored', files: names.length };
      return { ...this.status(), result };
    } catch (error) {
      this.freshness = { externalChanges: 'not-monitored', state: 'stale', reason: errorMessage(error).slice(0, 512) };
      return this.status();
    }
  }
  refresh() { return this.run(() => this.refreshInternal()); }
  list() { return this.run(async () => ({ paths: await this.notes.list(), ...this.status() })); }
  read(name: string, fromLine = 1, maxLines = 200) {
    return this.run(async () => {
      const file = await this.notes.read(name);
      const lines = file.content.split('\n');
      return { path: name, hash: file.hash, fromLine, totalLines: lines.length,
        content: lines.slice(fromLine - 1, fromLine - 1 + maxLines).join('\n') };
    });
  }
  create(name: string, content: string) {
    return this.run(async () => {
      if (!createRoots.some(root => name.startsWith(root))) throw new Error('New notes must be created inside root-relative lowercase ai/ or meetings/');
      await this.checkWriteCapacity(new Map([[name, Buffer.byteLength(content)]]));
      const result = await this.notes.publish(name, content, true);
      this.freshness = { ...this.freshness, state: 'stale', reason: 'File changed' };
      await this.refreshInternal();
      return { ...result, committed: true, freshness: this.status().freshness };
    });
  }
  createAttachment(name: string, base64: string) {
    if (this.assets) return this.createAsset(this.assets, name, base64);
    return this.run(async () => {
      const { bytes, mimeType } = decodeImage(name, base64);
      await this.checkWriteCapacity(new Map([[name, bytes.length]]));
      const result = await this.notes.createImage(name, bytes);
      return { ...result, committed: true, bytes: bytes.length, mimeType };
    });
  }
  // Outside the vault: no collection budget, missing parents are created, never overwrites.
  private createAsset(assets: { notes: Notes; baseUrl: URL }, name: string, base64: string) {
    return this.run(async () => {
      const { bytes, mimeType } = decodeImage(name, base64, { requirePrefix: false });
      if (name.split('/').length - 1 > this.limits.maxScanDepth) throw new Error('Asset path depth limit exceeded');
      const created = await assets.notes.makeParents(name, true);
      let result: { path: string; hash: string };
      try { result = await assets.notes.createImage(name, bytes); }
      catch (error) {
        await assets.notes.removeEmptyDirectories(created);
        if (hasErrorCode(error, 'EEXIST')) throw new Error(`Asset already exists: ${name}; choose another path`);
        throw error;
      }
      const url = assetUrl(assets.baseUrl, name);
      return { ...result, url, markdown: markdownImage(name, url), committed: true, bytes: bytes.length, mimeType };
    });
  }
  edit(name: string, expectedHash: string, edits: readonly ExactEdit[]) {
    return this.run(async () => {
      const file = await this.notes.read(name); // Hash checked INSIDE write serialization.
      if (file.hash !== expectedHash) throw new Error('Content hash conflict; read again');
      const content = replaceExact(file.content, edits);
      await this.checkWriteCapacity(new Map([[name, Buffer.byteLength(content)]]));
      const result = await this.notes.publish(name, content, false);
      this.freshness = { ...this.freshness, state: 'stale', reason: 'File changed' };
      await this.refreshInternal();
      return { ...result, committed: true, freshness: this.status().freshness };
    });
  }
  move({ from, to, expectedHash, dryRun }: { from: string; to: string; expectedHash: string; dryRun: boolean }) {
    return this.run(async () => {
      if (from === to) throw new Error('Destination must differ from source');
      this.notes.checkPath(to);
      assertLinkableName(to);
      if (to.split('/').length - 1 > this.limits.maxScanDepth) throw new Error('Collection scan depth limit exceeded');
      const source = await this.notes.read(from); // Hash checked INSIDE write serialization.
      if (source.hash !== expectedHash) throw new Error('Content hash conflict; read again');
      const names = await this.notes.list();
      const clash = names.find(name => name !== from && name.toLowerCase() === to.toLowerCase());
      if (clash) throw new Error(clash === to ? 'Destination already exists' : `Destination differs only by case from ${clash}`);
      // Notes that cannot be read cannot be scanned for links; report rather than guess.
      const notes = new Map<string, ReadResult>();
      const unreadable: { path: string; error: string }[] = [];
      let bytes = 0;
      for (const name of names) {
        let file: ReadResult;
        try { file = await this.notes.read(name); }
        catch (error) { unreadable.push({ path: name, error: errorMessage(error).slice(0, 512) }); continue; }
        // Bound retained content by the same budget writes must fit.
        bytes += Buffer.byteLength(file.content);
        if (bytes > this.limits.maxCollectionBytes) throw new Error('Collection byte limit exceeded');
        notes.set(name, file);
      }
      const plan = planMove({ from, to, format: await this.notes.linkFormat(),
        notes: new Map([...notes].map(([name, file]) => [name, file.content])) });
      const moved = plan.updates.get(from)?.content ?? source.content;
      const writes = new Map<string, number | undefined>([[from, undefined], [to, Buffer.byteLength(moved)]]);
      for (const [name, update] of plan.updates) if (name !== from) writes.set(name, Buffer.byteLength(update.content));
      await this.checkWriteCapacity(writes);
      const planned = [...plan.updates].map(([name, update]) => ({ path: name === from ? to : name, changes: update.changes }));
      if (dryRun) return { from, to, dryRun, committed: false, links: planned.map(link => ({ ...link, status: 'planned' as const })), unreadable, warnings: plan.warnings };

      const created = await this.notes.makeParents(to);
      let published: { hash: string };
      try {
        published = await this.notes.publish(to, moved, true);
        try { await this.notes.remove(from, expectedHash); }
        catch (error) {
          await this.notes.remove(to, published.hash).catch(rollback => {
            throw new Error(`${errorMessage(error)}; both ${from} and ${to} now exist (rollback failed: ${errorMessage(rollback)})`);
          });
          throw error;
        }
      } catch (error) {
        await this.notes.removeEmptyDirectories(created);
        throw error;
      }
      // The move is committed; each linking note is then updated under its own hash guard.
      const links: LinkUpdate[] = [];
      for (const { path: name, changes } of planned) {
        if (name === to) { links.push({ path: name, changes, status: 'updated', hash: published.hash }); continue; }
        const update = plan.updates.get(name);
        const original = notes.get(name);
        if (!update || !original) continue;
        try {
          if ((await this.notes.read(name)).hash !== original.hash) { links.push({ path: name, changes, status: 'conflict' }); continue; }
          links.push({ path: name, changes, status: 'updated', hash: (await this.notes.publish(name, update.content, false)).hash });
        } catch (error) {
          links.push({ path: name, changes, status: 'failed', error: errorMessage(error).slice(0, 512) });
        }
      }
      this.freshness = { ...this.freshness, state: 'stale', reason: 'File changed' };
      await this.refreshInternal();
      return { from, to, hash: published.hash, dryRun, committed: true, links, unreadable, warnings: plan.warnings, freshness: this.status().freshness };
    });
  }
  search(query: string, limit = 10) {
    return this.run(async () => {
      await this.refreshInternal(); // Explicitly observe external edits before every search.
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be 1–50');
      const hits = await this.store.searchLex(query, { collection: 'notes', limit });
      const results: { reference: string; title: string; titleTruncated: boolean; score: number; excerpt: string }[] = [];
      const response = { ...this.status(), results, resultsTruncated: false };
      for (const hit of hits) {
        results.push({
          reference: hit.filepath,
          title: hit.title.slice(0, MAX_SEARCH_TITLE_LENGTH),
          titleTruncated: hit.title.length > MAX_SEARCH_TITLE_LENGTH,
          score: hit.score,
          excerpt: extractSnippet(hit.body ?? '', query, MAX_SEARCH_EXCERPT_LENGTH).snippet.slice(0, MAX_SEARCH_EXCERPT_LENGTH),
        });
        if (Buffer.byteLength(JSON.stringify(response)) > MAX_SEARCH_DATA_BYTES) {
          results.pop();
          response.resultsTruncated = true;
          break;
        }
      }
      return response;
    });
  }
  close(): Promise<void> {
    this.accepting = false;
    this.closing ??= (async () => {
      await this.tail;
      try { await this.store.close(); }
      finally {
        try { await this.notes.releaseWriter(); await this.assets?.notes.releaseWriter(); }
        finally { await this.notes.close(); await this.assets?.notes.close(); await fs.rmdir(this.lock); }
      }
    })();
    return this.closing;
  }
}

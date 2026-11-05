import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createStore, extractSnippet } from '@tobilu/qmd';
import type { QMDStore } from '@tobilu/qmd';
import { Notes, replaceExact, MAX_BYTES } from './files.js';
import { limitsSchema, MAX_SEARCH_TITLE_LENGTH, MAX_SEARCH_EXCERPT_LENGTH, MAX_SEARCH_DATA_BYTES } from './limits.js';
import type { ResourceLimits } from './limits.js';
import type { ExactEdit } from './files.js';
import { errorMessage } from './errors.js';
import { decodeImage } from './images.js';

const createRoots = ['ai/', 'meetings/'];

export type Freshness = { externalChanges: 'not-monitored' } & (
  | { state: 'pending' }
  | { state: 'stale'; reason: string }
  | { state: 'snapshot'; indexedAt: string; files: number }
);

type BrainStatus = {
  root: string; searchMode: 'qmd-bm25'; freshness: Freshness;
  limits: ResourceLimits; pendingOperations: number;
};

export class Brain {
  static async open(root: string, state: string, options: Partial<ResourceLimits> = {}): Promise<Brain> {
    const limits = limitsSchema.parse(options);
    const notes = await Notes.open(root, limits);
    let lock: string | undefined;
    let store: QMDStore | undefined;
    let ownsStateLock = false;
    let ownsRootLock = false;
    try {
      state = path.resolve(state);
      await fs.mkdir(state, { recursive: true, mode: 0o700 });
      if (await fs.realpath(state) !== state) throw new Error('State path must not contain symlinks');
      if (state === notes.root || state.startsWith(notes.root + '/') || notes.root.startsWith(state + '/')) throw new Error('Root and state must be disjoint');
      lock = path.join(state, 'writer.lock');
      await fs.mkdir(lock); // Stale locks require manual recovery, never automatic stealing.
      ownsStateLock = true;
      await notes.acquireWriter();
      ownsRootLock = true;
      const snapshot = path.join(state, 'snapshot');
      await fs.mkdir(snapshot, { recursive: true, mode: 0o700 });
      store = await createStore({ dbPath: path.join(state, 'index.sqlite'), config: {
        collections: { notes: { path: snapshot, pattern: '**/*.md' } },
      } });
      return new Brain({ notes, snapshot, store, lock, limits });
    } catch (error) {
      await store?.close();
      // Never remove a lock owned by another process.
      if (ownsStateLock && lock) await fs.rmdir(lock);
      if (ownsRootLock) await notes.releaseWriter();
      await notes.close();
      throw error;
    }
  }
  private readonly notes: Notes;
  private readonly snapshot: string;
  readonly store: QMDStore;
  private readonly lock: string;
  private tail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private accepting = true;
  private closing: Promise<void> | undefined;
  private readonly limits: ResourceLimits;
  private freshness: Freshness = { state: 'stale', reason: 'Not refreshed this session', externalChanges: 'not-monitored' };

  private constructor({ notes, snapshot, store, lock, limits }: {
    notes: Notes; snapshot: string; store: QMDStore; lock: string; limits: ResourceLimits;
  }) {
    this.notes = notes;
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
    return { root: this.notes.root, searchMode: 'qmd-bm25', freshness: { ...this.freshness }, limits: { ...this.limits }, pendingOperations: this.pendingOperations };
  }
  private async checkWriteCapacity(name: string, newBytes: number) {
    if (newBytes > MAX_BYTES) throw new Error('File too large');
    const names = await this.notes.list(true);
    if (!names.includes(name) && names.length >= this.limits.maxCollectionFiles) throw new Error('Collection file limit exceeded');
    let bytes = newBytes;
    for (const existing of names) {
      if (existing !== name) bytes += await this.notes.size(existing);
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
      await this.checkWriteCapacity(name, Buffer.byteLength(content));
      const result = await this.notes.publish(name, content, true);
      this.freshness = { ...this.freshness, state: 'stale', reason: 'File changed' };
      await this.refreshInternal();
      return { ...result, committed: true, freshness: this.status().freshness };
    });
  }
  createAttachment(name: string, base64: string) {
    return this.run(async () => {
      const { bytes, mimeType } = decodeImage(name, base64);
      await this.checkWriteCapacity(name, bytes.length);
      const result = await this.notes.createImage(name, bytes);
      return { ...result, committed: true, bytes: bytes.length, mimeType };
    });
  }
  edit(name: string, expectedHash: string, edits: readonly ExactEdit[]) {
    return this.run(async () => {
      const file = await this.notes.read(name); // Hash checked INSIDE write serialization.
      if (file.hash !== expectedHash) throw new Error('Content hash conflict; read again');
      const content = replaceExact(file.content, edits);
      await this.checkWriteCapacity(name, Buffer.byteLength(content));
      const result = await this.notes.publish(name, content, false);
      this.freshness = { ...this.freshness, state: 'stale', reason: 'File changed' };
      await this.refreshInternal();
      return { ...result, committed: true, freshness: this.status().freshness };
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
        try { await this.notes.releaseWriter(); }
        finally { await this.notes.close(); await fs.rmdir(this.lock); }
      }
    })();
    return this.closing;
  }
}

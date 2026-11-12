import { constants as C } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BinaryLike } from 'node:crypto';
import { hasErrorCode } from './errors.js';
import { imagePath, VAULT_ATTACHMENTS } from './images.js';
import { limitsSchema, MAX_NOTE_PATH_BYTES } from './limits.js';
import type { ResourceLimits } from './limits.js';
import type { LinkFormat } from './links.js';
import { z } from 'zod';

export type ExactEdit = { oldText: string; newText: string };
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const hash = (content: BinaryLike) => createHash('sha256').update(content).digest('hex');
export const MAX_BYTES = 1024 * 1024;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const directoryFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

const MAX_SETTINGS_BYTES = 64 * 1024;
const settingsSchema = z.object({ newLinkFormat: z.enum(['shortest', 'relative', 'absolute']).catch('shortest').default('shortest') });

async function openSingleFile(target: string) {
  const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  const stat = await handle.stat();
  if (stat.isFile() && stat.nlink === 1) return handle;
  await handle.close();
  throw new Error('Not a supported single-link file');
}

async function hashHandle(handle: FileHandle) {
  const digest = createHash('sha256');
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function syncDirectory(parent: string) {
  const dir = await fs.open(`${parent}/.`, directoryFlags);
  try { await dir.sync(); } finally { await dir.close(); }
}

// Linux dirfd anchoring: no check-then-follow ancestor symlink window.
export class Notes {
  static async open(root: string, limits: ResourceLimits = limitsSchema.parse({})) {
    if (process.platform !== 'linux') throw new Error('This prototype requires Linux /proc/self/fd');
    const absolute = path.resolve(root);
    if (await fs.realpath(absolute) !== absolute) throw new Error('Root must not contain symlinks');
    return new Notes(absolute, await fs.open(absolute, directoryFlags), limits);
  }
  private constructor(readonly root: string, private readonly handle: FileHandle, private readonly limits: ResourceLimits) {}
  private parts(name: string, image: boolean) {
    if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || path.isAbsolute(name)) throw new Error('Invalid path');
    if (Buffer.byteLength(name) > MAX_NOTE_PATH_BYTES) throw new Error('Note path exceeds 1024 bytes');
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Use a relative, non-hidden path');
    if (image ? !imagePath.test(name) : !name.endsWith('.md')) throw new Error(image ? 'Use a supported lowercase image extension' : 'Use a .md path');
    return parts;
  }
  private async parent<T>(name: string, action: (target: string, parent: string) => Promise<T>, image = false): Promise<T> {
    const parts = this.parts(name, image);
    return this.directory(parts.slice(0, -1), parent => action(`${parent}/${parts.at(-1)}`, parent));
  }
  private async directory<T>(parts: readonly string[], action: (parent: string) => Promise<T>): Promise<T> {
    const handles: FileHandle[] = [];
    let parent = this.handle;
    try {
      for (const part of parts) {
        parent = await fs.open(`${fdPath(parent)}/${part}`, directoryFlags);
        handles.push(parent);
      }
      return await action(fdPath(parent));
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
  checkPath(name: string) { this.parts(name, false); }
  async read(name: string) {
    return this.parent(name, async target => {
      const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Not a supported single-link Markdown file (max 1 MiB)');
        const bytes = await handle.readFile();
        if (bytes.length > MAX_BYTES) throw new Error('File too large');
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return { path: name, content, hash: hash(bytes) };
      } finally { await handle.close(); }
    });
  }
  async size(name: string): Promise<number> {
    return this.parent(name, async target => {
      const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Not a supported single-link file (max 1 MiB)');
        return stat.size;
      } finally { await handle.close(); }
    }, imagePath.test(name));
  }
  async list(includeImages = false) {
    return this.scan(name => name.endsWith('.md') || (includeImages && name.startsWith(VAULT_ATTACHMENTS) && imagePath.test(name)));
  }
  // Every supported image anywhere under the root (external assets store).
  async listImages() { return this.scan(name => imagePath.test(name)); }
  // Images may be added externally (e.g. scp), so no 1 MiB cap here; hashing streams.
  async imageInfo(name: string) {
    return this.parent(name, async target => {
      const handle = await openSingleFile(target);
      try { return { bytes: (await handle.stat()).size, hash: await hashHandle(handle) }; }
      finally { await handle.close(); }
    }, true);
  }
  // Hash checked immediately before unlinking; external writers can still race this window.
  async removeImage(name: string, expectedHash: string) {
    await this.parent(name, async (target, parent) => {
      const handle = await openSingleFile(target);
      try { if (await hashHandle(handle) !== expectedHash) throw new Error('Content hash conflict; list again'); }
      finally { await handle.close(); }
      await fs.unlink(target);
      await syncDirectory(parent);
    }, true);
  }
  private async scan(accept: (name: string) => boolean) {
    const notes: string[] = [];
    let scanned = 0;
    const walk = async (handle: FileHandle, prefix: string, depth: number): Promise<void> => {
      // Streaming iteration bounds memory even in directories with excessive entries.
      const directory = await fs.opendir(fdPath(handle));
      for await (const entry of directory) {
        if (++scanned > this.limits.maxScanEntries) throw new Error('Collection scan entry limit exceeded');
        if (entry.name.startsWith('.')) continue;
        const name = prefix + entry.name;
        if (Buffer.byteLength(name) > MAX_NOTE_PATH_BYTES) throw new Error('Collection path limit exceeded');
        if (entry.isDirectory()) {
          if (depth >= this.limits.maxScanDepth) throw new Error('Collection scan depth limit exceeded');
          const child = await fs.open(`${fdPath(handle)}/${entry.name}`, directoryFlags);
          try { await walk(child, name + '/', depth + 1); } finally { await child.close(); }
        } else if (entry.isFile() && accept(name)) {
          if (notes.length >= this.limits.maxCollectionFiles) throw new Error('Collection file limit exceeded');
          notes.push(name);
        }
      }
    };
    await walk(this.handle, '', 0);
    return notes.sort();
  }
  async publish(name: string, content: string, create: boolean) {
    return this.publishBytes(name, Buffer.from(content, 'utf8'), create, false);
  }
  async createImage(name: string, bytes: Buffer) {
    return this.publishBytes(name, bytes, true, true);
  }
  private async publishBytes(name: string, content: Buffer, create: boolean, image: boolean) {
    if (content.length > MAX_BYTES) throw new Error('File too large');
    return this.parent(name, async (target, parent) => {
      const temporary = `${parent}/.brain-${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try {
        try { await handle.writeFile(content); await handle.sync(); }
        finally { await handle.close(); }
        if (create) await fs.link(temporary, target); // Atomic no-clobber publication.
        else await fs.rename(temporary, target);
        await syncDirectory(parent);
      } finally { await fs.unlink(temporary).catch(error => { if (!hasErrorCode(error, 'ENOENT')) throw error; }); }
      return { path: name, hash: hash(content) };
    }, image);
  }
  // Returns created directories, shallowest first, for cleanup after a failed move.
  async makeParents(name: string, image = false) {
    const parts = this.parts(name, image).slice(0, -1);
    const created: string[] = [];
    for (const [index, part] of parts.entries()) {
      await this.directory(parts.slice(0, index), async parent => {
        try { await fs.mkdir(`${parent}/${part}`, { mode: 0o700 }); }
        catch (error) { if (!hasErrorCode(error, 'EEXIST')) throw error; return; }
        created.push(parts.slice(0, index + 1).join('/'));
      });
    }
    return created;
  }
  async removeEmptyDirectories(names: readonly string[]) {
    for (const name of [...names].reverse()) {
      const parts = name.split('/');
      await this.directory(parts.slice(0, -1), parent => fs.rmdir(`${parent}/${parts.at(-1)}`)).catch(() => {});
    }
  }
  // Hash checked immediately before unlinking; external writers can still race this window.
  async remove(name: string, expectedHash: string) {
    await this.parent(name, async (target, parent) => {
      const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Not a supported single-link Markdown file (max 1 MiB)');
        if (hash(await handle.readFile()) !== expectedHash) throw new Error('Content hash conflict; read again');
      } finally { await handle.close(); }
      await fs.unlink(target);
      await syncDirectory(parent);
    });
  }
  // Obsidian's "New link format"; a missing or invalid app.json means Obsidian's default.
  async linkFormat(): Promise<LinkFormat> {
    try {
      return await this.directory(['.obsidian'], async parent => {
        const handle = await fs.open(`${parent}/app.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return 'shortest';
          return settingsSchema.parse(JSON.parse(await handle.readFile('utf8'))).newLinkFormat;
        } finally { await handle.close(); }
      });
    } catch { return 'shortest'; }
  }
  async acquireWriter() { await fs.mkdir(`${fdPath(this.handle)}/.brain-writer.lock`, { mode: 0o700 }); }
  async releaseWriter() { await fs.rmdir(`${fdPath(this.handle)}/.brain-writer.lock`); }
  async close() { await this.handle.close(); }
}

// All replacements refer to the ORIGINAL content, never preceding edits.
export function replaceExact(content: string, edits: readonly ExactEdit[]): string {
  const ranges = edits.map(({ oldText, newText }) => {
    if (!oldText) throw new Error('Empty oldText');
    const start = content.indexOf(oldText);
    if (start < 0 || content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText must match exactly once');
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.start < previousEnd) throw new Error('Overlapping replacements');
    previousEnd = range.end;
  }
  for (const r of ranges.reverse()) content = content.slice(0, r.start) + r.newText + content.slice(r.end);
  return content;
}

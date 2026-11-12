import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Brain } from './brain.js';
import { errorMessage } from './errors.js';
import { MAX_SEARCH_RESPONSE_BYTES } from './limits.js';
import { MAX_IMAGE_BASE64_LENGTH } from './images.js';

async function respond<T extends Record<string, unknown>>(action: () => T | Promise<T>, maxResponseBytes?: number): Promise<CallToolResult> {
  try {
    const result = await action();
    const response: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    if (maxResponseBytes !== undefined && Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes) throw new Error('Search response exceeds byte budget');
    return response;
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
  }
}

export function createServer(brain: Brain): McpServer {
  const server = new McpServer({ name: 'vault', version: '0.2.0' });
  const name = z.string().min(1).max(1024);
  const text = z.string().max(1024 * 1024);
  const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

  server.registerTool('brain_status', {
    description: 'Allowed root and explicit index freshness. Snapshot never guarantees absence of external changes.',
    inputSchema: {},
  }, () => respond(() => brain.status()));

  server.registerTool('note_list', {
    description: 'List non-hidden Markdown notes; no symlinks followed.',
    inputSchema: {},
  }, () => respond(() => brain.list()));

  server.registerTool('note_read', {
    description: 'Read authoritative disk lines, with SHA-256 of the entire UTF-8 file for editing.',
    inputSchema: {
      path: name,
      fromLine: z.number().int().min(1).default(1),
      maxLines: z.number().int().min(1).max(1000).default(200),
    },
  }, a => respond(() => brain.read(a.path, a.fromLine, a.maxLines)));

  server.registerTool('note_create', {
    description: 'Atomically create a Markdown note strictly inside root-relative lowercase ai/ or meetings/ (including existing subdirectories); parent directory must already exist; never overwrite.',
    inputSchema: { path: name, content: text },
  }, a => respond(() => brain.create(a.path, a.content)));

  const imageRules = 'Pass canonical padded base64 (no data URL), max 1 MiB decoded. PNG, JPEG, GIF or WebP only, checked by signature and matching lowercase extension; no SVG. Never overwrites: an existing path fails, so choose a new name. Images are not indexed.';
  const attachments = brain.attachments;
  server.registerTool('attachment_create', {
    description: attachments.storage === 'assets'
      ? `Upload an image to the external asset store served at ${attachments.baseUrl} (not the vault, not synced). path is relative to that store, e.g. project/screenshot.png; missing folders are created. ${imageRules} Returns url and a ready-made markdown embed; insert that into a note with note_edit. Do not use ![[...]] wiki embeds for these images.`
      : `Create an image strictly inside root-relative lowercase ${attachments.prefix}; parent directory must already exist. ${imageRules} Returns the vault-relative path; use note_edit separately to embed it.`,
    inputSchema: { path: name, base64: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH) },
  }, a => respond(() => brain.createAttachment(a.path, a.base64)));

  if (attachments.storage === 'assets') {
    server.registerTool('attachment_list', {
      description: `List images in the external asset store (${attachments.baseUrl}), sorted by path, with url, bytes, SHA-256 hash and the vault notes that link to each (referencedBy). Filter by path prefix; page with offset/limit. Images with empty referencedBy are unused.`,
      inputSchema: {
        prefix: z.string().max(1024).default(''),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      },
    }, a => respond(() => brain.listAttachments(a)));

    server.registerTool('attachment_delete', {
      description: 'Delete an image from the external asset store, guarded by its SHA-256 (from attachment_create or attachment_list). Refused while any note still links to it, or if any note cannot be checked; edit those notes first. Empty parent folders are removed. Irreversible except via backups.',
      inputSchema: { path: name, expectedHash: sha256 },
    }, a => respond(() => brain.deleteAttachment(a.path, a.expectedHash)));
  }

  server.registerTool('note_edit', {
    description: 'Edit an existing Markdown note anywhere in the allowed root, not just ai/. Exact unique, non-overlapping replacements against original content, guarded by full-file SHA-256. No blind overwrite.',
    inputSchema: {
      path: name,
      expectedHash: sha256,
      edits: z.array(z.object({ oldText: text.min(1), newText: text })).min(1).max(100),
    },
  }, a => respond(() => brain.edit(a.path, a.expectedHash, a.edits)));

  server.registerTool('note_move', {
    description: 'Move or rename an existing Markdown note anywhere in the allowed root, updating [[wiki]] and relative Markdown links to it across the vault like Obsidian (using its New link format setting). Guarded by the source\'s full-file SHA-256; never overwrites; creates missing destination folders. Linking notes changed since planning are reported as conflicts, not overwritten. dryRun returns the planned link changes without writing.',
    inputSchema: {
      path: name,
      newPath: name,
      expectedHash: sha256,
      dryRun: z.boolean().default(false),
    },
  }, a => respond(() => brain.move({ from: a.path, to: a.newPath, expectedHash: a.expectedHash, dryRun: a.dryRun })));

  server.registerTool('brain_refresh', {
    description: 'Rebuild disposable QMD keyword index from a contained snapshot; returns stale on failure.',
    inputSchema: {},
  }, () => respond(() => brain.refresh()));

  server.registerTool('note_search', {
    description: 'QMD BM25 search; refreshes first. Results are indexed snapshots, not authoritative file reads. Check freshness.',
    inputSchema: {
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(50).default(10),
    },
  }, a => respond(() => brain.search(a.query, a.limit), MAX_SEARCH_RESPONSE_BYTES));
  return server;
}

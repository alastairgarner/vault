import path from 'node:path';

// External image store served over HTTP (e.g. Caddy), outside the synced vault.
export type AssetsConfig = { root: string; baseUrl: URL };

export function assetsFromEnv(env: NodeJS.ProcessEnv = process.env): AssetsConfig | undefined {
  const root = env.ASSETS_ROOT || undefined;
  const baseUrl = env.ASSETS_BASE_URL || undefined;
  if (!root && !baseUrl) return undefined;
  if (!root || !baseUrl) throw new Error('Set both ASSETS_ROOT and ASSETS_BASE_URL, or neither');
  if (!path.isAbsolute(root)) throw new Error('ASSETS_ROOT must be absolute');
  return { root, baseUrl: parseBaseUrl(baseUrl) };
}

export function parseBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('ASSETS_BASE_URL must be an absolute URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('ASSETS_BASE_URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('ASSETS_BASE_URL must not include credentials, query or fragment');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// Also encodes !'()* so the URL is safe inside a Markdown link destination.
const encodeSegment = (part: string) =>
  encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// `name` is an already-validated relative path: no empty, dot or hidden segments.
export function assetUrl(baseUrl: URL, name: string): string {
  return new URL(name.split('/').map(encodeSegment).join('/'), baseUrl).href;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decodeSegment = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };

// Asset paths linked from Markdown: bare/encoded URLs and <angle-bracket> destinations,
// ignoring query and fragment. Case-sensitive, matching the file server.
export function referencedAssets(content: string, baseUrl: URL): Set<string> {
  const base = escapeRegex(baseUrl.href);
  const pattern = new RegExp(`<${base}([^>\\n]*)>|${base}([^\\s()<>"'\\[\\]]*)`, 'g');
  const found = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const rest = (match[1] ?? match[2] ?? '').split(/[?#]/)[0] ?? '';
    if (rest) found.add(rest.split('/').map(decodeSegment).join('/'));
  }
  return found;
}

export function markdownImage(name: string, url: string): string {
  const alt = path.posix.basename(name, path.posix.extname(name)).replace(/[\\[\]]/g, '\\$&');
  return `![${alt}](${url})`;
}

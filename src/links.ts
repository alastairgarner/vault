import path from 'node:path';

// Obsidian is closed source. Resolution and generation follow its help pages, the public
// obsidian.d.ts (getFirstLinkpathDest, fileToLinktext, renameFile) and reported behaviour.
export type LinkFormat = 'shortest' | 'relative' | 'absolute';
export type LinkChange = { from: string; to: string };
// `byName` marks Obsidian's name fallback, which works only inside Obsidian.
type Resolution = { path: string; ambiguous: boolean; byName: boolean };

const posix = path.posix;
const stripMd = (name: string) => name.replace(/\.md$/i, '');
const depth = (name: string) => name.split('/').length;
// Obsidian refuses these in file names, or they cannot appear inside a link.
const unsafeNameCharacters = /[*"\\<>:|?#^[\]]/;

export function assertLinkableName(name: string) {
  if (name.split('/').some(part => unsafeNameCharacters.test(part))) throw new Error('Destination must not contain * " \\ < > : | ? # ^ [ ]');
}

class Vault {
  private readonly byPath = new Map<string, string>();
  private readonly byName = new Map<string, string[]>();
  constructor(paths: readonly string[]) {
    for (const name of paths) {
      this.byPath.set(name.toLowerCase(), name);
      const key = posix.basename(name).toLowerCase();
      this.byName.set(key, [...this.byName.get(key) ?? [], name]);
    }
  }
  private exact(name: string) { return this.byPath.get(name.toLowerCase()); }
  isUniqueName(name: string) { return this.byName.get(posix.basename(name).toLowerCase())?.length === 1; }
  // Exact vault path, then relative to the linking note, then the shallowest path suffix match.
  resolve(linkpath: string, source: string): Resolution | undefined {
    let link = linkpath.trim();
    if (!link) return undefined;
    const rooted = link.startsWith('/');
    if (rooted) link = link.slice(1);
    const file = /\.md$/i.test(link) ? link : `${link}.md`;
    const relative = posix.normalize(posix.join(posix.dirname(source), file));
    if (/^\.\.?\//.test(link)) {
      const found = relative.startsWith('../') ? undefined : this.exact(relative);
      return found ? { path: found, ambiguous: false, byName: false } : undefined;
    }
    const exact = this.exact(posix.normalize(file));
    if (exact || rooted) return exact ? { path: exact, ambiguous: false, byName: false } : undefined;
    const sibling = this.exact(relative);
    if (sibling) return { path: sibling, ambiguous: false, byName: false };
    const suffix = '/' + file.toLowerCase();
    const matches = (this.byName.get(posix.basename(file).toLowerCase()) ?? [])
      .filter(name => ('/' + name.toLowerCase()).endsWith(suffix))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    const [first] = matches;
    return first ? { path: first, ambiguous: matches.length > 1, byName: true } : undefined;
  }
}

type Link = {
  start: number; end: number; linkpath: string; text: string | undefined;
  render: (linkpath: string, text: string | undefined) => string;
  keepExtension: boolean; markdown: boolean;
};

// Fenced code blocks and inline code spans never contain links.
function codeRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})/;
  let offset = 0;
  let open: { marker: string; start: number } | undefined;
  let prose = 0;
  for (const line of content.split('\n')) {
    const marker = fence.exec(line)?.[1];
    if (open) {
      if (marker && marker[0] === open.marker[0] && marker.length >= open.marker.length && !line.slice(line.indexOf(marker) + marker.length).trim()) {
        ranges.push([open.start, offset + line.length]);
        open = undefined;
        prose = offset + line.length;
      }
    } else if (marker) {
      ranges.push(...inlineCode(content, prose, offset));
      open = { marker, start: offset };
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, content.length]);
  else ranges.push(...inlineCode(content, prose, content.length));
  return ranges;
}

function inlineCode(content: string, from: number, to: number): [number, number][] {
  const ranges: [number, number][] = [];
  const ticks = /`+/g;
  ticks.lastIndex = from;
  for (let match = ticks.exec(content); match && match.index < to; match = ticks.exec(content)) {
    const paragraphEnd = content.indexOf('\n\n', match.index);
    const limit = Math.min(to, paragraphEnd < 0 ? to : paragraphEnd);
    const closing = new RegExp(`(?<!\`)${match[0]}(?!\`)`, 'g');
    closing.lastIndex = match.index + match[0].length;
    const close = closing.exec(content);
    if (close && close.index < limit) {
      ranges.push([match.index, close.index + close[0].length]);
      ticks.lastIndex = close.index + close[0].length;
    }
  }
  return ranges;
}

function frontmatterEnd(content: string) {
  if (!/^---\r?\n/.test(content)) return 0;
  const end = /\r?\n---[ \t]*(\r?\n|$)/.exec(content.slice(3));
  return end ? 3 + end.index + end[0].length : 0;
}

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

const encode = (value: string) => value.replace(/[%\s()<>]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

function parseLinks(content: string): Link[] {
  const code = codeRanges(content);
  const inCode = (index: number) => code.some(([start, end]) => index >= start && index < end);
  const body = frontmatterEnd(content);
  const links: Link[] = [];
  for (const match of content.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
    if (inCode(match.index)) continue;
    const [whole, embed = '', inner = ''] = match;
    const bar = inner.indexOf('|');
    const escaped = bar > 0 && inner[bar - 1] === '\\';
    const target = bar < 0 ? inner : inner.slice(0, escaped ? bar - 1 : bar);
    const separator = bar < 0 ? '' : escaped ? '\\|' : '|';
    const text = bar < 0 ? undefined : inner.slice(bar + 1);
    const hash = target.indexOf('#');
    const linkpath = hash < 0 ? target : target.slice(0, hash);
    const subpath = hash < 0 ? '' : target.slice(hash);
    links.push({
      start: match.index, end: match.index + whole.length, linkpath, text, markdown: false,
      keepExtension: /\.md$/i.test(linkpath.trim()),
      render: (next, nextText) => `${embed}[[${next}${subpath}${separator}${nextText ?? ''}]]`,
    });
  }
  for (const match of content.matchAll(/(!?)\[([^[\]\n]*)\]\(/g)) {
    if (match.index < body || inCode(match.index)) continue;
    const [opening, embed = '', text = ''] = match;
    const destination = parseDestination(content, match.index + opening.length);
    if (!destination || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(destination.raw)) continue;
    const hash = destination.raw.indexOf('#');
    const rawPath = hash < 0 ? destination.raw : destination.raw.slice(0, hash);
    const subpath = hash < 0 ? '' : destination.raw.slice(hash);
    const linkpath = destination.angle ? rawPath : decode(rawPath);
    const { before, after } = destination;
    links.push({
      start: match.index, end: destination.end, linkpath, text, markdown: true,
      keepExtension: /\.md$/i.test(linkpath),
      render: (next, nextText) => `${embed}[${nextText ?? ''}](${before}${destination.angle ? `<${next}${subpath}>` : encode(next) + subpath}${after})`,
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

// CommonMark inline destination plus optional title; returns undefined when malformed.
function parseDestination(content: string, from: number) {
  const line = content.indexOf('\n', from);
  const close = line < 0 ? content.length : line;
  let index = from;
  while (content[index] === ' ') index++;
  const before = content.slice(from, index);
  let raw: string;
  let angle = false;
  if (content[index] === '<') {
    const end = content.indexOf('>', index);
    if (end < 0 || end > close) return undefined;
    raw = content.slice(index + 1, end);
    angle = true;
    index = end + 1;
  } else {
    const start = index;
    let parens = 0;
    for (; index < close; index++) {
      const character = content[index];
      if (character === '\\') { index++; continue; }
      if (character === ' ' || character === '\t') break;
      if (character === '(') parens++;
      if (character === ')' && parens-- === 0) break;
    }
    raw = content.slice(start, index);
  }
  const rest = /^(\s+("[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/.exec(content.slice(index, close + 1));
  if (!rest || !raw) return undefined;
  return { raw, angle, before, after: rest[0].slice(0, -1), end: index + rest[0].length };
}

function linktext({ target, source, vault, format, keepExtension, byPath }: {
  target: string; source: string; vault: Vault; format: LinkFormat; keepExtension: boolean; byPath: boolean;
}) {
  const shape = (name: string) => keepExtension ? name : stripMd(name);
  const relative = posix.relative(posix.dirname(source), target);
  const relatives = [relative, ...relative.startsWith('../') ? [] : [`./${relative}`]];
  const preferred = format === 'absolute' ? [target]
    : format === 'relative' || byPath ? relatives
    : vault.isUniqueName(target) ? [posix.basename(target)] : [target];
  // The vault path always resolves exactly, so it is the safe fallback.
  const chosen = [...preferred, target].find(candidate => {
    const resolved = vault.resolve(shape(candidate), source);
    return resolved?.path === target && !(byPath && resolved.byName);
  }) ?? target;
  return shape(chosen);
}

export type MovePlan = {
  // Keyed by current path; the moved note's rewritten content is keyed by `from`.
  updates: Map<string, { content: string; changes: LinkChange[] }>;
  warnings: string[];
};

export function planMove({ from, to, notes, format }: {
  from: string; to: string; notes: ReadonlyMap<string, string>; format: LinkFormat;
}): MovePlan {
  const before = new Vault([...notes.keys()]);
  const after = new Vault([...notes.keys()].map(name => name === from ? to : name));
  const oldName = stripMd(posix.basename(from));
  const newName = stripMd(posix.basename(to));
  const updates: MovePlan['updates'] = new Map();
  const warnings: string[] = [];
  for (const [name, content] of notes) {
    const source = name === from ? to : name;
    const changes: LinkChange[] = [];
    let next = '';
    let cursor = 0;
    let previousEnd = 0;
    for (const link of parseLinks(content)) {
      if (link.start < previousEnd) continue;
      previousEnd = link.end;
      const was = before.resolve(link.linkpath, name);
      if (!was) continue;
      const wanted = was.path === from ? to : was.path;
      const now = after.resolve(link.linkpath, source);
      if ((was.ambiguous || now?.ambiguous) && [was.path, now?.path].some(p => p === from || p === to)) {
        warnings.push(`${source}: ${content.slice(link.start, link.end)} matched several notes by name; resolved to ${was.path}`);
      }
      // Path-based Markdown links stay path-based so they keep working outside Obsidian.
      if (now?.path === wanted && !(link.markdown && !was.byName && now.byName)) continue;
      // Like Obsidian, display text equal to the old note name follows the rename.
      const text = was.path === from && link.text === oldName ? newName : link.text;
      const byPath = link.markdown && !was.byName;
      const replacement = link.render(linktext({ target: wanted, source, vault: after, format, keepExtension: link.keepExtension, byPath }), text);
      next += content.slice(cursor, link.start) + replacement;
      cursor = link.end;
      changes.push({ from: content.slice(link.start, link.end), to: replacement });
    }
    if (changes.length) updates.set(name, { content: next + content.slice(cursor), changes });
  }
  return { updates, warnings };
}

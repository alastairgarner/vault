import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLinkableName, planMove } from '../src/links.js';
import type { LinkFormat } from '../src/links.js';

function move(from: string, to: string, notes: Record<string, string>, format: LinkFormat = 'shortest') {
  const plan = planMove({ from, to, notes: new Map(Object.entries(notes)), format });
  const contents = Object.fromEntries([...plan.updates].map(([name, update]) => [name, update.content]));
  return { contents, warnings: plan.warnings };
}

test('rename rewrites wiki links, embeds, headings, blocks, aliases and table pipes', () => {
  const linking = [
    '[[Old]] [[old]] [[Old.md]] ![[Old]] [[Old#Heading|shown]] [[Old#^block]]',
    '[[a/Old]] [[Old|Old]] [[Old|old]] | [[Old\\|cell]] |',
  ].join('\n');
  const { contents } = move('a/Old.md', 'a/New.md', { 'a/Old.md': '# Old', 'b/linking.md': linking });
  assert.equal(contents['b/linking.md'], [
    '[[New]] [[New]] [[New.md]] ![[New]] [[New#Heading|shown]] [[New#^block]]',
    '[[New]] [[New|New]] [[New|old]] | [[New\\|cell]] |',
  ].join('\n'));
  assert.equal(contents['a/Old.md'], undefined);
});

test('Markdown links keep path-based or name-based style, encoding, angle brackets and titles', () => {
  const linking = [
    '[Old](../a/Old%20note.md) [x](../a/Old%20note.md#Some%20heading "title")',
    '![x](<../a/Old note.md>) [same](Old%20note) [web](https://example.com/Old%20note.md) [anchor](#Old)',
  ].join('\n');
  const { contents } = move('a/Old note.md', 'c/d/New (draft).md', { 'a/Old note.md': '', 'b/linking.md': linking });
  assert.equal(contents['b/linking.md'], [
    '[Old](../c/d/New%20%28draft%29.md) [x](../c/d/New%20%28draft%29.md#Some%20heading "title")',
    '![x](<../c/d/New (draft).md>) [same](New%20%28draft%29) [web](https://example.com/Old%20note.md) [anchor](#Old)',
  ].join('\n'));
});

test('code is ignored, frontmatter wiki links are updated', () => {
  const linking = [
    '---', 'up: "[[Old]]"', 'list:', '  - "[[Old|x]]"', '---',
    '`[[Old]]` ``a [[Old]] b`` [[Old]]',
    '```md', '[[Old]] [x](Old.md)', '```',
    '~~~~', '[[Old]]', '~~~~',
    '[x](Old.md)',
  ].join('\n');
  const { contents } = move('Old.md', 'New.md', { 'Old.md': '', 'linking.md': linking });
  assert.equal(contents['linking.md'], [
    '---', 'up: "[[New]]"', 'list:', '  - "[[New|x]]"', '---',
    '`[[Old]]` ``a [[Old]] b`` [[New]]',
    '```md', '[[Old]] [x](Old.md)', '```',
    '~~~~', '[[Old]]', '~~~~',
    '[x](New.md)',
  ].join('\n'));
});

test('folder move keeps still-valid shortest links and fixes the moved note\'s own relative links', () => {
  const notes = {
    'a/note.md': '[[sibling]] [s](sibling.md) [[note#Self]] [[#Local]] [[missing]]',
    'a/sibling.md': '[[note]] [n](note.md) [[a/note]]',
  };
  const { contents } = move('a/note.md', 'b/c/note.md', notes);
  assert.equal(contents['b/c/note.md'], undefined);
  assert.equal(contents['a/note.md'], '[[sibling]] [s](../../a/sibling.md) [[note#Self]] [[#Local]] [[missing]]');
  assert.equal(contents['a/sibling.md'], '[[note]] [n](../b/c/note.md) [[note]]');
});

test('moving onto a shared name qualifies links that would otherwise change target', () => {
  const notes = { 'x/unique.md': '', 'c/dup.md': '', 'linking.md': '[[dup]] [[unique]]' };
  const { contents, warnings } = move('x/unique.md', 'b/dup.md', notes);
  assert.equal(contents['linking.md'], '[[c/dup]] [[b/dup]]');
  assert.ok(warnings.some(warning => warning.includes('[[dup]]')));
});

test('resolution prefers exact paths, then siblings, then the shallowest name match', () => {
  const notes = {
    'topic.md': '', 'deep/topic.md': '', 'deep/linking.md': '[[topic]] [[/topic]] [[deep/topic]]',
  };
  const { contents } = move('deep/topic.md', 'deep/renamed.md', notes);
  assert.equal(contents['deep/linking.md'], '[[topic]] [[/topic]] [[renamed]]');
});

test('link format setting controls rewritten paths, always verified to resolve', () => {
  const notes = { 'a/Old.md': '', 'a/b/linking.md': '[[Old]] [x](../Old.md)', 'z/New.md': '' };
  assert.equal(move('a/Old.md', 'c/New.md', notes, 'absolute').contents['a/b/linking.md'], '[[c/New]] [x](c/New.md)');
  assert.equal(move('a/Old.md', 'c/New.md', notes, 'relative').contents['a/b/linking.md'], '[[../../c/New]] [x](../../c/New.md)');
  assert.equal(move('a/Old.md', 'c/New.md', notes, 'shortest').contents['a/b/linking.md'], '[[c/New]] [x](../../c/New.md)');
  assert.equal(move('a/Old.md', 'a/b/x/New.md', notes, 'relative').contents['a/b/linking.md'], '[[x/New]] [x](x/New.md)');
});

test('destination names must stay linkable', () => {
  for (const name of ['a/b#c.md', 'a/b|c.md', 'a/[b].md', 'a/b^c.md', 'a:b/c.md', 'a/b?.md', 'a/"b".md']) assert.throws(() => assertLinkableName(name), name);
  assertLinkableName('ai/projects/21-tier 3 (group) coaching.md');
});

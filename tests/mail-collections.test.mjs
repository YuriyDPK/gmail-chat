import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('lib/mail-collections.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${source}\n})`)(exports);
const page = (...ids) => ({ messages: ids.map(id => ({ id })), email: 'me@example.com' });

test('all mail includes old archived messages and avoids duplicates', () => {
  const all = exports.combineMailboxPages([page('recent', 'shared')], undefined, [page('shared', 'old-archive')]);
  assert.equal(JSON.stringify(all.map(message => message.id)), JSON.stringify(['recent', 'shared', 'old-archive']));
});
test('refreshing uses each folder latest page while preserving loaded older pages', () => {
  const all = exports.combineMailboxPages([page('old-first'), page('older')], page('new-first'), [page('old-archive'), page('older-archive')], page('new-archive'));
  assert.equal(JSON.stringify(all.map(message => message.id)), JSON.stringify(['new-first', 'older', 'new-archive', 'older-archive']));
});
test('a selected old search result remains visible alongside the recent message window', () => {
  const all = Array.from({ length: 30 }, (_, i) => ({ id: `message-${i}` }));
  const visible = exports.visibleWithSearchMatches(all, 20, [all[1]]);
  assert.equal(visible.length, 21);
  assert.equal(visible[0].id, 'message-1');
  assert.equal(visible[1].id, 'message-10');
  assert.equal(visible.at(-1).id, 'message-29');
});

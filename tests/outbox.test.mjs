import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('lib/outbox.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${source}\n})`)(exports);
function pending(overrides = {}) {
  return { clientId: 'pending-1', account: 'me@example.com', email: 'friend@example.com', name: 'Friend', subject: 'Re: Hello', text: 'Hi!', files: [], date: 123, threadId: 'thread', messageId: '<original>', references: '', status: 'sending', ...overrides };
}
test('a message appears immediately with its real draft data before Gmail responds', () => {
  const messages = exports.mergeOutbox([], [pending()]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'pending-1');
  assert.equal(messages[0].text, 'Hi!');
  assert.equal(messages[0].contactEmail, 'friend@example.com');
  assert.equal(messages[0].outgoing, true);
});
test('a sent message stays visible while Gmail search has not indexed it', () => {
  const messages = exports.mergeOutbox([], [pending({ status: 'sent', sentId: 'gmail-id', sentThreadId: 'gmail-thread' })]);
  assert.equal(messages[0].id, 'gmail-id');
  assert.equal(messages[0].threadId, 'gmail-thread');
});
test('the real indexed message replaces the provisional message without a duplicate', () => {
  const real = { id: 'gmail-id', text: 'Hi!', threadId: 'gmail-thread' };
  const messages = exports.mergeOutbox([real], [pending({ status: 'sent', sentId: 'gmail-id' })]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], real);
});
test('file-only messages have a meaningful chat preview and failed sends remain visible', () => {
  const item = pending({ status: 'failed', text: '', files: [{ name: 'photo.png' }] });
  const messages = exports.mergeOutbox([], [item]);
  assert.equal(messages[0].snippet, 'Вложение: photo.png');
  assert.equal(messages[0].id, 'pending-1');
});

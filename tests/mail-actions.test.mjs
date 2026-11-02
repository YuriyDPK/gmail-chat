import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

// Exercise the real route and MIME parser with a fake Gmail transport. No mailbox is changed.
function load(file, dependencies) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${source}\n})`, { Buffer, File, Response, Request, URL, TextDecoder, console })(name => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected import: ${name}`);
  }, exports);
  return exports;
}
const attachment = load('lib/attachment.ts', {});
const cache = load('lib/message-cache.ts', { 'server-only': {} });
const parser = load('lib/gmail.ts', { 'server-only': {}, 'next-auth/jwt': {}, googleapis: {}, '@/lib/auth': {}, '@/lib/attachment': attachment, '@/lib/message-cache': cache });
const metadata = (id, from, to) => ({ id, payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }] } });
function setup(failingId) {
  const trashed = [], tokens = [];
  const messages = {
    one: metadata('one', 'Contact <friend@example.com>', 'me@example.com'),
    two: metadata('two', 'me@example.com', 'friend@example.com'),
    other: metadata('other', 'other@example.com', 'me@example.com'),
  };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async ({ pageToken }) => { tokens.push(pageToken); return { data: pageToken ? { messages: [{ id: 'two' }] } : { messages: [{ id: 'one' }, { id: 'other' }], nextPageToken: 'next' } }; },
    get: async ({ id }) => ({ data: messages[id] }),
    trash: async ({ id }) => { if (id === failingId) throw Error('failed'); trashed.push(id); },
  } } };
  const route = load('app/api/mail/trash/route.ts', { '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const request = new Request('https://local.test/api/mail/trash', { method: 'POST', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'friend@example.com' }) });
  return { route, request, trashed, tokens };
}
test('moves matching messages from every result page to trash, leaving other contacts alone', async () => {
  const { route, request, trashed, tokens } = setup();
  const response = await route.POST(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 2);
  assert.deepEqual(trashed.sort(), ['one', 'two']);
  assert.deepEqual(tokens, [undefined, 'next']);
});
test('reports partial failure when a message could not be moved', async () => {
  const { route, request, trashed } = setup('two');
  const response = await route.POST(request);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Перемещено: 1/);
  assert.deepEqual(trashed, ['one']);
});
test('rejects cross-origin deletion', async () => {
  const { route, trashed } = setup();
  const request = new Request('https://local.test/api/mail/trash', { method: 'POST', headers: { origin: 'https://other.test' } });
  assert.equal((await route.POST(request)).status, 403);
  assert.deepEqual(trashed, []);
});
test('discovers attached and embedded images with distinct identifiers', () => {
  const message = { ...metadata('one', 'friend@example.com', 'me@example.com'), payload: { ...metadata('one', 'friend@example.com', 'me@example.com').payload, parts: [
    { mimeType: 'image/png', filename: 'photo.png', body: { attachmentId: 'attachment-id', size: 123 } },
    { mimeType: 'image/jpeg', body: { data: 'AQID', size: 3 } },
    { mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } },
  ] } };
  const parsed = parser.parseMessage(message, 'me@example.com');
  assert.equal(parsed.attachments.length, 2);
  assert.equal(parsed.attachments[0].id, 'part_0_0');
  assert.equal(parsed.attachments[1].id, 'part_0_1');
  assert.equal(parsed.text, 'hello');
});

function setupMove() {
  const calls = { list: [], modified: [] };
  const messages = {
    incoming: metadata('incoming', 'Friend <friend@example.com>', 'me@example.com'),
    sent: metadata('sent', 'me@example.com', 'friend@example.com'),
    other: metadata('other', 'someone@example.com', 'me@example.com'),
  };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async options => { calls.list.push(options); return { data: options.pageToken ? { messages: [{ id: 'sent' }, { id: 'other' }] } : { messages: [{ id: 'incoming' }], nextPageToken: 'next' } }; },
    get: async ({ id }) => ({ data: messages[id] }),
    batchModify: async options => { calls.modified.push(options.requestBody); },
  } } };
  const route = load('app/api/mail/move/route.ts', { '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const request = (action, folder, origin = 'https://local.test') => new Request('https://local.test/api/mail/move', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'friend@example.com', action, folder }) });
  return { route, request, calls };
}
test('archives all matching inbox messages, including later pages', async () => {
  const { route, request, calls } = setupMove();
  const result = await route.POST(request('archive', 'all'));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).moved, 2);
  assert.match(calls.list[0].q, /in:inbox/);
  assert.equal(JSON.stringify(calls.modified[0]), JSON.stringify({ ids: ['incoming', 'sent'], addLabelIds: [], removeLabelIds: ['INBOX'] }));
});
test('marking a contact as spam affects incoming messages, not sent mail or another contact', async () => {
  const { route, request, calls } = setupMove();
  const result = await route.POST(request('spam', 'all'));
  assert.equal((await result.json()).moved, 1);
  assert.equal(JSON.stringify(calls.modified[0]), JSON.stringify({ ids: ['incoming'], addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }));
});
test('restores spam to inbox with spam included in the Gmail search', async () => {
  const { route, request, calls } = setupMove();
  const result = await route.POST(request('inbox', 'spam'));
  assert.equal(result.status, 200);
  assert.equal(calls.list[0].includeSpamTrash, true);
  assert.match(calls.list[0].q, /in:spam/);
  assert.equal(JSON.stringify(calls.modified[0]), JSON.stringify({ ids: ['incoming', 'sent'], addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }));
});
test('rejects invalid folder actions and cross-origin moves before Gmail is touched', async () => {
  const { route, request, calls } = setupMove();
  assert.equal((await route.POST(request('inbox', 'all'))).status, 400);
  assert.equal((await route.POST(request('spam', 'all', 'https://other.test'))).status, 403);
  assert.equal(calls.list.length, 0);
});
test('folder listing uses Gmail spam and archive filters', async () => {
  const requests = [];
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: { list: async options => { requests.push(options); return { data: { messages: [] } }; } } } };
  const route = load('app/api/mail/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  assert.equal((await route.GET(new Request('https://local.test/api/mail?folder=archive'))).status, 200);
  assert.match(requests[0].q, /-in:inbox/);
  assert.match(requests[0].q, /-in:sent/);
  assert.equal((await route.GET(new Request('https://local.test/api/mail?folder=spam'))).status, 200);
  assert.equal(requests[1].includeSpamTrash, true);
  assert.match(requests[1].q, /in:spam/);
  assert.equal((await route.GET(new Request('https://local.test/api/mail?folder=unknown'))).status, 400);
});

test('retains HTML and inline image Content-ID while parsing a multipart email', () => {
  const message = { ...metadata('one', 'friend@example.com', 'me@example.com'), payload: { ...metadata('one', 'friend@example.com', 'me@example.com').payload, parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('Plain alternative').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML <img src="cid:logo"></p>').toString('base64url') } },
    { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<logo>' }], body: { attachmentId: 'image-id', size: 20 } },
  ] } };
  const parsed = parser.parseMessage(message, 'me@example.com');
  assert.equal(parsed.text, 'Plain alternative');
  assert.match(parsed.html, /<p>HTML/);
  assert.equal(parsed.attachments[0].contentId, 'logo');
});

test('discovers files named in MIME headers, generic image MIME, and empty attachments', () => {
  const message = { ...metadata('one', 'friend@example.com', 'me@example.com'), payload: { ...metadata('one', 'friend@example.com', 'me@example.com').payload, parts: [
    { mimeType: 'application/octet-stream', filename: '', headers: [{ name: 'Content-Disposition', value: "attachment; filename=\"file.pdf\"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf" }], body: { attachmentId: 'opaque+/==', size: 4 } },
    { mimeType: 'application/octet-stream', filename: 'photo.PNG', body: { attachmentId: 'image-id', size: 20 } },
    { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { data: '', size: 0 } },
    { mimeType: 'application/pdf', body: { attachmentId: 'unnamed', size: 4 } },
    { mimeType: 'application/octet-stream', headers: [{ name: 'Content-Disposition', value: "attachment; filename*0*=UTF-8''%D1%84%D0%B0; filename*1*=%D0%B9%D0%BB.pdf" }], body: { attachmentId: 'split', size: 4 } },
  ] } };
  const parsed = parser.parseMessage(message, 'me@example.com');
  assert.equal(parsed.attachments.length, 5);
  assert.equal(parsed.attachments[0].filename, 'отчёт.pdf');
  assert.equal(parsed.attachments[0].id, 'part_0_0');
  assert.equal(parsed.attachments[1].mimeType, 'image/png');
  assert.equal(parsed.attachments[2].filename, 'Вложение');
  assert.equal(parsed.attachments[3].filename, 'Вложение.pdf');
  assert.equal(parsed.attachments[4].filename, 'файл.pdf');
});

test('downloads the exact nested part and supports opaque Gmail IDs and empty files', async () => {
  const payload = { parts: [
    { mimeType: 'multipart/mixed', parts: [{ mimeType: 'application/octet-stream', headers: [{ name: 'Content-Disposition', value: "attachment; filename*=UTF-8''%D1%84%D0%B0%D0%B9%D0%BB.pdf" }], body: { attachmentId: 'opaque+/==', size: 3 } }] },
    { mimeType: 'text/plain', filename: 'empty.txt', body: { data: '', size: 0 } },
  ] };
  const requested = [];
  const gmail = { users: { messages: { get: async () => ({ data: { payload } }), attachments: { get: async options => { requested.push(options.id); return { data: { data: Buffer.from('abc').toString('base64url') } }; } } } } };
  const route = load('app/api/mail/attachment/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/attachment': attachment, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const request = id => new Request(`https://local.test/api/mail/attachment?messageId=message123&id=${encodeURIComponent(id)}`);
  const result = await route.GET(request('part_0_0_0'));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'abc');
  assert.match(result.headers.get('content-disposition'), /%D1%84%D0%B0%D0%B9%D0%BB.pdf/);
  assert.deepEqual(requested, ['opaque+/==']);
  assert.equal((await route.GET(request('opaque+/=='))).status, 200);
  const empty = await route.GET(request('part_0_1'));
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  assert.equal((await route.GET(request('not-a-part'))).status, 404);
});

test('reuses full messages per session, deduplicates concurrent requests, and invalidates safely', async () => {
  let calls = 0;
  const loadMessage = async () => { calls++; return { id: `version${calls}` }; };
  const [a, b] = await Promise.all([cache.cachedMessage('session_a', 'message', loadMessage), cache.cachedMessage('session_a', 'message', loadMessage)]);
  assert.equal(a.id, 'version1'); assert.equal(b.id, 'version1'); assert.equal(calls, 1);
  await cache.cachedMessage('session_b', 'message', loadMessage);
  assert.equal(calls, 2);
  cache.invalidateMessages('session_a', ['message']);
  assert.equal((await cache.cachedMessage('session_a', 'message', loadMessage)).id, 'version3');
  assert.equal((await cache.cachedMessage('session_b', 'message', loadMessage)).id, 'version2');
  cache.clearMessageCache('session_a'); cache.clearMessageCache('session_b');
});

test('an invalidated in-flight load cannot reinsert stale mail', async () => {
  let finish;
  const slow = cache.cachedMessage('session_c', 'message', () => new Promise(resolve => { finish = resolve; }));
  cache.invalidateMessages('session_c', ['message']);
  const fresh = await cache.cachedMessage('session_c', 'message', async () => ({ id: 'fresh' }));
  finish({ id: 'stale' }); await slow;
  assert.equal(fresh.id, 'fresh');
  assert.equal((await cache.cachedMessage('session_c', 'message', async () => ({ id: 'unexpected' }))).id, 'fresh');
  cache.clearMessageCache('session_c');
});

test('turns Gmail quota failures into actionable retry responses', async () => {
  const result = parser.errorResponse(new Error('Quota exceeded for quota metric'));
  assert.equal(result.status, 429);
  assert.match((await result.json()).error, /лимит запросов/);
});

test('sent MIME preserves filenames and attachment bytes, including an empty file', async () => {
  let raw = '';
  const gmail = { users: { messages: { send: async ({ requestBody }) => { raw = Buffer.from(requestBody.raw, 'base64url').toString('utf8'); return { data: { id: 'sent-id' } }; } } } };
  const route = load('app/api/mail/send/route.ts', { 'node:crypto': crypto, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const data = new FormData();
  data.set('to', 'friend@example.com'); data.set('subject', 'Subject');
  data.append('files', new File(['PDF'], 'отчёт.pdf', { type: 'application/pdf' }));
  data.append('files', new File([], 'empty.txt', { type: 'text/plain' }));
  const request = new Request('https://local.test/api/mail/send', { method: 'POST', headers: { origin: 'https://local.test' }, body: data });
  const response = await route.POST(request);
  assert.equal(response.status, 200);
  assert.match(raw, /Content-Type: application\/pdf; name=/);
  assert.match(raw, /filename\*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf/);
  assert.match(raw, /UERG/);
  assert.match(raw, /filename="empty.txt"/);
});

test('chat list requests metadata only and loads full message content on demand', async () => {
  const formats = [];
  const original = { ...metadata('abc', 'friend@example.com', 'me@example.com'), snippet: 'Preview', payload: { ...metadata('abc', 'friend@example.com', 'me@example.com').payload, mimeType: 'text/plain', body: { data: Buffer.from('Full body').toString('base64url') } } };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async () => ({ data: { messages: [{ id: 'abc' }] } }),
    get: async options => { formats.push(options.format); return { data: options.format === 'metadata' ? { ...original, payload: { headers: original.payload.headers } } : original }; },
  } } };
  const gmailDeps = { ...parser, gmailFor: async () => gmail };
  const list = load('app/api/mail/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': gmailDeps });
  const result = await (await list.GET(new Request('https://local.test/api/mail'))).json();
  assert.deepEqual(formats, ['metadata']);
  assert.equal(result.messages[0].text, 'Preview');
  const details = load('app/api/mail/messages/route.ts', { '@/lib/gmail': gmailDeps });
  const request = new Request('https://local.test/api/mail/messages', { method: 'POST', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['abc'] }) });
  const full = await (await details.POST(request)).json();
  assert.deepEqual(formats, ['metadata', 'full']);
  assert.equal(full.messages[0].text, 'Full body');
});

test('pin lookup retrieves the matching contact outside the current page', async () => {
  const messages = { other: metadata('other', 'someone@example.com', 'me@example.com'), pinned: metadata('pinned', 'friend@example.com', 'me@example.com') };
  const formats = [];
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async () => ({ data: { messages: [{ id: 'other' }, { id: 'pinned' }] } }),
    get: async ({ id, format }) => { formats.push(format); return { data: messages[id] }; },
  } } };
  const route = load('app/api/mail/pins/route.ts', { '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const req = new Request('https://local.test/api/mail/pins', { method: 'POST', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ emails: ['friend@example.com'], folder: 'all' }) });
  const result = await (await route.POST(req)).json();
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'pinned');
  assert.deepEqual(formats, ['metadata', 'metadata']);
});

test('message detail endpoint rejects cross-origin and invalid requests', async () => {
  const route = load('app/api/mail/messages/route.ts', { '@/lib/gmail': parser });
  const make = (origin, ids) => new Request('https://local.test/api/mail/messages', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
  assert.equal((await route.POST(make('https://other.test', ['abc']))).status, 403);
  assert.equal((await route.POST(make('https://local.test', ['../invalid']))).status, 400);
});

test('invalidating a message clears its lightweight metadata too', async () => {
  let calls = 0;
  const loadMessage = async () => ({ id: String(++calls) });
  await cache.cachedMessage('session_meta', 'metadata:abc', loadMessage);
  await cache.cachedMessage('session_meta', 'abc', loadMessage);
  cache.invalidateMessages('session_meta', ['abc']);
  await cache.cachedMessage('session_meta', 'metadata:abc', loadMessage);
  await cache.cachedMessage('session_meta', 'abc', loadMessage);
  assert.equal(calls, 4);
  cache.clearMessageCache('session_meta');
});

test('pinned contact history keeps only messages belonging to that contact', async () => {
  const messages = { one: metadata('one', 'friend@example.com', 'me@example.com'), other: metadata('other', 'someone@example.com', 'me@example.com'), two: metadata('two', 'me@example.com', 'friend@example.com') };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async () => ({ data: { messages: [{ id: 'one' }, { id: 'other' }, { id: 'two' }] } }),
    get: async ({ id }) => ({ data: messages[id] }),
  } } };
  const route = load('app/api/mail/pins/route.ts', { '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const req = new Request('https://local.test/api/mail/pins', { method: 'POST', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify({ emails: ['friend@example.com'], folder: 'all', history: true }) });
  const result = await (await route.POST(req)).json();
  assert.deepEqual(result.messages.map(message => message.id), ['one', 'two']);
});

test('search is sent to Gmail, preserving folder scope and older result page tokens', async () => {
  const requests = [];
  const message = { ...metadata('old', 'Кулигина <teacher@example.com>', 'me@example.com'), snippet: 'Старое письмо' };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async options => { requests.push(options); return { data: { messages: [{ id: 'old' }], nextPageToken: 'older' } }; },
    get: async () => ({ data: message }),
  } } };
  const route = load('app/api/mail/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const req = new Request(`https://local.test/api/mail?folder=all&q=${encodeURIComponent('кулигина')}&pageToken=previous`);
  const result = await (await route.GET(req)).json();
  assert.match(requests[0].q, /кулигина/);
  assert.match(requests[0].q, /-in:spam/);
  assert.match(requests[0].q, /-in:trash/);
  assert.equal(requests[0].pageToken, 'previous');
  assert.equal(result.nextPageToken, 'older');
  assert.equal(result.messages[0].id, 'old');
});

test('contact history is paginated in Gmail and excludes messages grouped under another contact', async () => {
  const requests = [];
  const messages = { recent: metadata('recent', 'friend@example.com', 'me@example.com'), other: metadata('other', 'someone@example.com', 'me@example.com'), old: metadata('old', 'me@example.com', 'friend@example.com') };
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: {
    list: async options => { requests.push(options); return { data: options.pageToken ? { messages: [{ id: 'old' }] } : { messages: [{ id: 'recent' }, { id: 'other' }], nextPageToken: 'next' } }; },
    get: async ({ id }) => ({ data: messages[id] }),
  } } };
  const route = load('app/api/mail/contact/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  const first = await (await route.GET(new Request('https://local.test/api/mail/contact?folder=all&email=friend%40example.com'))).json();
  assert.deepEqual(first.messages.map(message => message.id), ['recent']);
  assert.equal(first.nextPageToken, 'next');
  const second = await (await route.GET(new Request('https://local.test/api/mail/contact?folder=all&email=friend%40example.com&pageToken=next'))).json();
  assert.deepEqual(second.messages.map(message => message.id), ['old']);
  assert.match(requests[0].q, /from:friend@example.com/);
  assert.equal(requests[1].pageToken, 'next');
  assert.equal((await route.GET(new Request('https://local.test/api/mail/contact?email=bad%40example.com%7D'))).status, 400);
});

test('contact names and subjects encoded in MIME headers remain readable', () => {
  const name = Buffer.from('Кулигина').toString('base64');
  const subject = Buffer.from('Старое письмо').toString('base64');
  const message = { id: 'old', payload: { headers: [
    { name: 'From', value: `=?UTF-8?B?${name}?= <teacher@example.com>` },
    { name: 'To', value: 'me@example.com' },
    { name: 'Subject', value: `=?UTF-8?B?${subject}?=` },
  ] } };
  const parsed = parser.parseMessage(message, 'me@example.com');
  assert.equal(parsed.contactName, 'Кулигина');
  assert.equal(parsed.subject, 'Старое письмо');
});

test('all-mail search does not exclude inbox or archived mail, while spam is isolated', async () => {
  const requests = [];
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: { list: async options => { requests.push(options); return { data: { messages: [] } }; } } } };
  const route = load('app/api/mail/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  await route.GET(new Request('https://local.test/api/mail?folder=all&q=old'));
  await route.GET(new Request('https://local.test/api/mail?folder=spam&q=old'));
  assert.doesNotMatch(requests[0].q, /-in:inbox|-in:sent/);
  assert.match(requests[0].q, /old/);
  assert.equal(requests[1].includeSpamTrash, true);
  assert.match(requests[1].q, /in:spam/);
});

test('contact history includes spam only in the spam folder', async () => {
  const requests = [];
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: { list: async options => { requests.push(options); return { data: { messages: [] } }; } } } };
  const route = load('app/api/mail/contact/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  await route.GET(new Request('https://local.test/api/mail/contact?folder=spam&email=friend%40example.com'));
  assert.equal(requests[0].includeSpamTrash, true);
  assert.match(requests[0].q, /in:spam/);
});

test('archive preview uses a smaller page without changing the default mailbox page size', async () => {
  const requests = [];
  const gmail = { users: { getProfile: async () => ({ data: { emailAddress: 'me@example.com' } }), messages: { list: async options => { requests.push(options); return { data: { messages: [] } }; } } } };
  const route = load('app/api/mail/route.ts', { 'next/server': { connection: async () => {} }, '@/lib/gmail': { ...parser, gmailFor: async () => gmail } });
  await route.GET(new Request('https://local.test/api/mail?folder=archive&limit=20'));
  await route.GET(new Request('https://local.test/api/mail?folder=all'));
  assert.equal(requests[0].maxResults, 20);
  assert.equal(requests[1].maxResults, 50);
  assert.equal((await route.GET(new Request('https://local.test/api/mail?limit=500'))).status, 400);
});

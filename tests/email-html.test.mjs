import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('', { url: 'https://gmail-chat.test' }).window;
const source = ts.transpileModule(fs.readFileSync('lib/email-html.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(`(function(require, exports) { ${source}\n})`, { DOMParser: window.DOMParser })(name => {
  if (name === 'dompurify') return { default: createDOMPurify(window) };
  throw new Error(`Unexpected import ${name}`);
}, exports);
const parse = html => new window.DOMParser().parseFromString(html, 'text/html');

test('preserves email layout, styles and embedded Content-ID images', () => {
  const original = '<html><head><style>.banner{background:#ff0}</style></head><body><table><tr><td class="banner" background="cid:logo%40example" style="background-image:url(cid:logo%40example)">Hello<img src="cid:logo%40example"></td></tr></table><a href="https://example.com">More</a></body></html>';
  const data = 'data:image/png;base64,AQID';
  const doc = parse(exports.prepareEmailDocument(original, { 'logo@example': data }));
  assert.equal(doc.querySelector('td.banner').textContent, 'Hello');
  assert.match(doc.head.textContent, /\.banner/);
  assert.equal(doc.querySelector('img').getAttribute('src'), data);
  assert.equal(doc.querySelector('td').getAttribute('background'), data);
  assert.ok(doc.querySelector('td').getAttribute('style').includes(data));
  assert.equal(doc.querySelector('a').getAttribute('target'), '_blank');
  assert.equal(doc.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
});
test('removes active content, dangerous links and embedded frames', () => {
  const original = '<html><head><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><script>alert(1)</script></head><body><form action="https://evil.test"><input name="secret"></form><img src="https://evil.test/a.png" onerror="alert(1)"><iframe src="https://evil.test"></iframe><svg onload="alert(1)"></svg><a href="javascript:alert(1)">bad</a><a href="/api/auth/signout">local</a></body></html>';
  const doc = parse(exports.prepareEmailDocument(original, {}));
  assert.equal(doc.querySelector('script, iframe, form, input, svg, base, meta[http-equiv="refresh"]'), null);
  assert.equal(doc.querySelector('img').hasAttribute('onerror'), false);
  assert.equal(doc.querySelectorAll('a[href]').length, 0);
  assert.equal(doc.querySelector('img').getAttribute('referrerpolicy'), 'no-referrer');
});
test('external images load by default while scripts and connections remain blocked', () => {
  const original = '<body><img src="https://example.com/image.png"><img src="//example.com/other.png"><div style="background-image:url(https://example.com/pixel)">Hi</div></body>';
  const doc = parse(exports.prepareEmailDocument(original, {}));
  const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(policy, /img-src data: https: http:;/);
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /connect-src 'none'/);
  assert.equal(doc.querySelectorAll('img')[0].getAttribute('src'), 'https://example.com/image.png');
  assert.equal(doc.querySelectorAll('img')[1].getAttribute('src'), 'https://example.com/other.png');
});
test('rejects unsafe image URLs and excludes SVG data images', () => {
  const doc = parse(exports.prepareEmailDocument('<img src="/api/mail"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="cid:missing">', {}));
  assert.equal(doc.querySelectorAll('img[src]').length, 0);
});

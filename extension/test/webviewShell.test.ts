import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webviewCsp, webviewNonce, webviewShell, type WebviewShellOptions } from '../src/webviewShell';

// The page a webview loads (src/webviewShell.ts), shared by the preview and the Block Editor.

const options: WebviewShellOptions = {
  cspSource: 'https://res.example',
  nonce: 'abc+/=',
  lang: 'en',
  htmlAttributes: { 'data-smd-theme-pref': 'dark' },
  baseHref: 'https://res.example/docs/',
  styles: ['https://res.example/katex.min.css', 'https://res.example/smd.css'],
  bodyClass: 'smd-body',
  body: '<main id="smd-root"><p>Hi</p></main>',
  scripts: ['https://res.example/mermaid.min.js', 'https://res.example/runtime.js'],
};

/** The CSP's directives, by name. */
function policy(html: string): Map<string, string[]> {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(meta, 'the page has a policy');
  return new Map(meta[1].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

test('webview shell: a strict policy, scripts only by nonce, and no form submits', () => {
  const html = webviewShell(options);
  const csp = policy(html);
  assert.deepEqual([...csp.keys()], ['default-src', 'img-src', 'style-src', 'font-src', 'script-src', 'form-action']);
  assert.deepEqual(csp.get('default-src'), ["'none'"]);
  assert.deepEqual(csp.get('img-src'), ['https://res.example', 'https:', 'data:']);
  assert.deepEqual(csp.get('style-src'), ['https://res.example', "'unsafe-inline'"]);
  assert.deepEqual(csp.get('font-src'), ['https://res.example', 'data:']);
  assert.deepEqual(csp.get('script-src'), ["'nonce-abc+/='"]);
  assert.deepEqual(csp.get('form-action'), ["'none'"]);
  assert.equal(webviewCsp('https://res.example', 'abc+/='), /content="([^"]+)"/.exec(html)![1]);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
});

test('webview shell: every script carries the nonce, in the order given, after the body', () => {
  const html = webviewShell(options);
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>/g), (m) => m[0]);
  assert.deepEqual(scripts, [
    '<script nonce="abc+/=" src="https://res.example/mermaid.min.js">',
    '<script nonce="abc+/=" src="https://res.example/runtime.js">',
  ]);
  assert.ok(html.indexOf('</main>') < html.indexOf('<script'));
  assert.match(html, /<\/script>\n<\/body>\n<\/html>$/);
  // Another script list, as the Block Editor's.
  const editor = webviewShell({ ...options, scripts: ['a.js', 'b.js', 'c.js'] });
  assert.equal(editor.match(/<script nonce="abc\+\/=" src="[abc]\.js"><\/script>/g)?.length, 3);
  assert.doesNotMatch(editor, /<script(?![^>]*nonce=)/, 'no script without the nonce');
});

test('webview shell: a fresh, unguessable nonce for each page unless one is given', () => {
  const nonces = new Set(Array.from({ length: 20 }, () => webviewNonce()));
  assert.equal(nonces.size, 20);
  for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/, '16 random bytes');
  const { nonce: _given, ...unpinned } = options;
  const html = webviewShell(unpinned);
  const nonce = /'nonce-([^']+)'/.exec(html)![1];
  assert.notEqual(nonce, 'abc+/=');
  assert.equal(html.match(new RegExp(`nonce="${nonce.replaceAll(/[+/]/g, '\\$&')}"`, 'g'))?.length, 2);
  assert.notEqual(webviewShell(unpinned), html);
});

test('webview shell: the preview has no mode attribute; the Block Editor says what it is', () => {
  assert.match(webviewShell(options), /\n<body class="smd-body">\n/);
  const editor = webviewShell({ ...options, mode: 'block-editor', bodyAttributes: { 'data-smd-version': '7' } });
  assert.match(editor, /\n<body class="smd-body" data-smd-mode="block-editor" data-smd-version="7">\n/);
});

test('webview shell: head and attributes', () => {
  const html = webviewShell({ ...options, lang: 'de"x', styles: [...options.styles, 'https://res.example/block-editor.css?a=1&b=2'] });
  assert.match(html, /^<!DOCTYPE html>\n<html lang="de&quot;x" data-smd-theme-pref="dark">\n<head>\n<meta charset="utf-8">\n/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">\n<base href="https:\/\/res.example\/docs\/">\n/);
  assert.deepEqual(Array.from(html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g), (m) => m[1]), [
    'https://res.example/katex.min.css', 'https://res.example/smd.css', 'https://res.example/block-editor.css?a=1&amp;b=2',
  ]);
  assert.match(html, /<\/head>\n<body class="smd-body">\n<main id="smd-root"><p>Hi<\/p><\/main>\n<script/);
  assert.doesNotMatch(webviewShell({ ...options, baseHref: undefined }), /<base /);
  assert.throws(() => webviewShell({ ...options, bodyAttributes: { 'onload="x"': '' } }), /Not an attribute name/);
});

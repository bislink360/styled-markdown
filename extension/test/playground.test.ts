import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import {
  FRAGMENT_KEY, MAX_DOCUMENT_BYTES, SHARE_WARN_LENGTH, base64UrlToBytes, bytesToBase64Url, decodeDocument, documentFromHash,
  encodeDocument, fragmentPayload, shareFragment, shareLinkWarning,
} from '../../playground/src/codec';
import { changedRange, indent, lineNumbers, offsetOf, outdent } from '../../playground/src/editor';
import { CSP_PLACEHOLDER, appCsp } from '../../playground/src/csp.mjs';
import {
  PREVIEW_SANDBOX, needsRebuild, previewDocument, previewTheme, updateMessage, type FrameAssets,
} from '../../playground/src/frame';
import { diagnosticsSummary, renderPanes } from '../../playground/src/panes';
import { isPortHandshake, linkAction } from '../../playground/src/previewLinks';
import { readStored, themeSetting, writeStored, type KeyValueStore } from '../../playground/src/storage';
import { appBundleOptions, indexHtml, playgroundAssets, scriptHash } from '../scripts/build-playground.mjs';

const PLAYGROUND = join(__dirname, '..', '..', 'playground');
const STARTER = readFileSync(join(PLAYGROUND, 'starter.smd'), 'utf8');
const TODAY = '2026-10-10';

// ---- Share-by-URL codec ---------------------------------------------------------

test('the URL codec round-trips documents, including Unicode, line endings and empty text', async () => {
  const samples = [
    '',
    '# Title\n\nPlain text.',
    'Ünïcödé — 日本語 — العربية — emoji 🧪👩🏽‍💻 — combining é — \u{1F600}',
    'Windows\r\nline\r\nendings\r\n',
    '\u0000 control \u001f characters and a lone surrogate-free BMP �',
    STARTER,
  ];
  for (const text of samples) {
    const payload = await encodeDocument(text);
    assert.match(payload, /^[A-Za-z0-9_-]*$/, 'payload is base64url');
    assert.equal(await decodeDocument(payload), text);
  }
});

test('the URL codec compresses and keeps the document in the fragment', async () => {
  const text = 'A line that repeats.\n'.repeat(500);
  const fragment = await shareFragment(text);
  assert.ok(fragment.startsWith(`#${FRAGMENT_KEY}=`));
  assert.ok(fragment.length < text.length / 10, `compressed to ${fragment.length} characters`);
  const found = await documentFromHash(fragment);
  assert.deepEqual(found, { kind: 'document', text });
});

test('base64url handles every byte value and rejects other alphabets', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const encoded = bytesToBase64Url(bytes);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual(base64UrlToBytes(encoded), bytes);
  assert.throws(() => base64UrlToBytes('abc+/='));
});

test('documentFromHash tells no document, a document and an unreadable link apart, without throwing', async () => {
  assert.deepEqual(await documentFromHash(''), { kind: 'none' });
  assert.deepEqual(await documentFromHash('#section-2'), { kind: 'none' });
  assert.equal(fragmentPayload('#other=abc'), undefined);
  assert.deepEqual(await documentFromHash(`#${FRAGMENT_KEY}=`), { kind: 'document', text: '' });
  for (const bad of ['%%%', 'AAAA', bytesToBase64Url(new TextEncoder().encode('not deflate data'))]) {
    const found = await documentFromHash(`#${FRAGMENT_KEY}=${bad}`);
    assert.equal(found.kind, 'invalid', bad);
  }
});

test('decoding stops at the size limit, so a tiny link cannot expand into a huge document', async () => {
  const bomb = await encodeDocument('a'.repeat(MAX_DOCUMENT_BYTES + 1));
  assert.ok(bomb.length < 10_000, 'the crafted payload is small');
  await assert.rejects(decodeDocument(bomb), /larger than/);
  const found = await documentFromHash(`#${FRAGMENT_KEY}=${bomb}`);
  assert.equal(found.kind, 'invalid');
  assert.equal(await decodeDocument(await encodeDocument('small'), 5), 'small');
});

test('long share links get a warning', async () => {
  assert.equal(shareLinkWarning('https://example.test/#smd=abc'), undefined);
  assert.equal(shareLinkWarning('x'.repeat(SHARE_WARN_LENGTH)), undefined);
  assert.match(shareLinkWarning('x'.repeat(SHARE_WARN_LENGTH + 1)) ?? '', /8 KB/);
  // Random text barely compresses, so a big random document makes an oversize link.
  let seed = 42;
  let noise = '';
  for (let i = 0; i < 12_000; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    noise += String.fromCharCode(33 + (seed % 90));
  }
  const url = 'https://example.test/playground/' + (await shareFragment(noise));
  assert.ok(shareLinkWarning(url));
});

// ---- Panes --------------------------------------------------------------------------

test('renderPanes returns the preview, agent view, diagnostics and Markdown of a document', () => {
  const panes = renderPanes(STARTER, { today: TODAY });
  assert.match(panes.preview.html, /^<article class="smd-doc"/);
  assert.match(panes.preview.html, /smd-callout/);
  assert.equal(panes.preview.mermaid, true);
  assert.equal(panes.preview.lang, 'en');
  assert.match(panes.agent.text, /Notes for AI agents/);
  assert.ok(panes.agent.tokens > 0 && panes.agent.originalTokens >= panes.agent.tokens);
  assert.deepEqual(panes.diagnostics, [], 'the starter document is clean');
  assert.match(panes.markdown, /^## Try it$/m);
  assert.match(panes.markdown, /^> \[!TIP\]$/m);
  assert.doesNotMatch(panes.markdown, /^:::/m);
});

test('diagnostics are sorted and summarized', () => {
  const panes = renderPanes('# T\n\n:::nope\ntext\n:::\n\n:::warning\nunclosed\n', { today: TODAY });
  assert.ok(panes.diagnostics.length >= 2);
  const positions = panes.diagnostics.map((d) => [d.line, d.column]);
  const sorted = [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(positions, sorted);
  assert.match(diagnosticsSummary(panes.diagnostics), /\d+ (error|warning)/);
  assert.equal(diagnosticsSummary([]), 'No problems');
});

test('the playground reads no files: includes and code embeds show their fallback notes', () => {
  const doc = '# T\n\n:::include{file="secret.smd"}\nFallback text.\n:::\n\n```ts file="../../etc/passwd"\n```\n';
  const panes = renderPanes(doc, { today: TODAY });
  assert.match(panes.preview.html, /Fallback text\./);
  assert.match(panes.preview.html, /Cannot read/);
  assert.doesNotMatch(panes.preview.html, /root:/);
  assert.match(panes.agent.text, /secret\.smd/);
});

test('an empty document renders every pane', () => {
  const panes = renderPanes('');
  assert.match(panes.preview.html, /smd-doc/);
  assert.equal(panes.preview.mermaid, false);
  assert.equal(typeof panes.agent.text, 'string');
  assert.equal(typeof panes.markdown, 'string');
});

// ---- Preview frame and security -------------------------------------------------------

function cspDirectives(csp: string): Map<string, string[]> {
  return new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

/** The frame's assets and the CSP, built once (bundling the link handler takes a moment). */
let built: Promise<{ frame: FrameAssets; mermaid: string; hashes: string[]; csp: string }> | undefined;
const assets = () => (built ??= playgroundAssets());

/** The inline scripts of a frame document, as the browser would hash them. */
function inlineScripts(page: string): string[] {
  return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('the preview sandbox never grants same-origin, top navigation, forms or modals', () => {
  const flags = PREVIEW_SANDBOX.split(' ');
  assert.ok(flags.includes('allow-scripts'));
  for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-forms', 'allow-modals', 'allow-downloads']) {
    assert.ok(!flags.includes(flag), flag);
  }
});

test('the app CSP runs only the app files and the hashed frame scripts, and allows no remote content', async () => {
  const { csp, hashes } = await assets();
  const directives = cspDirectives(csp);
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'", ...hashes.map((h) => `'sha256-${h}'`)]);
  assert.equal(hashes.length, 3);
  assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  assert.ok(!directives.has('connect-src'), 'nothing may connect (default-src none)');
  for (const [name, values] of directives) {
    assert.ok(!values.includes("'unsafe-eval'"), name);
    assert.ok(name === 'style-src' || !values.includes("'unsafe-inline'"), name);
    assert.ok(!values.some((v) => v === '*' || /^(?:https?|wss?):/.test(v)), `${name} allows no remote hosts`);
  }
  assert.equal(appCsp([]), csp.replace(/ 'sha256-[^']+'/g, ''));
});

test('index.html gets the CSP and carries the preview sandbox, with no inline scripts of its own', async () => {
  const template = readFileSync(join(PLAYGROUND, 'index.html'), 'utf8');
  assert.ok(template.includes(CSP_PLACEHOLDER));
  const html = indexHtml((await assets()).csp);
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.equal(meta?.[1], (await assets()).csp);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
  assert.match(html, new RegExp(`<iframe id="preview"[^>]* sandbox="${PREVIEW_SANDBOX}"`));
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.match(script, /\ssrc="[^"]+"/, script);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
});

test('every script the preview frame inlines is allowed by its hash; a document script is not', async () => {
  const { frame, mermaid, hashes } = await assets();
  const doc = '# Hi\n\n<script>parent.document.body.remove()</script>\n\n```mermaid\nflowchart LR\nA-->B\n```\n';
  const preview = renderPanes(doc).preview;
  const page = previewDocument(preview, 'auto', { ...frame, mermaid });
  const scripts = inlineScripts(page);
  assert.equal(scripts.length, 4, 'the document script, Mermaid, the runtime and the link handler');
  const allowed = scripts.filter((s) => hashes.includes(scriptHash(s)));
  assert.equal(allowed.length, 3);
  assert.ok(!hashes.includes(scriptHash('parent.document.body.remove()')));
  const markup = page.replaceAll(/<script>[\s\S]*?<\/script>/g, '');
  assert.ok(!/<(?:script|link)\b[^>]*\s(?:src|href)=/i.test(markup), 'the frame loads no script or stylesheet files');
});

test('Mermaid is inlined only for documents with diagrams, once it is loaded', async () => {
  const { frame, mermaid } = await assets();
  const plain = renderPanes('# Hi').preview;
  const withDiagram = renderPanes('```mermaid\nflowchart LR\nA-->B\n```\n').preview;
  assert.equal(inlineScripts(previewDocument(plain, 'auto', { ...frame, mermaid })).length, 2);
  assert.equal(inlineScripts(previewDocument(withDiagram, 'auto', frame)).length, 2, 'not loaded yet: diagram source shows');
  const page = previewDocument(withDiagram, 'dark', { ...frame, mermaid });
  assert.equal(inlineScripts(page).length, 3);
  assert.match(page, /data-smd-theme-pref="dark"/);
});

test('the frame is rebuilt only for a new language or newly available Mermaid', () => {
  const plain = { html: '', lang: 'en', mermaid: false };
  const diagram = { ...plain, mermaid: true };
  assert.equal(needsRebuild(undefined, plain, false), true);
  assert.equal(needsRebuild({ lang: 'en', mermaid: false }, plain, true), false);
  assert.equal(needsRebuild({ lang: 'en', mermaid: true }, plain, true), false, 'Mermaid stays once inlined');
  assert.equal(needsRebuild({ lang: 'en', mermaid: false }, diagram, false), false, 'still loading');
  assert.equal(needsRebuild({ lang: 'en', mermaid: false }, diagram, true), true);
  assert.equal(needsRebuild({ lang: 'en', mermaid: false }, { ...plain, lang: 'de' }, false), true);
  assert.deepEqual(updateMessage(plain, 'light'), { type: 'update', html: '', themePref: 'light' });
});

test('the preview theme: a fixed app setting wins, else the document theme, else the system', () => {
  assert.equal(previewTheme('dark', { theme: 'light' }), 'dark');
  assert.equal(previewTheme('auto', { theme: 'light' }), 'light');
  assert.equal(previewTheme('auto', {}), 'auto');
});

test('links in the preview open in a new tab, scroll in place, or do nothing', () => {
  assert.equal(linkAction('https://example.com'), 'new-tab');
  assert.equal(linkAction('mailto:a@example.com'), 'new-tab');
  assert.equal(linkAction('#section'), 'anchor');
  for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'other.smd', '../x', '', null]) {
    assert.equal(linkAction(href), 'block', String(href));
  }
});

test('the playground page never puts document text into its own markup', () => {
  const main = readFileSync(join(PLAYGROUND, 'src', 'main.ts'), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!main.includes(sink), sink);
  }
  assert.match(main, /frame\.setAttribute\('sandbox', PREVIEW_SANDBOX\)/);
});

test('preview updates go over a private port, never as window messages that could follow the frame away', () => {
  const main = readFileSync(join(PLAYGROUND, 'src', 'main.ts'), 'utf8');
  const windowPosts = [...main.matchAll(/contentWindow\?\.postMessage\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(windowPosts.length, 1, 'one window message: the handshake');
  assert.match(windowPosts[0], /^\{ type: 'smd-port' \}, '\*', \[channel\.port2\]$/);
  assert.match(main, /previewPort\?\.postMessage\(updateMessage\(/);
  const { port1, port2 } = new MessageChannel();
  assert.equal(isPortHandshake({ type: 'smd-port' }, [port2], true), true);
  assert.equal(isPortHandshake({ type: 'smd-port' }, [port2], false), false, 'only from the playground page');
  assert.equal(isPortHandshake({ type: 'update' }, [port2], true), false);
  assert.equal(isPortHandshake({ type: 'smd-port' }, [], true), false);
  assert.equal(isPortHandshake(null, [port2], true), false);
  port1.close();
  port2.close();
});

test('the preview takes its update port only from the playground page\'s origin', async () => {
  const { frame } = await assets();
  const preview = renderPanes('# Hi\n').preview;
  assert.match(previewDocument(preview, 'auto', frame, 'http://localhost:8767'), /data-smd-parent-origin="http:\/\/localhost:8767"/);
  assert.match(previewDocument(preview, 'auto', frame), /data-smd-parent-origin="null"/, 'file:// pages have the origin "null"');
  const main = readFileSync(join(PLAYGROUND, 'src', 'main.ts'), 'utf8');
  assert.match(main, /previewDocument\(preview, pref, assets, location\.origin\)/);
  const links = readFileSync(join(PLAYGROUND, 'src', 'previewLinks.ts'), 'utf8');
  assert.match(links, /event\.origin !== PARENT_ORIGIN \|\| event\.source !== window\.parent/);
});

// ---- Editor helpers and storage --------------------------------------------------------

test('Tab indents the caret or every selected line; Shift+Tab outdents', () => {
  assert.deepEqual(indent('ab', 1, 1), { text: 'a  b', start: 3, end: 3 });
  assert.deepEqual(indent('a\nb\nc', 0, 3), { text: '  a\n  b\nc', start: 2, end: 7 });
  assert.deepEqual(outdent('  a\n  b\nc', 2, 7), { text: 'a\nb\nc', start: 0, end: 3 });
  assert.deepEqual(outdent(' x', 1, 1), { text: 'x', start: 0, end: 0 });
  assert.deepEqual(outdent('\tx', 2, 2), { text: 'x', start: 1, end: 1 });
  assert.deepEqual(outdent('x', 0, 0), { text: 'x', start: 0, end: 0 });
});

test('editor offsets, line numbers and minimal replacements', () => {
  const text = 'one\ntwo\nthree';
  assert.equal(offsetOf(text, 1, 1), 5);
  assert.equal(offsetOf(text, 1, 99), 7, 'clamped to the line');
  assert.equal(offsetOf(text, 9, 0), text.length, 'clamped to the text');
  assert.equal(lineNumbers(text), '1\n2\n3');
  assert.equal(lineNumbers(''), '1');
  assert.deepEqual(changedRange('abcdef', 'abXYef'), { from: 2, to: 4, insert: 'XY' });
  assert.deepEqual(changedRange('aaa', 'aaaa'), { from: 3, to: 3, insert: 'a' });
  assert.deepEqual(changedRange('same', 'same'), { from: 4, to: 4, insert: '' });
});

test('storage is optional: missing or throwing storage is ignored', () => {
  const map = new Map<string, string>();
  const store: KeyValueStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  assert.equal(writeStored('k', 'v', store), true);
  assert.equal(readStored('k', store), 'v');
  const broken: KeyValueStore = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(readStored('k', broken), undefined);
  assert.equal(writeStored('k', 'v', broken), false);
  assert.equal(readStored('k', undefined), undefined);
  assert.equal(themeSetting('dark'), 'dark');
  assert.equal(themeSetting('purple'), 'auto');
});

// ---- Browser bundle -----------------------------------------------------------------

/** Node built-ins a browser bundle must not reach for. */
const NODE_ONLY = /\brequire\(\s*["'](?:node:)?(?:fs|path|os|child_process|crypto|url|util|stream|http|https|net|tls|zlib|worker_threads|module|process|buffer)["']\s*\)|["']node:[a-z_/]+["']/;

async function bundle(options: esbuild.BuildOptions): Promise<string> {
  const result = await esbuild.build({ ...options, write: false, minify: false, logLevel: 'silent' });
  return result.outputFiles.map((f) => f.text).join('\n');
}

test('the playground app bundles for the browser without Node built-ins', async () => {
  const { frame } = await assets();
  const code = await bundle(appBundleOptions('app.js', frame));
  assert.ok(code.includes('smd-doc'), 'the engine is in the bundle');
  assert.doesNotMatch(code, NODE_ONLY);
  assert.doesNotMatch(frame.links, NODE_ONLY);
});

test('the whole core library bundles for the browser without Node built-ins', async () => {
  const code = await bundle({
    entryPoints: [join(__dirname, '..', 'src', 'core', 'index.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile: 'core.js',
    loader: { '.md': 'text', '.smd': 'text' },
  });
  assert.doesNotMatch(code, NODE_ONLY);
  assert.doesNotMatch(code, /\bprocess\.(?:cwd|env|exit)\b/);
});

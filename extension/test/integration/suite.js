// Runs inside a VS Code Extension Development Host (see run.mjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const examples = path.resolve(__dirname, '..', '..', '..', 'examples');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const checks = {
  async 'extension activates and .smd gets the smd language'() {
    const doc = await vscode.workspace.openTextDocument(path.join(examples, 'showcase.smd'));
    await vscode.window.showTextDocument(doc);
    assert.equal(doc.languageId, 'smd');
    const ext = vscode.extensions.getExtension('bislink360.styled-markdown');
    assert.ok(ext, 'extension is installed');
    await waitFor(() => ext.isActive, 'activation');
  },

  async 'all commands are registered'() {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['smd.openPreview', 'smd.openPreviewToSide', 'smd.exportHtml', 'smd.exportMarkdown', 'smd.convertFromMarkdown', 'smd.validateWorkspace']) {
      assert.ok(all.includes(c), `missing command ${c}`);
    }
  },

  async 'valid examples produce no problems'() {
    for (const f of ['showcase.smd', 'feature-spec.smd']) {
      const doc = await vscode.workspace.openTextDocument(path.join(examples, f));
      await wait(500);
      const problems = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
      assert.deepEqual(problems.map((p) => p.message), [], f);
    }
  },

  async 'broken syntax is reported with quick fixes'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: ':::warnign\ntext\n\n[x]{color=blu}\n' });
    await vscode.window.showTextDocument(doc);
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length >= 3 ? d : undefined;
    }, 'diagnostics');
    const codes = diags.map((d) => d.code).sort();
    assert.deepEqual(codes, ['attrs/value', 'container/unclosed', 'container/unknown']);
    const unknown = diags.find((d) => d.code === 'container/unknown');
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, unknown.range);
    const fix = actions.find((a) => a.title === 'Change to ":::warning"');
    assert.ok(fix, 'quick fix offered');
    await vscode.workspace.applyEdit(fix.edit);
    assert.match(doc.getText(), /^:::warning/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },

  async 'completion suggests containers, colors and directives'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: ':::\n[t]{color=\n :' });
    const labels = async (line, ch) => {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, ch));
      return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    };
    assert.ok((await labels(0, 3)).includes('warning'));
    assert.ok((await labels(1, 11)).includes('green'));
    assert.ok((await labels(2, 2)).includes('badge'));
  },

  async 'outline and folding work'() {
    const doc = await vscode.workspace.openTextDocument(path.join(examples, 'showcase.smd'));
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    assert.ok(symbols.some((s) => s.name === 'Callouts'));
    const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri);
    assert.ok(folds.length > 10);
  },

  async 'preview opens as a webview'() {
    const doc = await vscode.workspace.openTextDocument(path.join(examples, 'showcase.smd'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('smd.openPreviewToSide');
    await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .some((t) => t.input instanceof vscode.TabInputWebview && t.label.includes('showcase.smd')), 'preview tab');
  },

  async 'preview renders diagrams, math and tabs under the webview CSP'() {
    const uri = vscode.Uri.file(path.join(examples, 'showcase.smd')).toString();
    const status = await waitFor(() => vscode.commands.executeCommand('smd._previewStatus', uri), 'preview render report', 20000);
    console.log(`      preview reported: ${JSON.stringify(status)}`);
    assert.equal(status.diagrams, 3, 'all three Mermaid diagrams rendered to SVG');
    assert.equal(status.errors, 0, 'no render errors');
    assert.ok(status.math >= 2, 'KaTeX math rendered');
    assert.equal(status.tabs, 1, 'tab group initialised');
  },
  async 'agent view opens and copy puts compact text on the clipboard'() {
    const doc = await vscode.workspace.openTextDocument(path.join(examples, 'checkout-redesign.smd'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('smd.showAgentView');
    const view = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'smd-agent'), 'agent view document');
    const text = view.getText();
    assert.match(text, /<agent-instructions title="Engineering constraints">/);
    assert.doesNotMatch(text, /:::|\{agent=skip\}|usability sessions/);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('smd.copyAgentView');
    const clip = await vscode.env.clipboard.readText();
    assert.ok(clip.length < doc.getText().length * 0.75, 'copied view is at least 25% smaller');
  },

  async 'new containers validate in the editor'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: ':::risk{impact=hgh} x\n:::\n' });
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length ? d : undefined;
    }, 'risk diagnostics');
    assert.ok(diags.some((d) => d.code === 'attrs/value' && /did you mean "high"/.test(d.message)));
  },

  async 'smd language is registered with VS Code'() {
    const langs = await vscode.languages.getLanguages();
    assert.ok(langs.includes('smd'));
  },

  async 'go to definition follows anchors, cross-document links and references'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-def-'));
    fs.writeFileSync(path.join(dir, 'other.smd'), '---\nsmd: 1\n---\nIntro\n\n## Pricing rules\n');
    const main = path.join(dir, 'main.smd');
    fs.writeFileSync(main, '## Intro\n\n[a](#intro) [b](other.smd#pricing-rules) [c][ref]\n\n[ref]: other.smd\n');
    const doc = await vscode.workspace.openTextDocument(main);
    const at = async (character) => {
      const [loc] = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(2, character));
      return loc && [path.basename((loc.targetUri ?? loc.uri).fsPath), (loc.targetRange ?? loc.range).start.line];
    };
    const got = [await at(5), await at(20), await at(44), await at(1)];
    assert.deepEqual(got, [['main.smd', 0], ['other.smd', 5], ['main.smd', 4], undefined], JSON.stringify(got));
  },

  async 'Format Document applies smd fmt'() {
    const cases = [
      ['# Title\nText\n::::note\nHi\n::::\n\nEnd\n', '# Title\n\nText\n\n:::note\nHi\n:::\n\nEnd\n'],
      ['Intro\n\n|a|b|\n|-|-|\n|1|2|', 'Intro\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n'],
      ['Already fine.\n', 'Already fine.\n'],
    ];
    for (const [input, expected] of cases) {
      const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: input });
      const edits = (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true })) ?? [];
      const edit = new vscode.WorkspaceEdit();
      edit.set(doc.uri, edits);
      await vscode.workspace.applyEdit(edit);
      assert.equal(doc.getText(), expected);
    }
  },

  async 'completion suggests paths and anchors in links, related and embeds'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-lc-'));
    fs.mkdirSync(path.join(dir, 'specs'));
    fs.writeFileSync(path.join(dir, 'specs', 'pricing.smd'), '# Pricing\n\n## Refund rules\n');
    fs.writeFileSync(path.join(dir, 'logo.png'), '');
    fs.writeFileSync(path.join(dir, 'util.ts'), '');
    const main = path.join(dir, 'main.smd');
    fs.writeFileSync(main, [
      '---', 'related: [specs/]', '---', '## Intro', '',
      '[a](', '[b](specs/pricing.smd#', '[c](#', '```ts file="', '```', '',
    ].join('\n'));
    const doc = await vscode.workspace.openTextDocument(main);
    const labels = async (line, character) => {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, character));
      return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label)).sort();
    };
    assert.deepEqual(await labels(5, 4), ['#intro', 'logo.png', 'specs/', 'util.ts']);
    assert.deepEqual(await labels(6, 22), ['pricing', 'refund-rules']);
    assert.deepEqual(await labels(7, 5), ['intro']);
    assert.deepEqual(await labels(1, 16), ['pricing.smd'], 'related: offers documents only');
    assert.deepEqual(await labels(8, 12), ['logo.png', 'specs/', 'util.ts']);
  },

  async 'find references and rename follow heading anchors across the workspace'() {
    // Workspace-wide search only covers the open folder (examples/), so the fixture lives there briefly.
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, 'zz-refs-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      const a = path.join(dir, 'a.smd');
      fs.writeFileSync(a, '# Guide\n\n## Pricing rules\n\nSee [p](#pricing-rules).\n');
      fs.writeFileSync(path.join(dir, 'b.smd'), '[x](a.smd#pricing-rules) [y](a.smd#guide)\n');
      fs.writeFileSync(path.join(dir, 'sub', 'c.md'), '[z](../a.smd#pricing-rules)\n');
      const doc = await vscode.workspace.openTextDocument(a);
      const heading = new vscode.Position(2, 6);

      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, heading);
      const where = refs.map((r) => `${path.relative(dir, r.uri.fsPath).replace(/\\/g, '/')}:${r.range.start.line}:${r.range.start.character}`).sort();
      assert.deepEqual(where, ['a.smd:2:3', 'a.smd:4:9', 'b.smd:0:10', 'sub/c.md:0:13'], JSON.stringify(where));

      const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, heading, 'Pricing');
      assert.ok(await vscode.workspace.applyEdit(edit));
      const text = async (rel) => (await vscode.workspace.openTextDocument(path.join(dir, rel))).getText();
      assert.equal(await text('a.smd'), '# Guide\n\n## Pricing\n\nSee [p](#pricing).\n');
      assert.equal(await text('b.smd'), '[x](a.smd#pricing) [y](a.smd#guide)\n');
      assert.equal(await text('sub/c.md'), '[z](../a.smd#pricing)\n');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  async 'smd.config.json and suppression comments shape diagnostics, and config edits apply live'() {
    // The config watcher covers the open folder (examples/), so the fixture lives there briefly.
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, 'zz-rules-'));
    try {
      const config = path.join(dir, 'smd.config.json');
      fs.writeFileSync(config, '{ "rules": { "container/unknown": "off", "attrs/value": "hint" } }');
      const file = path.join(dir, 'a.smd');
      fs.writeFileSync(file, ':::warnign\nA [word]{color=blu}\n:::\n\n<!-- smd-disable-next-line -->\n:::tpi\nx\n:::\n');
      const doc = await vscode.workspace.openTextDocument(file);
      const state = () => vscode.languages.getDiagnostics(doc.uri)
        .map((d) => `${d.range.start.line}:${d.code}:${d.severity}`).sort().join(' ');
      await waitFor(() => state() === `1:attrs/value:${vscode.DiagnosticSeverity.Hint}`, `configured diagnostics, got "${state()}"`);

      fs.writeFileSync(config, '{ "rules": { "attrs/*": "off", "contaner/unknown": "off" } }');
      await waitFor(() => state() === `0:container/unknown:${vscode.DiagnosticSeverity.Warning}`, `reloaded config, got "${state()}"`);
      const problems = await waitFor(() => vscode.languages.getDiagnostics(vscode.Uri.file(config)).map((d) => d.message).join(), 'config file problems');
      assert.match(problems, /Unknown rule "contaner\/unknown" — did you mean "container\/unknown"\?/);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  async 'refactorings wrap selections, change callout types and convert blockquotes'() {
    const doc = await vscode.workspace.openTextDocument({
      language: 'smd',
      content: 'First line.\nSecond line.\n\n:::note\nKeep it short.\n:::\n\n> **Warning:** Rotate keys.\n',
    });
    const actions = async (range) =>
      ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, range, 'refactor.rewrite.smd')) ?? []).filter((a) => a.kind?.value === 'refactor.rewrite.smd');
    const run = async (range, title) => {
      const action = (await actions(range)).find((a) => a.title === title);
      assert.ok(action, `no "${title}" in ${JSON.stringify((await actions(range)).map((a) => a.title))}`);
      assert.ok(await vscode.workspace.applyEdit(action.edit));
    };

    const wraps = (await actions(new vscode.Range(0, 0, 2, 0))).map((a) => a.title);
    assert.ok(wraps.includes('Wrap in :::agent (agent instructions)') && wraps.includes('Wrap in :::human (humans only)'), JSON.stringify(wraps));
    await run(new vscode.Range(0, 0, 2, 0), 'Wrap in :::tip (tip)');
    await run(new vscode.Range(5, 2, 5, 2), 'Convert :::note to :::info');
    await run(new vscode.Range(9, 3, 9, 3), 'Convert blockquote to :::warning');
    assert.equal(doc.getText(), ':::tip\nFirst line.\nSecond line.\n:::\n\n:::info\nKeep it short.\n:::\n\n:::warning\nRotate keys.\n:::\n');
    const blank = (await actions(new vscode.Range(4, 0, 4, 0))).map((a) => a.title);
    assert.deepEqual(blank, [], `no actions on a blank line: ${JSON.stringify(blank)}`);
  },

  async 'Mermaid syntax errors are reported, and cleared when fixed'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: '# D\n\n```mermaid\nsequenceDiagram\n  A->>B hi\n```\n' });
    await vscode.window.showTextDocument(doc);
    const mermaid = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'mermaid/syntax');
    const [d] = await waitFor(() => mermaid().length && mermaid(), 'a mermaid/syntax diagnostic');
    assert.equal(d.range.start.line, 4);
    assert.match(d.message, /^Mermaid syntax error: expected TXT/);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(4, 7), ':');
    await vscode.workspace.applyEdit(edit);
    await waitFor(() => mermaid().length === 0, 'the diagnostic to clear');
  },
};

async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(checks)) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (e) {
      console.log(`  ✖ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration check(s) failed`);
}

module.exports = { run };

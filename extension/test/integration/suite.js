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
  async 'preview keeps its scroll anchor and reuses diagrams when the document changes'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-preview-'));
    const file = path.join(dir, 'long.smd');
    const body = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.\n`).join('\n');
    fs.writeFileSync(file, `# Title\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n\`\`\`mermaid\ngraph LR\n  C --> D\n\`\`\`\n\n${body}`);
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('smd.openPreviewToSide');
    const status = () => vscode.commands.executeCommand('smd._previewStatus', doc.uri.toString());
    await waitFor(async () => (await status())?.diagrams === 2, 'first render', 20000);

    // Scroll the editor (the preview follows), then make an edit that moves nothing.
    editor.revealRange(new vscode.Range(100, 0, 100, 0), vscode.TextEditorRevealType.AtTop);
    await wait(800);
    let edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, '\nEnd.\n');
    await vscode.workspace.applyEdit(edit);
    const before = await waitFor(async () => {
      const s = await status();
      return s && s.reused === 2 && s.top > 50 ? s : undefined;
    }, 're-render with cached diagrams');

    // Insert three lines at the top: the same content stays at the top of the preview.
    edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), 'Intro.\n\n\n');
    await vscode.workspace.applyEdit(edit);
    const after = await waitFor(async () => {
      const s = await status();
      return s && s.top !== before.top ? s : undefined;
    }, 're-render after inserting lines above');
    console.log(`      anchor line ${before.top} -> ${after.top}`);
    assert.equal(after.top, before.top + 3);
    assert.equal(after.reused, 2, 'unchanged diagrams reuse their SVG');

    // Let the editor's scroll sync settle, then take the position the preview is at.
    await wait(800);
    edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, '\nEnd.\n');
    await vscode.workspace.applyEdit(edit);
    const settled = await waitFor(async () => {
      const s = await status();
      return s && s.renders > after.renders ? s : undefined;
    }, 're-render after scroll sync');
    await wait(800);

    // Hide the preview behind another editor, edit above while it's hidden, then bring it back.
    const other = await vscode.workspace.openTextDocument({ language: 'smd', content: '# Other\n' });
    await vscode.window.showTextDocument(other, vscode.ViewColumn.Two);
    await wait(500);
    edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), 'More.\n\n');
    await vscode.workspace.applyEdit(edit);
    await wait(500);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('smd.openPreviewToSide');
    const restored = await waitFor(async () => {
      const s = await status();
      return s && s.renders !== settled.renders ? s : undefined;
    }, 'preview restored after being hidden', 20000);
    console.log(`      after hide/restore ${settled.top} -> ${restored.top}`);
    assert.equal(restored.top, settled.top + 2);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
    assert.equal(d.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(d.message, /^Mermaid syntax error: expected TXT/);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(4, 7), ':');
    await vscode.workspace.applyEdit(edit);
    await waitFor(() => mermaid().length === 0, 'the diagnostic to clear');
  },

  async 'front matter completion follows the schema, and stale documents are flagged'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: '---\nsmd: 1\ntheme: \nupdated: 2020-01-01\n\n---\n\nBody\n' });
    const labels = async (line, character) => {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, character));
      // Snippets are always mixed in; keep this provider's keys and values.
      const ours = [vscode.CompletionItemKind.Property, vscode.CompletionItemKind.EnumMember];
      return list.items.filter((i) => ours.includes(i.kind)).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    };
    const themes = (await labels(2, 7)).sort();
    assert.deepEqual(themes, ['auto', 'dark', 'light'], JSON.stringify(themes));
    const keys = await labels(4, 0);
    assert.ok(keys.includes('status') && keys.includes('owners'), JSON.stringify(keys));
    assert.ok(!keys.includes('smd') && !keys.includes('updated'), 'keys already present are not offered');
    await waitFor(() => vscode.languages.getDiagnostics(doc.uri).some((d) => d.code === 'frontmatter/stale' && d.range.start.line === 3), 'a frontmatter/stale diagnostic');
  },

  async 'workspace symbols find headings, decisions and APIs; hovers preview sections and embeds'() {
    const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'post orders');
    const api = symbols.find((s) => s.name === 'POST /v1/orders — Create an order' && s.kind === vscode.SymbolKind.Method);
    assert.ok(api, JSON.stringify(symbols.map((s) => s.name)));
    const decisions = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'launch in the eu');
    assert.ok(decisions.some((s) => s.kind === vscode.SymbolKind.Event), JSON.stringify(decisions.map((s) => s.name)));

    const hoverText = async (doc, line, character) => {
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character));
      return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    };
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: '## Setup\n\nInstall it.\n\nSee [setup](#setup).\n' });
    assert.match(await hoverText(doc, 4, 7), /Install it\./);

    const showcase = await vscode.workspace.openTextDocument(path.join(examples, 'showcase.smd'));
    const embedLine = showcase.getText().split('\n').findIndex((l) => l.includes('file="src/pricing.ts"'));
    assert.ok(embedLine > 0);
    const embed = await hoverText(showcase, embedLine, 3);
    assert.match(embed, /src\/pricing\\\.ts\*\* · lines 1–12/, 'the file name is escaped Markdown');
    assert.match(embed, /```ts/);
  },

  async 'Enter continues task lists, ends empty items, and leaves code alone'() {
    const doc = await vscode.workspace.openTextDocument({ language: 'smd', content: '- [x] Ship it :priority[P1] @maya\n\n```md\n- [ ] in code\n```\n' });
    const editor = await vscode.window.showTextDocument(doc);
    const enterAt = async (line, character) => {
      await vscode.window.showTextDocument(doc); // `type`, the plain-Enter fallback, needs editor focus
      editor.selection = new vscode.Selection(line, character, line, character);
      await vscode.commands.executeCommand('smd.onEnterKey');
    };
    await enterAt(0, doc.lineAt(0).text.length);
    assert.equal(doc.lineAt(1).text, '- [ ]  @maya');
    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [1, 6], 'cursor before the owner');
    await vscode.commands.executeCommand('deleteRight');
    await vscode.commands.executeCommand('deleteRight');
    await vscode.commands.executeCommand('deleteRight');
    await vscode.commands.executeCommand('deleteRight');
    await vscode.commands.executeCommand('deleteRight');
    await vscode.commands.executeCommand('deleteRight');
    assert.equal(doc.lineAt(1).text, '- [ ] ');
    await enterAt(1, 6);
    assert.equal(doc.lineAt(1).text, '', 'Enter on an empty task ends the list');
    const codeLine = doc.getText().split('\n').indexOf('- [ ] in code');
    await enterAt(codeLine, doc.lineAt(codeLine).text.length);
    // Inside code the command hands Enter back to VS Code (`type`), which the test host may not apply
    // to an unfocused window; either way no list marker may appear.
    assert.ok(!doc.getText().includes('- [ ] in code\n- [ ]'), 'no list continuation inside code');
    // Without Code Spell Checker installed, setup explains instead of writing settings.
    assert.equal(await vscode.commands.executeCommand('smd.setupSpellCheck'), false);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },

  async 'the SMD Tasks view groups workspace tasks, follows edits and file events, and checks tasks off'() {
    // The view covers the open folder (examples/), so the fixture lives there briefly.
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, 'zz-tasks-'));
    const today = new Date().toISOString().slice(0, 10);
    const a = path.join(dir, 'a.smd');
    const b = path.join(dir, 'b.smd');
    const inDir = (file) => file.toLowerCase().startsWith(dir.toLowerCase());
    const tree = async (by) => {
      await vscode.commands.executeCommand('smd.groupTasksBy', by);
      return vscode.commands.executeCommand('smd._tasksTree');
    };
    // The fixture's groups (label → task labels), in tree order.
    const ours = (snapshot) => snapshot.groups
      .map((g) => [g.label, g.tasks.filter((t) => inDir(t.file)).map((t) => t.label)])
      .filter(([, tasks]) => tasks.length);
    const until = (by, test, what) => waitFor(async () => {
      const s = await tree(by);
      return test(s) ? s : undefined;
    }, what);
    try {
      fs.writeFileSync(a, [
        '# Plan', '', '## Launch', '',
        '- [ ] Zz overdue :priority[P2] @zz-ann :due[2000-01-01]',
        `- [ ] Zz today :priority[P1] @zz-ann :due[${today}]`,
        '- [ ] Zz later :priority[P0] @zz-ann @zz-bob :due[2999-01-01]',
        '- [x] Zz done @zz-bob', '',
      ].join('\n'));
      fs.writeFileSync(b, '- [ ] Zz unowned\n');
      const all = await vscode.commands.getCommands(true);
      for (const c of ['smd.groupTasksBy', 'smd.showCompletedTasks', 'smd.hideCompletedTasks', 'smd.refreshTasks', 'smd.openTask']) {
        assert.ok(all.includes(c), `missing command ${c}`);
      }
      await vscode.commands.executeCommand('smd.tasks.focus');

      const byOwner = await until('owner', (s) => ours(s).length === 3, 'the fixture tasks grouped by owner');
      assert.equal(byOwner.groupBy, 'owner');
      assert.deepEqual(ours(byOwner), [
        ['@zz-ann', ['Zz overdue', 'Zz later', 'Zz today']],
        ['@zz-bob', ['Zz later']],
        ['Unassigned', ['Zz unowned']],
      ], JSON.stringify(ours(byOwner)));
      assert.equal(byOwner.groups.at(-1).label, 'Unassigned', 'unassigned last');
      const overdue = byOwner.groups.flatMap((g) => g.tasks).find((t) => t.label === 'Zz overdue');
      assert.equal(overdue.description, 'P2 · due 2000-01-01 (overdue) · @zz-ann');
      assert.ok(byOwner.overdue >= 1);

      const byDue = await tree('due');
      assert.deepEqual(ours(byDue), [
        ['Overdue', ['Zz overdue']], ['Today', ['Zz today']], ['Later', ['Zz later']], ['No due date', ['Zz unowned']],
      ], JSON.stringify(ours(byDue)));
      assert.equal(byDue.groups[0].label, 'Overdue', 'overdue first');

      const byDocument = await tree('document');
      assert.deepEqual(ours(byDocument).map(([, tasks]) => tasks), [['Zz overdue', 'Zz later', 'Zz today'], ['Zz unowned']]);
      assert.match(ours(byDocument)[0][0], /zz-tasks-.*\/a\.smd$/);

      // Unsaved edits show up.
      const docB = await vscode.workspace.openTextDocument(b);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(docB.uri, new vscode.Position(1, 0), '- [ ] Zz added @zz-cat\n');
      await vscode.workspace.applyEdit(edit);
      await until('owner', (s) => ours(s).some(([label]) => label === '@zz-cat'), 'a task typed into an open document');
      await docB.save();

      // Checking a task off writes the file, and the task leaves the open list.
      const todayTask = byOwner.groups.flatMap((g) => g.tasks).find((t) => t.label === 'Zz today');
      assert.equal(await vscode.commands.executeCommand('smd._checkTask', todayTask.file, todayTask.line, true), true);
      assert.match(fs.readFileSync(a, 'utf8'), /^- \[x\] Zz today/m);
      await until('owner', (s) => !ours(s).flatMap(([, t]) => t).includes('Zz today'), 'the checked task to leave the list');

      await vscode.commands.executeCommand('smd.showCompletedTasks');
      const withDone = await until('document', (s) => ours(s).flatMap(([, t]) => t).includes('Zz done'), 'completed tasks');
      const checked = withDone.groups.flatMap((g) => g.tasks).find((t) => t.label === 'Zz today');
      assert.equal(checked.done, true);
      assert.equal(await vscode.commands.executeCommand('smd._checkTask', checked.file, checked.line, false), true);
      assert.match(fs.readFileSync(a, 'utf8'), /^- \[ \] Zz today/m);
      await vscode.commands.executeCommand('smd.hideCompletedTasks');

      // Files created and deleted on disk.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(b);
      fs.writeFileSync(path.join(dir, 'c.smd'), '- [ ] Zz new file @zz-dan\n');
      await until('owner', (s) => {
        const labels = ours(s).map(([label]) => label);
        return labels.includes('@zz-dan') && !labels.includes('@zz-cat') && !labels.includes('Unassigned');
      }, 'the created file in and the deleted one out');
    } finally {
      await vscode.commands.executeCommand('smd.hideCompletedTasks');
      await vscode.commands.executeCommand('smd.groupTasksBy', 'due');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  async 'the status bar shows the document status and Set Document Status edits the front matter'() {
    const bar = () => vscode.commands.executeCommand('smd._statusBar');
    const until = (test, what) => waitFor(async () => {
      const s = await bar();
      return test(s) ? s : undefined;
    }, what);
    assert.ok((await vscode.commands.getCommands(true)).includes('smd.setStatus'), 'missing command smd.setStatus');

    const doc = await vscode.workspace.openTextDocument({
      language: 'smd',
      content: '---\r\nsmd: 1\r\ntitle: Plan\r\nstatus: "draft" # keep quotes\r\nupdated: 2020-01-01\r\n---\r\n\r\nBody\r\n',
    });
    await vscode.window.showTextDocument(doc);
    const draft = await until((s) => s.visible && s.text === '$(edit) Draft', 'the draft status in the status bar');
    assert.equal(draft.tooltip, 'Document status: draft — click to change');

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await vscode.commands.executeCommand('smd.setStatus', 'review'), true);
    assert.equal(doc.getText(), `---\r\nsmd: 1\r\ntitle: Plan\r\nstatus: "review" # keep quotes\r\nupdated: ${today}\r\n---\r\n\r\nBody\r\n`);
    assert.ok(doc.isDirty, 'the edit is not saved');
    await until((s) => s.text === '$(eye) Review', 'the review status in the status bar');

    // Undo restores the old status in one step.
    await vscode.commands.executeCommand('undo');
    await until((s) => s.text === '$(edit) Draft', 'the status after undo');

    // An unknown status argument is refused without editing.
    assert.equal(await vscode.commands.executeCommand('smd.setStatus', 'final'), false);
    assert.match(doc.getText(), /status: "draft"/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    // Without front matter: "No status", then a minimal front matter is created.
    const plain = await vscode.workspace.openTextDocument({ language: 'smd', content: '# Notes\n' });
    await vscode.window.showTextDocument(plain);
    await until((s) => s.visible && s.text === '$(circle-large-outline) No status', 'no status in the status bar');
    assert.equal(await vscode.commands.executeCommand('smd.setStatus', 'approved', plain.uri), true);
    assert.equal(plain.getText(), '---\nsmd: 1\nstatus: approved\n---\n\n# Notes\n');
    await until((s) => s.text === '$(verified) Approved', 'the approved status in the status bar');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    // Hidden for other languages.
    const other = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'status: draft\n' });
    await vscode.window.showTextDocument(other);
    await until((s) => !s.visible, 'the status bar item to hide');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  },

  async 'the built-in Markdown preview renders .smd syntax in .md files'() {
    const ext = vscode.extensions.getExtension('bislink360.styled-markdown');
    const contributes = ext.packageJSON.contributes;
    assert.equal(contributes['markdown.markdownItPlugins'], true);
    for (const file of [...contributes['markdown.previewStyles'], ...contributes['markdown.previewScripts']]) {
      assert.ok(fs.existsSync(path.join(ext.extensionPath, file)), `${file} is built`);
    }

    // What VS Code calls with its markdown-it instance.
    const api = await ext.activate();
    assert.equal(typeof api.extendMarkdownIt, 'function');
    const MarkdownIt = require(path.join(ext.extensionPath, 'node_modules', 'markdown-it'));
    const md = api.extendMarkdownIt(new MarkdownIt());
    const html = md.render(':::note Heads up\nUse :badge[smd] syntax in **.md** files.\n:::\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\nplain();\n```\n');
    assert.match(html, /<div class="smd-callout smd-callout-note"/);
    assert.match(html, /<span class="smd-badge">smd<\/span>/);
    assert.match(html, /<pre class="smd-mermaid">/);
    assert.match(html, /<pre><code class="language-js">plain\(\);/, 'plain code blocks stay the host’s');

    // The preview's own renderer, when this VS Code exposes it.
    if ((await vscode.commands.getCommands(true)).includes('markdown.api.render')) {
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Plain\n\n:::tip\nShown as a callout.\n:::\n' });
      const rendered = await vscode.commands.executeCommand('markdown.api.render', doc);
      assert.match(String(rendered), /smd-callout-tip/);
      assert.match(String(rendered), /<h1[^>]*>Plain<\/h1>/);
    } else {
      console.log('    (markdown.api.render is not available in this VS Code: checked extendMarkdownIt only)');
    }
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

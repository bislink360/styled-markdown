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

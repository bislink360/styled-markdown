import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { markdownToSmd, renderStandaloneHtml, smdToMarkdown } from './core';
import { registerLanguageFeatures } from './language';
import { readerFor } from './files';
import { registerAgentView } from './agentViewUi';
import { PreviewManager, renderOptions } from './preview';

export function activate(context: vscode.ExtensionContext): void {
  const previews = new PreviewManager(context);
  const diagnostics = registerLanguageFeatures(context);
  registerAgentView(context);

  const activeSmd = (): vscode.TextDocument | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId === 'smd') return doc;
    vscode.window.showInformationMessage('Open a .smd file first.');
    return undefined;
  };

  context.subscriptions.push(
    previews,

    // Internal (not in the command palette): lets integration tests inspect what a preview rendered.
    vscode.commands.registerCommand('smd._previewStatus', (uri: string) => previews.status(uri)),

    vscode.commands.registerCommand('smd.openPreview', () => {
      const doc = activeSmd();
      if (doc) previews.show(doc, false);
    }),

    vscode.commands.registerCommand('smd.openPreviewToSide', () => {
      const doc = activeSmd();
      if (doc) previews.show(doc, true);
    }),

    vscode.commands.registerCommand('smd.exportHtml', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const media = (f: string) => fs.readFileSync(path.join(context.extensionPath, 'media', f), 'utf8');
      const html = renderStandaloneHtml(doc.getText(), media('smd.css'), media('runtime.js'), { ...renderOptions(doc), agentBlocks: 'collapsed' });
      const target = await vscode.window.showSaveDialog({
        defaultUri: siblingUri(doc.uri, '.html'),
        filters: { HTML: ['html'] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
      const choice = await vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}`, 'Open in Browser');
      if (choice) await vscode.env.openExternal(target);
    }),

    vscode.commands.registerCommand('smd.exportMarkdown', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const target = await vscode.window.showSaveDialog({
        defaultUri: siblingUri(doc.uri, '.md'),
        filters: { Markdown: ['md'] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(smdToMarkdown(doc.getText(), { readFile: readerFor(doc) }), 'utf8'));
      await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside });
    }),

    vscode.commands.registerCommand('smd.convertFromMarkdown', async (uri?: vscode.Uri) => {
      const source = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!source || path.extname(source.fsPath).toLowerCase() !== '.md') {
        vscode.window.showInformationMessage('Select a .md file to convert.');
        return;
      }
      const text = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
      const target = siblingUri(source, '.smd');
      try {
        await vscode.workspace.fs.stat(target);
        const ok = await vscode.window.showWarningMessage(`${path.basename(target.fsPath)} already exists. Overwrite?`, { modal: true }, 'Overwrite');
        if (!ok) return;
      } catch { /* does not exist — good */ }
      await vscode.workspace.fs.writeFile(target, Buffer.from(markdownToSmd(text, path.basename(source.fsPath, '.md')), 'utf8'));
      await vscode.window.showTextDocument(target);
    }),

    vscode.commands.registerCommand('smd.validateWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.smd', '**/node_modules/**');
      let errors = 0;
      for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        errors += diagnostics.update(doc);
      }
      const msg = `Validated ${files.length} .smd file(s): ${errors} error(s).`;
      if (errors) {
        vscode.window.showWarningMessage(msg, 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
      } else {
        vscode.window.showInformationMessage(msg);
      }
    }),
  );
}

export function deactivate(): void {}

function siblingUri(uri: vscode.Uri, ext: string): vscode.Uri {
  const parsed = path.parse(uri.fsPath);
  return vscode.Uri.file(path.join(parsed.dir, parsed.name + ext));
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { markdownToSmd, notionRequests, renderStandaloneHtml, smdToConfluence, smdToMarkdown, smdToNotion } from './core';
import { registerLanguageFeatures } from './language';
import { readerFor } from './files';
import { registerAgentView } from './agentViewUi';
import { registerBlockEditor } from './blockEditor';
import { registerEditorFeatures } from './editorFeatures';
import { extendMarkdownIt } from './markdownPreview';
import { PreviewManager, renderOptions } from './preview';
import { registerStatusWorkflow } from './statusWorkflow';
import { registerTasksView } from './tasksView';
import { registerDocxExport } from './docxExport';
import { registerPdfExport } from './pdfExport';
import { migrationPlan } from './core/migrate';
import { migrationEdit, migrationReport, migrationSummary, planCounts } from './migrateReport';

const APPLY = 'Apply';
/** What the preview says after its summary in the editor. */
const MIGRATE_NEXT = 'Dry run: nothing was changed. "Apply", or Styled Markdown: Migrate to Spec v2, applies it to the editor (not saved).';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The API VS Code's built-in Markdown preview uses (see markdownPreview.ts). */
export interface SmdExtensionApi {
  extendMarkdownIt: typeof extendMarkdownIt;
}

export function activate(context: vscode.ExtensionContext): SmdExtensionApi {
  const previews = new PreviewManager(context);
  const diagnostics = registerLanguageFeatures(context);
  registerAgentView(context);
  registerEditorFeatures(context);
  registerTasksView(context);
  registerStatusWorkflow(context);
  registerDocxExport(context);
  registerPdfExport(context);
  registerBlockEditor(context);

  const activeSmd = (): vscode.TextDocument | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId === 'smd') return doc;
    vscode.window.showInformationMessage('Open a .smd file first.');
    return undefined;
  };

  let migration: vscode.OutputChannel | undefined;
  context.subscriptions.push({ dispose: () => migration?.dispose() });
  /** The migration's output channel, cleared. */
  const migrationChannel = (): vscode.OutputChannel => {
    migration ??= vscode.window.createOutputChannel('Styled Markdown: Migration to Spec v2');
    migration.clear();
    return migration;
  };

  /** Apply the plan of `smd migrate --to 2` to the document as one edit (undoable, not saved), and show its notes. */
  const applyMigration = async (doc: vscode.TextDocument): Promise<void> => {
    const text = doc.getText();
    const plan = migrationPlan(text, { readFile: readerFor(doc) });
    const edit = migrationEdit(text, plan);
    const channel = migrationChannel();
    channel.append(migrationReport(vscode.workspace.asRelativePath(doc.uri), plan));
    if (!edit) {
      vscode.window.showInformationMessage(plan.from >= 2 ? 'This document already says smd: 2: nothing to migrate.' : 'Nothing to migrate in this document (see the output).');
      if (plan.steps.length) channel.show(true);
      return;
    }
    const change = new vscode.WorkspaceEdit();
    change.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
    if (!(await vscode.workspace.applyEdit(change))) {
      vscode.window.showErrorMessage('The migration could not be applied: the document is unchanged.');
      return;
    }
    const { changes, notes } = planCounts(plan);
    const verb = notes === 1 ? 'is' : 'are';
    const left = notes ? ` The ${plural(notes, 'note')} above ${verb} left to you.` : '';
    channel.append(`\nMigrated to spec v2: ${plural(changes, 'change')} applied as one edit, not saved (Undo reverts it).${left}\n`);
    channel.show(true);
    const inOutput = notes ? ` ${plural(notes, 'note')} in the output.` : '';
    vscode.window.showInformationMessage(`Migrated to spec v2 (${plural(changes, 'change')}, not saved).${inOutput}`);
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

    vscode.commands.registerCommand('smd.exportConfluence', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const xml = smdToConfluence(doc.getText(), { readFile: readerFor(doc) });
      await exportBeside(doc, '.confluence.xml', { 'Confluence storage format': ['xml'] }, xml);
    }),

    vscode.commands.registerCommand('smd.exportNotion', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const requests = notionRequests(smdToNotion(doc.getText(), { readFile: readerFor(doc) }));
      await exportBeside(doc, '.notion.json', { 'Notion API blocks': ['json'] }, `${JSON.stringify(requests, null, 2)}\n`);
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

    // The dry run of `smd migrate --to 2` for the current file: a report, nothing is written; "Apply" migrates it.
    vscode.commands.registerCommand('smd.previewMigration', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const plan = migrationPlan(doc.getText(), { readFile: readerFor(doc) });
      const channel = migrationChannel();
      channel.append(migrationReport(vscode.workspace.asRelativePath(doc.uri), plan) + migrationSummary([plan], MIGRATE_NEXT));
      channel.show(true);
      const { changes } = planCounts(plan);
      if (!changes) return;
      const choice = await vscode.window.showInformationMessage(`Migrating to spec v2 changes ${plural(changes, 'place')} (see the output).`, APPLY);
      if (choice === APPLY) await applyMigration(doc);
    }),

    // `smd migrate --to 2` on the open document: one undoable edit, not saved.
    vscode.commands.registerCommand('smd.migrateToV2', async () => {
      const doc = activeSmd();
      if (doc) await applyMigration(doc);
    }),

    vscode.commands.registerCommand('smd.validateWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.smd', '**/node_modules/**');
      let errors = 0;
      for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        errors += await diagnostics.update(doc);
      }
      const msg = `Validated ${files.length} .smd file(s): ${errors} error(s).`;
      if (errors) {
        vscode.window.showWarningMessage(msg, 'Show Problems').then((c) => c && vscode.commands.executeCommand('workbench.actions.view.problems'));
      } else {
        vscode.window.showInformationMessage(msg);
      }
    }),
  );

  return { extendMarkdownIt };
}

export function deactivate(): void {}

/** Save an export next to the document (the user picks the name), then open it beside the editor. */
async function exportBeside(doc: vscode.TextDocument, ext: string, filters: Record<string, string[]>, content: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({ defaultUri: siblingUri(doc.uri, ext), filters });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside });
}

function siblingUri(uri: vscode.Uri, ext: string): vscode.Uri {
  const parsed = path.parse(uri.fsPath);
  return vscode.Uri.file(path.join(parsed.dir, parsed.name + ext));
}

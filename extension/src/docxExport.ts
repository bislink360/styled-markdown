import * as path from 'node:path';
import * as vscode from 'vscode';
import { smdToPandocHtml } from './core';
import { DocxError, exportDocx, findPandoc, PANDOC_INSTALL_URL } from './docx';
import { renderOptions } from './preview';

/** The setting with the path of Pandoc, when it isn't on the PATH VS Code sees. */
const PANDOC_SETTING = 'smd.export.pandocPath';

/** Export to Word (.docx): the document converted by the user's Pandoc, found like `smd docx` finds it. */
export function registerDocxExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('smd.exportDocx', exportActiveDocument));
}

async function exportActiveDocument(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId !== 'smd') {
    vscode.window.showInformationMessage('Open a .smd file first.');
    return;
  }
  const pandoc = await pandocOrHelp();
  if (!pandoc) return;
  const parsed = path.parse(doc.uri.fsPath);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.docx`)),
    filters: { 'Word document': ['docx'] },
  });
  if (!target) return;
  // Agent blocks are left out, as in print.
  const html = smdToPandocHtml(doc.getText(), { ...renderOptions(doc), agentBlocks: 'hidden' });
  try {
    const warnings = await exportDocx(pandoc, html, { out: target.fsPath, resourcePath: parsed.dir || process.cwd() });
    const note = warnings ? ` Pandoc: ${warnings.split('\n')[0]}` : '';
    const choice = await vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}.${note}`, 'Open');
    if (choice) await vscode.env.openExternal(target);
  } catch (err) {
    vscode.window.showErrorMessage(`Export to Word failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Pandoc's path, or undefined after saying it is missing, with a link to install it and one to the setting. */
async function pandocOrHelp(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration().get<string>(PANDOC_SETTING, '').trim();
  try {
    return findPandoc({ explicit: configured || undefined });
  } catch (err) {
    if (!(err instanceof DocxError)) throw err;
    const message = configured
      ? `Pandoc was not found at ${configured} (${PANDOC_SETTING}).`
      : 'Export to Word needs Pandoc, which Styled Markdown does not bundle. Install it, or set its path in '
        + `${PANDOC_SETTING} if it is installed but not on the PATH.`;
    const choice = await vscode.window.showErrorMessage(message, 'Install Pandoc', 'Open Settings');
    if (choice === 'Install Pandoc') await vscode.env.openExternal(vscode.Uri.parse(PANDOC_INSTALL_URL));
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', PANDOC_SETTING);
    return undefined;
  }
}

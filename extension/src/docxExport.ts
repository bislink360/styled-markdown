import * as path from 'node:path';
import * as vscode from 'vscode';
import { smdToPandocHtml } from './core';
import { chooseDocxEngine, DocxError, exportBuiltinDocx, exportDocx, PANDOC_INSTALL_URL, type DocxEngine } from './docx';
import { renderOptions } from './preview';

/** The setting with the path of Pandoc, when it isn't on the PATH VS Code sees. */
const PANDOC_SETTING = 'smd.export.pandocPath';
/** The setting that picks the engine: `auto`, `builtin` or `pandoc`. */
const ENGINE_SETTING = 'smd.export.docxEngine';

/**
 * Export to Word (.docx): the document converted by the user's Pandoc, found like `smd docx` finds it, else
 * written by the built-in writer (since 2.4.0), so it works with nothing to install.
 */
export function registerDocxExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('smd.exportDocx', exportActiveDocument));
}

async function exportActiveDocument(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId !== 'smd') {
    vscode.window.showInformationMessage('Open a .smd file first.');
    return;
  }
  const engine = await engineOrHelp();
  if (!engine) return;
  const parsed = path.parse(doc.uri.fsPath);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.docx`)),
    filters: { 'Word document': ['docx'] },
  });
  if (!target) return;
  // Agent blocks are left out, as in print.
  const options = { ...renderOptions(doc), agentBlocks: 'hidden' as const };
  const resourcePath = parsed.dir || process.cwd();
  try {
    let note = '';
    if (engine.name === 'builtin') {
      const warnings = exportBuiltinDocx(doc.getText(), { out: target.fsPath, resourcePath, readFile: options.readFile, agentBlocks: 'hidden' });
      if (warnings.length) note = ` ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ''}`;
    } else {
      const warnings = await exportDocx(engine.pandoc, smdToPandocHtml(doc.getText(), options), { out: target.fsPath, resourcePath });
      if (warnings) note = ` Pandoc: ${warnings.split('\n')[0]}`;
    }
    const choice = await vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}.${note}`, 'Open');
    if (choice) await vscode.env.openExternal(target);
  } catch (err) {
    vscode.window.showErrorMessage(`Export to Word failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The engine from the settings: Pandoc when it is set or on the PATH, else the built-in writer, unless
 * smd.export.docxEngine picks one. Undefined after saying why Pandoc, when asked for, can't run.
 */
async function engineOrHelp(): Promise<DocxEngine | undefined> {
  const config = vscode.workspace.getConfiguration();
  const configured = config.get<string>(PANDOC_SETTING, '').trim();
  const engine = config.get<string>(ENGINE_SETTING, 'auto');
  try {
    return chooseDocxEngine({ explicit: configured || undefined, engine });
  } catch (err) {
    if (!(err instanceof DocxError)) throw err;
    const message = configured
      ? `Pandoc was not found at ${configured} (${PANDOC_SETTING}).`
      : `Export to Word is set to use Pandoc (${ENGINE_SETTING}), which Styled Markdown does not bundle. Install it, `
        + `set its path in ${PANDOC_SETTING} if it is installed but not on the PATH, or set ${ENGINE_SETTING} to auto.`;
    const choice = await vscode.window.showErrorMessage(message, 'Install Pandoc', 'Open Settings');
    if (choice === 'Install Pandoc') await vscode.env.openExternal(vscode.Uri.parse(PANDOC_INSTALL_URL));
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'smd.export');
    return undefined;
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderStandaloneHtml } from './core';
import { searchPaths } from './optionalPackage';
import { exportPdf, loadPdfEngine, PdfError, pdfOptions, type PdfEngine } from './pdf';
import { renderOptions } from './preview';

/** The settings: the browser to print with, and the paper. */
const BROWSER_SETTING = 'smd.export.browserPath';
const FORMAT_SETTING = 'smd.export.pdfFormat';
const LANDSCAPE_SETTING = 'smd.export.pdfLandscape';

/**
 * Export to PDF: the page Export to HTML writes, printed by a headless browser, found like `smd export --to pdf`
 * finds one: the smd.export.browserPath setting (or SMD_BROWSER), Playwright or Puppeteer in the workspace, or
 * an installed Chrome, Edge, Chromium or Brave. Diagrams print as vectors; collapsed blocks are expanded.
 */
export function registerPdfExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('smd.exportPdf', () => exportActiveDocument(context)));
}

async function exportActiveDocument(context: vscode.ExtensionContext): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId !== 'smd') {
    vscode.window.showInformationMessage('Open a .smd file first.');
    return;
  }
  const engine = await engineOrHelp(doc);
  if (!engine) return;
  const parsed = path.parse(doc.uri.fsPath);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(parsed.dir, `${doc.isUntitled ? 'document' : parsed.name}.pdf`)),
    filters: { PDF: ['pdf'] },
  });
  if (!target) return;
  const config = vscode.workspace.getConfiguration();
  const options = pdfOptions(config.get<string>(FORMAT_SETTING, 'A4'), config.get<boolean>(LANDSCAPE_SETTING, false));
  const media = (f: string) => fs.readFileSync(path.join(context.extensionPath, 'media', f), 'utf8');
  const html = renderStandaloneHtml(doc.getText(), media('smd.css'), media('runtime.js'), { ...renderOptions(doc), agentBlocks: 'collapsed' });
  // The page is printed from beside the document, so relative images resolve; an unsaved one prints from the PDF's folder.
  const source = doc.isUntitled || doc.uri.scheme !== 'file' ? path.join(path.dirname(target.fsPath), 'untitled.smd') : doc.uri.fsPath;
  const warnings: string[] = [];
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(target.fsPath)}…` },
      () => exportPdf(source, html, target.fsPath, options, { engine, warn: (message) => warnings.push(message) }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(`Export to PDF failed: ${message}`, 'Open Settings');
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', BROWSER_SETTING);
    return;
  }
  const note = warnings.length ? ` ${warnings[0]}` : '';
  const choice = await vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)} (printed with ${engine.name}).${note}`, 'Open');
  if (choice) await vscode.env.openExternal(target);
}

/** The engine to print with, or undefined after saying why there is none, with a link to the setting. */
async function engineOrHelp(doc: vscode.TextDocument): Promise<PdfEngine | undefined> {
  const configured = vscode.workspace.getConfiguration().get<string>(BROWSER_SETTING, '').trim();
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  try {
    return loadPdfEngine({ browser: configured || undefined, paths: [...(folder ? [folder] : []), ...searchPaths()] });
  } catch (err) {
    if (!(err instanceof PdfError)) throw err;
    const message = configured
      ? `No browser was found at ${configured} (${BROWSER_SETTING}).`
      : 'Export to PDF needs Google Chrome, Microsoft Edge, Chromium or Brave, which Styled Markdown does not bundle. '
        + `Install one, or set its path in ${BROWSER_SETTING}. Or use Export to HTML and print the page from your browser.`;
    const choice = await vscode.window.showErrorMessage(message, 'Open Settings', 'Export to HTML');
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', BROWSER_SETTING);
    if (choice === 'Export to HTML') await vscode.commands.executeCommand('smd.exportHtml');
    return undefined;
  }
}

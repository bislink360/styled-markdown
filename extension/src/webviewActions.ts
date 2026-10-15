// What a Styled Markdown webview (the preview, the Block Editor) asks the extension to do for it.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { taskCheckbox } from './editing';

/** Tick or untick the task checkbox on `line` of the document; nothing when that line has none. */
export async function toggleTask(document: vscode.TextDocument, line: number): Promise<void> {
  if (line < 0 || line >= document.lineCount) return;
  const box = taskCheckbox(document.lineAt(line).text);
  if (!box) return;
  const edit = new vscode.WorkspaceEdit();
  const pos = new vscode.Position(line, box.column);
  edit.replace(document.uri, new vscode.Range(pos, pos.translate(0, 1)), box.done ? ' ' : 'x');
  await vscode.workspace.applyEdit(edit);
}

/** Show the document in a text editor with the cursor on `line`. */
export async function revealLine(document: vscode.TextDocument, line: number): Promise<void> {
  const visible = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const editor = await vscode.window.showTextDocument(document, visible?.viewColumn ?? vscode.ViewColumn.One);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Follow a link clicked in the page: URLs outside VS Code, files relative to the document in an editor. */
export async function openLink(document: vscode.TextDocument, href: string): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const [file] = href.split('#');
  const target = vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), decodeURIComponent(file)));
  try {
    await vscode.workspace.fs.stat(target);
    await vscode.commands.executeCommand('vscode.open', target, vscode.ViewColumn.One);
  } catch {
    vscode.window.showWarningMessage(`Styled Markdown: "${file}" does not exist.`);
  }
}

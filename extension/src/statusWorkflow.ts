import * as vscode from 'vscode';
import { STATUS_VALUES } from './core';
import {
  documentStatus, isStatus, setStatusEdits, STATUS_ICONS, STATUS_MEANINGS, statusBarText, statusChoices,
  type TextEdit,
} from './documentStatus';

/** The document status workflow: a status bar item for the front matter `status` of the active .smd editor, and a picker to change it. */

/** Dates in documents use today's UTC date, as front matter completion and the stale check do. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

const activeSmd = (): vscode.TextDocument | undefined => {
  const doc = vscode.window.activeTextEditor?.document;
  return doc?.languageId === 'smd' ? doc : undefined;
};

class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('smd.status', vscode.StatusBarAlignment.Right, 100);
  /** Whether the item is showing (the status bar API can't tell), for integration tests. */
  private visible = false;

  constructor() {
    this.item.name = 'Styled Markdown Document Status';
    this.item.command = 'smd.setStatus';
  }

  /** Show the status of the active .smd document, or hide the item for other editors. */
  update(): void {
    const doc = activeSmd();
    this.visible = !!doc;
    if (!doc) {
      this.item.hide();
      return;
    }
    const { text, tooltip, warning } = statusBarText(documentStatus(doc.getText()));
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  snapshot() {
    return { visible: this.visible, text: this.item.text, tooltip: this.item.tooltip };
  }

  dispose(): void {
    this.item.dispose();
  }
}

async function pickStatus(doc: vscode.TextDocument): Promise<string | undefined> {
  const state = documentStatus(doc.getText());
  const current = state.kind === 'known' ? state.status : undefined;
  const items = statusChoices(current).map((choice) => ({
    label: `$(${STATUS_ICONS[choice.status]}) ${choice.status}`,
    description: choiceNote(choice),
    detail: STATUS_MEANINGS[choice.status],
    status: choice.status,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Set the document status', matchOnDescription: true });
  return picked?.status;
}

function choiceNote(choice: { current: boolean; next: boolean }): string {
  if (choice.current) return 'current';
  return choice.next ? 'next step' : '';
}

/** Set the front matter status with one undoable edit. The document is not saved. */
async function applyStatus(doc: vscode.TextDocument, status: string): Promise<boolean> {
  const updateDate = vscode.workspace.getConfiguration('smd.status', doc.uri).get<boolean>('updateDate', true);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const result = setStatusEdits(doc.getText(), status, { eol, today: updateDate ? todayUtc() : undefined });
  if (!result.ok) {
    vscode.window.showWarningMessage(`Styled Markdown: ${result.reason}`);
    return false;
  }
  if (!result.edits.length) return true;
  const edit = new vscode.WorkspaceEdit();
  for (const e of result.edits) edit.replace(doc.uri, toRange(e), e.text);
  return vscode.workspace.applyEdit(edit);
}

const toRange = (e: TextEdit) => new vscode.Range(e.line, e.start, e.line, e.end);

/** `smd.setStatus [status] [uri]`: with a status (e.g. from a keybinding or a test) no picker is shown. */
async function setStatus(status?: unknown, uri?: unknown): Promise<boolean> {
  const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : activeSmd();
  if (!doc) {
    vscode.window.showInformationMessage('Open a .smd file first.');
    return false;
  }
  if (typeof status === 'string' && !isStatus(status)) {
    vscode.window.showWarningMessage(`Styled Markdown: "${status}" is not a document status. Use one of ${STATUS_VALUES.join(', ')}.`);
    return false;
  }
  const chosen = isStatus(status) ? status : await pickStatus(doc);
  return chosen ? applyStatus(doc, chosen) : false;
}

export function registerStatusWorkflow(context: vscode.ExtensionContext): void {
  const bar = new StatusBar();
  bar.update();
  context.subscriptions.push(
    bar,
    vscode.window.onDidChangeActiveTextEditor(() => bar.update()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) bar.update();
    }),
    // A document's language can change (e.g. "Change Language Mode") without the editor changing.
    vscode.workspace.onDidOpenTextDocument(() => bar.update()),
    vscode.commands.registerCommand('smd.setStatus', setStatus),

    // Internal (not in the command palette): lets integration tests read the status bar item.
    vscode.commands.registerCommand('smd._statusBar', () => bar.snapshot()),
  );
}

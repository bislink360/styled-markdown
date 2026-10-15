// The Styled Markdown Block Editor (Preview): a custom text editor over the same TextDocument as the text editor, so
// undo, save, the dirty state, diffs and diagnostics keep working. The page shows the document block by block and
// asks for edits by block key; blockEditorSession.ts decides what each request changes. Opt-in through "Open With…"
// or "Styled Markdown: Open Block Editor"; never the default editor for .smd files.
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BlockEditorSession, readEditorMessage, type BlockEditorStatus, type DiagnosticSeverity, type DocumentPort, type LineDiagnostic, type QuickFix,
} from './blockEditorSession';
import type { LineRange } from './core/sourceEdit';
import { imageBaseName, imageMarkdown } from './editing';
import { freeName, targetFolder } from './editorFeatures';
import { renderBlocks, segmentSmd } from './core/blocks';
import { scanInline } from './core/inlineEdit';
import { readTable } from './core/tableEdit';
import { blockTemplates, type Snippet } from './core/templates';
import { renderOptions, themePreference } from './preview';
import { openLink, revealLine, toggleTask } from './webviewActions';
import { webviewShell } from './webviewShell';
import snippets from '../snippets/smd.json';

export const BLOCK_EDITOR_VIEW_TYPE = 'smd.blockEditor';

/** How long after a change the page gets the document again. */
const RENDER_DELAY = 200;
/** How long a save waits for the page to write its draft. */
const FLUSH_TIMEOUT = 1000;

const SEVERITIES: ReadonlyMap<vscode.DiagnosticSeverity, DiagnosticSeverity> = new Map([
  [vscode.DiagnosticSeverity.Error, 'error'],
  [vscode.DiagnosticSeverity.Warning, 'warning'],
]);

/** How long a quick fix request waits for diagnostics of the document's current version. */
const DIAGNOSTICS_WAIT = 1000;

/** A code action the editor offers: a quick fix with an edit, no command, not disabled. */
function isEditFix(action: vscode.CodeAction | vscode.Command): action is vscode.CodeAction & { edit: vscode.WorkspaceEdit } {
  // A Command's `command` is its id; a CodeAction's is an optional Command to run after its edit.
  if (typeof action.command === 'string') return false;
  const fix = action as vscode.CodeAction;
  return !!fix.edit && !fix.command && !fix.disabled && !!fix.kind && vscode.CodeActionKind.QuickFix.contains(fix.kind);
}

/** A code action as the session sees it: where it writes in this document, whether elsewhere, and how to apply it. */
function quickFix(action: vscode.CodeAction & { edit: vscode.WorkspaceEdit }, uri: vscode.Uri): QuickFix {
  const entries = action.edit.entries();
  const here = entries.filter(([u]) => u.toString() === uri.toString());
  const resources = new Set(entries.map(([u]) => u.toString()));
  const position = (p: vscode.Position) => ({ line: p.line, character: p.character });
  return {
    title: action.title,
    edits: here.flatMap(([, edits]) => edits.map((e) => ({ start: position(e.range.start), end: position(e.range.end) }))),
    // Other documents, or file operations (which `size` counts but `entries` doesn't list).
    elsewhere: here.length !== entries.length || action.edit.size > resources.size,
    diagnostics: (action.diagnostics ?? []).map((d) => d.range.start.line),
    apply: () => vscode.workspace.applyEdit(action.edit),
  };
}

/** The TextDocument as blockEditorSession.ts sees it. */
function documentPort(document: vscode.TextDocument): DocumentPort {
  return {
    getText: () => document.getText(),
    get version() {
      return document.version;
    },
    get eol() {
      return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    },
    applyEdits: (edits) => {
      const edit = new vscode.WorkspaceEdit();
      for (const e of edits) edit.replace(document.uri, new vscode.Range(document.positionAt(e.from), document.positionAt(e.to)), e.insert);
      return vscode.workspace.applyEdit(edit);
    },
  };
}

/** One Block Editor panel on a document. */
class BlockEditorPanel implements vscode.Disposable {
  readonly session: BlockEditorSession;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The document version the last diagnostics were reported for, and who waits for the next ones. */
  private diagnosed: number;
  private readonly diagnosedWaiters: (() => void)[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const options = () => renderOptions(document);
    this.diagnosed = document.version;
    this.session = new BlockEditorSession(documentPort(document), {
      // Quick fixes from the badge of a block: the session checks where they write, and asks before more than the block.
      quickFixes: (range) => this.quickFixes(range),
      // Pasted and dropped images: saved where the text editor saves them (smd.images.folder), under a name the host picks.
      saveImage: (bytes, extension, name) => this.saveImage(bytes, extension, name),
      // Numbered inline directives and spans: the page edits them in small forms (setInline).
      render: (text) => renderBlocks(text, { ...options(), inlineIndex: true }),
      scan: (lines) => scanInline(lines, { allowHtml: options().allowHtml }),
      // Table blocks: the grid (tableCell, tableRow, tableCol, tableAlign).
      table: (lines) => readTable(lines, { allowHtml: options().allowHtml }),
      segment: (text) => segmentSmd(text, options()),
      templates: blockTemplates(snippets as Record<string, Snippet>),
      post: (message) => void this.panel.webview.postMessage(message),
      diagnostics: () => this.diagnostics(),
      themePref: themePreference,
      title: path.basename(document.fileName, path.extname(document.fileName)),
    });
    const webview = panel.webview;
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        docDir,
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ],
    };
    webview.html = this.shell();
    const uri = document.uri.toString();
    this.disposables.push(
      webview.onDidReceiveMessage((raw) => this.onMessage(raw)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== document) return;
        this.session.recordChange(
          document.version,
          e.contentChanges.map((c) => ({ startLine: c.range.start.line, startCharacter: c.range.start.character, endLine: c.range.end.line, endCharacter: c.range.end.character, text: c.text })),
        );
        this.schedule();
      }),
      vscode.languages.onDidChangeDiagnostics((e) => {
        if (!e.uris.some((u) => u.toString() === uri)) return;
        this.diagnosed = document.version;
        this.diagnosedWaiters.splice(0).forEach((resolve) => resolve());
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('smd.preview')) this.schedule();
      }),
      // Embedded source files (```ts file="…") or included documents (:::include) may have changed.
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d !== document) this.schedule();
      }),
      // A draft still in the page goes into the document before it is saved.
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document === document && panel.visible) e.waitUntil(this.session.flush(FLUSH_TIMEOUT));
      }),
    );
  }

  /** Write the page's draft into the document, if the page is there to answer. */
  flush(): Promise<void> {
    return this.panel.visible ? this.session.flush(FLUSH_TIMEOUT) : Promise.resolve();
  }

  status(): BlockEditorStatus {
    return this.session.status();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A hidden page is gone (no retainContextWhenHidden); it asks for the document when it is shown again.
      if (this.panel.visible) this.session.update();
    }, RENDER_DELAY);
  }

  private diagnostics(): LineDiagnostic[] {
    return vscode.languages.getDiagnostics(this.document.uri).map((d) => ({
      line: d.range.start.line,
      message: d.message,
      severity: SEVERITIES.get(d.severity) ?? 'info',
    }));
  }

  /**
   * The quick fixes for the problems on a block's lines: code actions of kind quickfix that carry an edit and run
   * no command (applying one writes only its edit), asked for once the diagnostics belong to this document version,
   * so their ranges are the document's own.
   */
  private async quickFixes(range: LineRange): Promise<QuickFix[]> {
    await this.diagnosticsCurrent();
    const doc = this.document;
    const last = Math.min(Math.max(range.start, range.end - 1), doc.lineCount - 1);
    const lines = new vscode.Range(range.start, 0, last, doc.lineAt(last).text.length);
    const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[] | undefined>(
      'vscode.executeCodeActionProvider', doc.uri, lines, vscode.CodeActionKind.QuickFix.value,
    );
    return (actions ?? []).filter(isEditFix).map((action) => quickFix(action, doc.uri));
  }

  /**
   * Save an image from the page as a new file, as image paste in the text editor does: in `smd.images.folder` (of
   * the workspace folder, or next to the document), named after the dropped file or the document and the time, never
   * over another file. The page only sends the bytes; the folder and the name are decided here.
   */
  private async saveImage(bytes: Uint8Array, extension: string, name: string | undefined): Promise<{ markdown: string; path: string } | { refused: string }> {
    const doc = this.document;
    if (doc.uri.scheme !== 'file') return { refused: 'Save the document first: images are saved in a folder next to it.' };
    try {
      const folder = targetFolder(doc);
      const file = await freeName(folder, imageBaseName(doc.uri.fsPath, name, new Date()), extension, new Set());
      const target = path.join(folder, file);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(folder));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(target), bytes);
      return { markdown: imageMarkdown(doc.uri.fsPath, target), path: vscode.workspace.asRelativePath(target) };
    } catch (error) {
      return { refused: `The image could not be saved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Resolves once diagnostics have been reported for the document as it is now (or after a second). */
  private diagnosticsCurrent(): Promise<void> {
    if (this.diagnosed === this.document.version) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, DIAGNOSTICS_WAIT);
      this.diagnosedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const message = readEditorMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'toggleTask':
        await toggleTask(this.document, message.line);
        return;
      case 'openLink':
        await openLink(this.document, message.href);
        return;
      case 'revealLine':
        await revealLine(this.document, Math.min(message.line, Math.max(0, this.document.lineCount - 1)));
        return;
      default:
        await this.session.handle(message);
    }
  }

  private shell(): string {
    const webview = this.panel.webview;
    const extension = this.context.extensionUri;
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', ...p)).toString();
    const base = webview.asWebviewUri(vscode.Uri.file(path.dirname(this.document.uri.fsPath))).toString().replace(/\/$/, '');
    const css = media('block-editor.css');
    return webviewShell({
      cspSource: webview.cspSource,
      lang: 'en',
      htmlAttributes: { 'data-smd-theme-pref': 'auto' },
      baseHref: `${base}/`,
      styles: [media('vendor', 'katex', 'katex.min.css'), media('smd.css'), css],
      bodyClass: 'smd-body smd-ed-body',
      mode: 'block-editor',
      bodyAttributes: { 'data-smd-ed-css': css },
      body: '<div id="smd-ed-toolbar"></div>\n<main id="smd-root" class="smd-ed-root"></main>',
      scripts: [
        media('vendor', 'mermaid.min.js'),
        media('runtime.js'),
        webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'webview', 'block-editor.js')).toString(),
      ],
    });
  }
}

/** The Block Editor's custom editor provider: one panel per opened editor. */
export class BlockEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, BlockEditorPanel[]>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const editor = new BlockEditorPanel(this.context, document, panel);
    const key = document.uri.toString();
    this.panels.set(key, [...(this.panels.get(key) ?? []), editor]);
    panel.onDidDispose(() => {
      editor.dispose();
      const rest = (this.panels.get(key) ?? []).filter((p) => p !== editor);
      if (rest.length) this.panels.set(key, rest);
      else this.panels.delete(key);
    });
  }

  /** The newest panel's status for a document (the integration test reads it). */
  status(uri: string): BlockEditorStatus | undefined {
    return this.panels.get(uri)?.at(-1)?.status();
  }

  /** Write the drafts of every panel on a document. */
  async flush(uri: vscode.Uri): Promise<void> {
    await Promise.all((this.panels.get(uri.toString()) ?? []).map((p) => p.flush()));
  }
}

/** The .smd file a command is about: its argument, the active text editor's, or the active tab's. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc) return doc.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

const isSmd = (uri: vscode.Uri | undefined): uri is vscode.Uri => !!uri && path.extname(uri.path).toLowerCase() === '.smd';

/** Close the Block Editor tabs on a document in the active editor group. */
async function closeBlockEditors(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.activeTabGroup.tabs.filter((t) =>
    t.input instanceof vscode.TabInputCustom && t.input.viewType === BLOCK_EDITOR_VIEW_TYPE && t.input.uri.toString() === uri.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

/** Register the Block Editor, its commands and the internal status command. */
export function registerBlockEditor(context: vscode.ExtensionContext): void {
  const provider = new BlockEditorProvider(context);
  context.subscriptions.push(
    // No retainContextWhenHidden: a hidden page is let go and comes back from its saved state.
    vscode.window.registerCustomEditorProvider(BLOCK_EDITOR_VIEW_TYPE, provider, { webviewOptions: { enableFindWidget: true } }),

    vscode.commands.registerCommand('smd.openBlockEditor', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!isSmd(uri)) {
        vscode.window.showInformationMessage('Open a .smd file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, BLOCK_EDITOR_VIEW_TYPE);
    }),

    vscode.commands.registerCommand('smd.reopenInTextEditor', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!isSmd(uri)) return;
      await provider.flush(uri);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      await closeBlockEditors(uri);
    }),

    // Internal (not in the command palette): lets integration tests see what a Block Editor was given.
    vscode.commands.registerCommand('smd._blockEditorStatus', (uri: string) => provider.status(uri)),
  );
}

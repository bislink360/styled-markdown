// The Styled Markdown Block Editor (Preview): a custom text editor over the same TextDocument as the text editor, so
// undo, save, the dirty state, diffs and diagnostics keep working. The page shows the document block by block and
// asks for edits by block key; blockEditorSession.ts decides what each request changes. Opt-in through "Open With…"
// or "Styled Markdown: Open Block Editor"; never the default editor for .smd files.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BlockEditorSession, readEditorMessage, type BlockEditorStatus, type DiagnosticSeverity, type DocumentPort, type LineDiagnostic } from './blockEditorSession';
import { renderBlocks, segmentSmd } from './core/blocks';
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const options = () => renderOptions(document);
    this.session = new BlockEditorSession(documentPort(document), {
      render: (text) => renderBlocks(text, options()),
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
        if (e.uris.some((u) => u.toString() === uri)) this.schedule();
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
    vscode.window.registerCustomEditorProvider(BLOCK_EDITOR_VIEW_TYPE, provider),

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

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentView, parseSmd, type AgentViewOptions } from './core';
import { readerFor } from './files';

const SCHEME = 'smd-agent';

/** Live, read-only "what an agent sees" documents: smd-agent:/name.agent.md?<source uri>#brief */
class AgentViewProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Set<string>();

  static uriFor(source: vscode.Uri, brief: boolean): vscode.Uri {
    const name = path.basename(source.fsPath, '.smd') + (brief ? '.agent-brief.md' : '.agent.md');
    return vscode.Uri.from({ scheme: SCHEME, path: '/' + name, query: source.toString(), fragment: brief ? 'brief' : '' });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.open.add(uri.toString());
    const source = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.query);
    if (!source) return '(source document is not open)';
    const result = agentView(source.getText(), { brief: uri.fragment === 'brief', readFile: readerFor(source) });
    const saved = Math.round((1 - result.tokens / Math.max(1, result.originalTokens)) * 100);
    return `<!-- Agent view: ≈${result.tokens} tokens (source ≈${result.originalTokens}, ${saved}% smaller). Read-only; edit the .smd file. -->\n\n${result.text}`;
  }

  refresh(source: vscode.Uri): void {
    for (const key of this.open) {
      const uri = vscode.Uri.parse(key);
      if (uri.query === source.toString()) this.emitter.fire(uri);
    }
  }
}

export function registerAgentView(context: vscode.ExtensionContext): void {
  const provider = new AgentViewProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'smd.showAgentView';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const activeSmd = (): vscode.TextDocument | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId === 'smd') return doc;
    vscode.window.showInformationMessage('Open a .smd file first.');
    return undefined;
  };

  const updateStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'smd') { status.hide(); return; }
    const full = agentView(doc.getText(), { readFile: readerFor(doc) });
    const brief = agentView(doc.getText(), { brief: true, readFile: readerFor(doc) });
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    status.text = `$(hubot) ≈${k(full.tokens)} tok`;
    status.tooltip = new vscode.MarkdownString(
      `**Agent token estimate**\n\n| View | ≈ tokens |\n|---|---:|\n| Raw file | ${full.originalTokens} |\n| Agent view | ${full.tokens} |\n| Agent view, brief | ${brief.tokens} |\n\nClick to open the agent view.`);
    status.show();
  };

  const show = async (brief: boolean) => {
    const doc = activeSmd();
    if (!doc) return;
    const target = await vscode.workspace.openTextDocument(AgentViewProvider.uriFor(doc.uri, brief));
    await vscode.languages.setTextDocumentLanguage(target, 'markdown');
    await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  };

  const copy = async (options: AgentViewOptions, what: string) => {
    const doc = activeSmd();
    if (!doc) return;
    const result = agentView(doc.getText(), { ...options, readFile: readerFor(doc) });
    await vscode.env.clipboard.writeText(result.text);
    vscode.window.setStatusBarMessage(`$(check) Copied ${what} (≈${result.tokens} tokens)`, 4000);
  };

  context.subscriptions.push(
    status,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand('smd.showAgentView', () => show(false)),
    vscode.commands.registerCommand('smd.showAgentViewBrief', () => show(true)),
    vscode.commands.registerCommand('smd.copyAgentView', () => copy({}, 'agent view')),
    vscode.commands.registerCommand('smd.copyAgentSections', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const headings = parseSmd(doc.getText()).headings;
      const picks = await vscode.window.showQuickPick(
        headings.map((h) => ({ label: `${'  '.repeat(h.level - 1)}${h.text}`, description: h.agent === 'skip' ? 'skipped for agents' : `L${h.line + 1}`, slug: h.slug })),
        { canPickMany: true, placeHolder: 'Sections to copy for an agent (agent instructions are always included)' },
      );
      if (picks?.length) await copy({ sections: picks.map((p) => p.slug) }, `${picks.length} section(s)`);
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'smd') return;
      clearTimeout(timer);
      // Two agent views per update: wait longer on long documents so typing stays smooth.
      const delay = Math.min(2000, Math.max(400, e.document.lineCount / 10));
      timer = setTimeout(() => {
        provider.refresh(e.document.uri);
        if (e.document === vscode.window.activeTextEditor?.document) updateStatus();
      }, delay);
    }),
  );
  updateStatus();
}

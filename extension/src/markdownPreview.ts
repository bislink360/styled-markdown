import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import type { MarkdownItSmdOptions } from './core/markdownIt';
import { applySmd, hostContext, smdFeatures } from './core/markdownItSetup';
import { documentRiskMatrixHtml } from './core/riskHtml';
import { readerForUri } from './files';
import { applyWhen, previewApplies, previewMode } from './markdownPreviewGate';

/** The instances extendMarkdownIt has added the rules to. */
const extended = new WeakSet<MarkdownIt>();

/**
 * Styled Markdown syntax in VS Code's built-in Markdown preview, for .md files. VS Code calls this
 * (`markdown.markdownItPlugins` in package.json) when it builds its markdown-it instance; the settings
 * are read then, so a change applies after Developer: Reload Window. Plain Markdown is unchanged:
 * .smd rules only match text it would show literally, and other code blocks stay VS Code's.
 *
 * `smd.markdownPreview.enabled` says which files get the syntax (see markdownPreviewGate.ts): since 2.0 only those
 * whose front matter has an `smd` key, unless it is `always`. The rules are on the instance either way, and each
 * parse decides from its source whether they run.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
  const mode = previewMode(vscode.workspace.getConfiguration('smd.markdownPreview').inspect('enabled'));
  if (mode === 'never' || extended.has(md)) return md;
  extended.add(md);
  const options = markdownPreviewOptions();
  const add = (target: MarkdownIt) => applySmd(target, smdFeatures(options), { ...hostContext(md, options), riskMatrix: documentRiskMatrixHtml });
  if (mode === 'always') add(md);
  else applyWhen(md, (source) => previewApplies(mode, source), add);
  return md;
}

export function markdownPreviewOptions(): MarkdownItSmdOptions {
  return {
    // VS Code renders $…$ and $$…$$ itself while markdown.math.enabled is on.
    math: !vscode.workspace.getConfiguration('markdown.math').get<boolean>('enabled', true),
    // Checkboxes couldn't be toggled from this preview, and other extensions may render [ ] already.
    tasks: false,
    agentBlocks: vscode.workspace.getConfiguration('smd.preview').get<'collapsed' | 'expanded' | 'hidden'>('showAgentBlocks', 'collapsed'),
    readFile: (relativePath, env) => readerForUri(previewDocument(env))?.(relativePath),
  };
}

/** The document VS Code is rendering: its env carries `currentDocument`. */
function previewDocument(env: unknown): Pick<vscode.Uri, 'scheme' | 'fsPath'> | undefined {
  const uri = (env as { currentDocument?: Partial<vscode.Uri> } | undefined)?.currentDocument;
  return typeof uri?.scheme === 'string' && typeof uri.fsPath === 'string' ? { scheme: uri.scheme, fsPath: uri.fsPath } : undefined;
}

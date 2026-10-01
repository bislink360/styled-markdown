import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import type { MarkdownItSmdOptions } from './core/markdownIt';
import { applySmd, hostContext, smdFeatures } from './core/markdownItSetup';
import { documentRiskMatrixHtml } from './core/riskHtml';
import { readerForUri } from './files';

/**
 * Styled Markdown syntax in VS Code's built-in Markdown preview, for .md files. VS Code calls this
 * (`markdown.markdownItPlugins` in package.json) when it builds its markdown-it instance; the settings
 * are read then, so a change applies after Developer: Reload Window. Plain Markdown is unchanged:
 * .smd rules only match text it would show literally, and other code blocks stay VS Code's.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
  if (!vscode.workspace.getConfiguration('smd.markdownPreview').get<boolean>('enabled', true)) return md;
  const options = markdownPreviewOptions();
  applySmd(md, smdFeatures(options), { ...hostContext(md, options), riskMatrix: documentRiskMatrixHtml });
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

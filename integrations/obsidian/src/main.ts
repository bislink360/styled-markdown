import {
  type App,
  type MarkdownPostProcessorContext,
  type MarkdownSectionInformation,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  finishRenderMath,
  renderMath,
  sanitizeHTMLToDom,
} from 'obsidian';
import { ObsidianEngine, type NoteContext, type NoteModel, type ObsidianEngineOptions } from '../../../extension/src/obsidianEngine';
import { type Host, fenced, hideSection, replaceInlineSyntax, showRendered } from './dom';
import { type LineRange, RenderSync, planSection } from './sections';
import { AGENT_BLOCK_CHOICES, type AgentBlocks, normalizeSettings, type SmdSettings } from './settings';

/**
 * Styled Markdown (.smd) syntax in Obsidian's reading view:
 * - `:::` containers, which span several Markdown blocks, are drawn by the section their first line is in, from that
 *   section's lines to the container's end (`getSectionInfo` gives the note's text and the section's lines); the
 *   sections inside are hidden.
 * - Inline directives and styled spans are rendered inside Obsidian's own text nodes, so links, tags and embeds
 *   around them stay Obsidian's.
 * - A ```` ```smd ```` code block renders its content as a document, in reading view and in Live Preview.
 * - `.smd` files open in the Markdown view.
 * The engine runs with raw HTML off and its output goes through Obsidian's `sanitizeHTMLToDom`.
 */
export default class StyledMarkdownPlugin extends Plugin {
  settings: SmdSettings = normalizeSettings(undefined);
  /** The engine for notes, with the containers and directives the settings turn on. */
  private engine = new ObsidianEngine(engineOptions(this.settings));
  /** The engine for ```smd blocks, which ask for .smd explicitly: all syntax on. */
  private blockEngine = new ObsidianEngine(engineOptions(this.settings, true));
  private readonly sync = new RenderSync();
  private readonly pending = new Set<string>();

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.createEngines();
    if (this.settings.smdFiles) this.registerSmdFiles();
    this.registerMarkdownCodeBlockProcessor('smd', (source, el, ctx) => this.renderBlock(source, el, ctx));
    this.registerMarkdownPostProcessor((el, ctx) => this.processSection(el, ctx));
    this.addSettingTab(new SmdSettingTab(this.app, this));
  }

  onunload(): void {
    this.sync.clear();
    this.pending.clear();
  }

  async updateSettings(change: Partial<SmdSettings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    await this.saveData(this.settings);
    this.createEngines();
    this.sync.clear();
    this.rerender();
  }

  private createEngines(): void {
    this.engine = new ObsidianEngine(engineOptions(this.settings));
    this.blockEngine = new ObsidianEngine(engineOptions(this.settings, true));
  }

  /** `.smd` files open in the Markdown view. Another plugin may have claimed the extension already. */
  private registerSmdFiles(): void {
    try {
      this.registerExtensions(['smd'], 'markdown');
    } catch (e) {
      console.warn('Styled Markdown: .smd files are already handled by another plugin.', e);
    }
  }

  private processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const info = this.settings.containers ? ctx.getSectionInfo(el) : null;
    const doc = info ? this.engine.document(info.text) : undefined;
    if (info && doc && this.drawContainers(el, ctx, info, doc)) return;
    if (!this.settings.inlineDirectives) return;
    const note = doc ?? frontMatterModel(ctx);
    replaceInlineSyntax(el, (text) => this.engine.inlineSegments(text, note), this.host(ctx));
  }

  /** Hide the section, or draw the containers that start in it; false when no container touches it. */
  private drawContainers(el: HTMLElement, ctx: MarkdownPostProcessorContext, info: MarkdownSectionInformation, doc: NoteModel): boolean {
    const plan = planSection(doc.containers, info.lineStart, info.lineEnd);
    if (plan.partOf) this.checkHidden(ctx.sourcePath, info.text, doc, plan.partOf);
    if (plan.kind === 'keep') return false;
    if (plan.kind === 'hide') {
      hideSection(el);
      return true;
    }
    this.show(el, this.engine.renderLines(doc, plan), ctx);
    for (const container of plan.owned) this.checkDrawn(ctx.sourcePath, info.text, doc, container, info.lineEnd);
    return true;
  }

  private renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    this.show(el, this.blockEngine.renderFenced(source, frontMatterModel(ctx)), ctx);
  }

  private show(el: HTMLElement, html: string, ctx: MarkdownPostProcessorContext): void {
    const { root, math } = showRendered(el, html, this.host(ctx));
    ctx.addChild(new MarkdownRenderChild(root));
    if (math) void finishRenderMath();
  }

  /** Obsidian's sanitizer, MathJax and Mermaid for one render. */
  private host(ctx: MarkdownPostProcessorContext): Host {
    return {
      toDom: (html) => sanitizeHTMLToDom(html),
      math: (tex, display) => renderMath(tex, display),
      diagram: (code, el) => {
        const child = new MarkdownRenderChild(el);
        ctx.addChild(child);
        void MarkdownRenderer.render(this.app, fenced('mermaid', code), el, ctx.sourcePath, child);
      },
    };
  }

  private checkDrawn(path: string, text: string, doc: NoteModel, container: LineRange, sectionEnd: number): void {
    if (this.sync.drawn(path, text, container, containerSource(doc, container), sectionEnd)) this.rerenderSoon(path);
  }

  private checkHidden(path: string, text: string, doc: NoteModel, container: LineRange): void {
    if (this.sync.hidden(path, text, container, containerSource(doc, container))) this.rerenderSoon(path);
  }

  /** Render the reading view of a note again, once its current render pass is over. */
  private rerenderSoon(path: string): void {
    if (this.pending.has(path)) return;
    this.pending.add(path);
    window.setTimeout(() => {
      this.pending.delete(path);
      this.rerender(path);
    }, 0);
  }

  /** Render the reading views of one note, or of every note, again. */
  private rerender(path?: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && (path === undefined || view.file?.path === path)) view.previewMode.rerender(true);
    }
  }
}

function engineOptions(settings: SmdSettings, allSyntax = false): ObsidianEngineOptions {
  return { containers: allSyntax || settings.containers, directives: allSyntax || settings.inlineDirectives, agentBlocks: settings.agentBlocks };
}

/** The note's properties as variables, when the section's text isn't available. */
function frontMatterModel(ctx: MarkdownPostProcessorContext): NoteContext {
  const data = ctx.frontmatter && typeof ctx.frontmatter === 'object' ? (ctx.frontmatter as Record<string, unknown>) : {};
  return { variables: data, lang: typeof data.lang === 'string' ? data.lang : undefined };
}

function containerSource(doc: NoteModel, container: LineRange): string {
  return doc.lines.slice(container.start, container.end + 1).join('\n');
}

class SmdSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: StyledMarkdownPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    new Setting(containerEl)
      .setName('Containers')
      .setDesc('Render ::: blocks (callouts, cards, tabs, decisions, risks…) in reading view.')
      .addToggle((toggle) => toggle.setValue(settings.containers).onChange((value) => this.plugin.updateSettings({ containers: value })));
    new Setting(containerEl)
      .setName('Inline directives')
      .setDesc('Render :badge[…], :status[…], :due[…], :progress{…} and [text]{color=…} in reading view.')
      .addToggle((toggle) =>
        toggle.setValue(settings.inlineDirectives).onChange((value) => this.plugin.updateSettings({ inlineDirectives: value })));
    new Setting(containerEl)
      .setName('Agent-only blocks')
      .setDesc(':::agent blocks are written for AI agents: show them collapsed, expanded, or not at all.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(AGENT_BLOCK_CHOICES)
          .setValue(settings.agentBlocks)
          .onChange((value) => this.plugin.updateSettings({ agentBlocks: value as AgentBlocks })));
    new Setting(containerEl)
      .setName('Open .smd files')
      .setDesc('Show .smd files in the vault and open them as notes. Takes effect after Obsidian restarts or the plugin is reloaded.')
      .addToggle((toggle) => toggle.setValue(settings.smdFiles).onChange((value) => this.plugin.updateSettings({ smdFiles: value })));
  }
}

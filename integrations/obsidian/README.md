# Styled Markdown for Obsidian

An [Obsidian](https://obsidian.md) plugin that renders [Styled Markdown](../../README.md) (`.smd`) syntax in your notes: `:::` containers (callouts, cards, tabs, columns, steps, decisions, risks, APIs, glossaries, changelogs, agent-only blocks…), inline directives (`:badge[…]`, `:status[…]`, `:due[…]`, `:progress{…}`, `:kbd[…]`, `:metric[…]`…) and `[text]{color=…}` styled spans. It uses the same engine as the VS Code extension and the `smd` CLI, bundled into the plugin, and its stylesheet follows your Obsidian theme in light and dark mode.

Plugin id: `styled-markdown`. Works on desktop and mobile; needs Obsidian 1.4 or newer.

## Install

The plugin isn't in Obsidian's community plugin list yet. Install it from a GitHub release:

1. Download `styled-markdown-obsidian-X.Y.Z.zip` from the [latest release](https://github.com/bislink360/styled-markdown/releases/latest).
2. Unzip it into your vault's `.obsidian/plugins/` folder. That gives `.obsidian/plugins/styled-markdown/` with `main.js`, `manifest.json` and `styles.css`. (`.obsidian` is a hidden folder in your vault's root.)
3. In Obsidian, open **Settings → Community plugins**, turn off Restricted mode if it is on, click the reload icon next to **Installed plugins**, and turn on **Styled Markdown**.

To update, replace the three files with the ones from a newer release and reload the plugin (turn it off and on). To uninstall, turn it off and delete the `styled-markdown` folder.

## What it renders

| Where | What |
|---|---|
| **Reading view** | `:::` containers, inline directives and styled spans in every note |
| **Reading view and Live Preview** | ```` ```smd ```` code blocks: their content is rendered as a `.smd` document |
| **`.smd` files** | shown in the file explorer and opened as notes (reading view renders them; the editor edits them as Markdown) |

A container is written as in any `.smd` document:

```markdown
:::warning Breaking change
The `/v1` endpoints go away on :due[2026-12-01].
:::

Status: :status[In review]{color=amber} :badge[Beta]{color=purple}
```

Inside containers, `[[wikilinks]]` are Obsidian links (they open and preview like any other), `$math$` and ```` ```mermaid ```` are rendered by Obsidian's own MathJax and Mermaid, and `{{name}}` shows the note's front matter (property) `name`.

## Settings

| Setting | Default | |
|---|---|---|
| Containers | on | Render `:::` blocks in reading view. Off: they show as Obsidian renders them (plain text). |
| Inline directives | on | Render `:badge[…]`, `:status[…]`, `:due[…]`, `[text]{…}`… in reading view. |
| Agent-only blocks | Collapsed | `:::agent` blocks, written for AI agents: Collapsed, Expanded or Hidden. |
| Open `.smd` files | on | Show `.smd` files in the vault and open them as notes. Takes effect when the plugin loads (reload it or restart Obsidian). |

```` ```smd ```` blocks always render every kind of syntax, whatever the first two settings say.

## How it works, and its limits

Obsidian renders Markdown itself and lets plugins change the result, so the plugin works with what its API offers:

- **Containers in reading view.** Obsidian renders a note one section (Markdown block) at a time, and a container spans several sections: its opening line is in one paragraph, its body in others, its closing `:::` in another. The plugin finds the note's containers with the engine's own parser (so `:::` inside code fences, nesting and containers inside lists are handled as everywhere else) and, for each section, uses `getSectionInfo` to see which lines it covers. The section that holds a container's first line renders the container's whole source with the engine; the sections inside it are hidden. Obsidian only re-renders sections whose text changed, so after an edit that leaves a container stale (a change in its middle, or a `:::` added or removed) the plugin renders the view once more.
- **Inline directives** are rendered inside the text nodes of Obsidian's own rendering, so links, tags, embeds and formatting around them stay Obsidian's. A directive split by formatting (`:badge[**Beta**]`, where Obsidian has already made the bold) is left as text outside containers.
- **Live Preview** shows `.smd` syntax as source, except in ```` ```smd ```` blocks, which Obsidian renders there too (code block processors run in both modes). Decorating containers and directives in the Live Preview editor would need a CodeMirror 6 extension that parses the note on every change, draws block widgets over containers and hides them where the cursor is, alongside Obsidian's own Live Preview widgets; that is a later step. Use reading view, or wrap a block in ```` ```smd ````, to see it rendered while you edit.
- **`.smd` files** open in the Markdown view (`registerExtensions(['smd'], 'markdown')`). Obsidian's index (backlinks, the graph, the outline, tag search, properties) is built from `.md` notes, so expect links, headings and tags in `.smd` files to be missing there; **new notes are still `.md`**. If another plugin already handles `.smd`, the plugin leaves it to that one.
- **Inside containers**, Markdown is rendered by the Styled Markdown engine, not by Obsidian: Obsidian callouts (`> [!note]`), embeds (`![[…]]`, shown as links), block references, `#tags`, `%%comments%%` and footnotes (`[^1]`, left as text) are not Obsidian's there, and task checkboxes inside containers can't be ticked (tick them in the editor).
- **Not available in Obsidian:** `:::include` and code embeds (```` ```js file="…" ````) — Obsidian only reads files asynchronously, the engine needs them while it renders — so they show their "not available here" note; figure numbers and `:ref[…]` count within one container; the `.smd` document header (title, status, owners) isn't drawn, as Obsidian shows the note's properties itself.

### Safety

Notes can come from anyone (shared vaults, downloads), so the plugin never puts a note's raw HTML on the page: the engine runs with raw HTML turned off, so `<script>` or `<img onerror=…>` in a note becomes text, and everything it renders also goes through Obsidian's `sanitizeHTMLToDom` before it is shown. The plugin loads no remote resources and runs no scripts from notes.

## Building from source

The plugin bundles the engine from `extension/src` and builds with the extension's toolchain:

```bash
cd extension && npm ci                 # the engine and esbuild/TypeScript
cd ../integrations/obsidian && npm ci  # the `obsidian` API typings (type-checking only)
npm run typecheck
npm run build                          # main.js and styles.css, next to manifest.json
node scripts/build.mjs --out <vault>/.obsidian/plugins/styled-markdown   # or straight into a vault
```

`styles.css` is made from the extension's `media/smd.css`: its rules are limited to rendered notes (`.markdown-rendered`) and the plugin's blocks, its colours mapped to Obsidian's theme variables, and its rules for plain Markdown elements left out so notes keep your theme's typography. `main.js` and `styles.css` are build output and not committed; the unit tests in `extension/test/obsidian*.test.ts` build the plugin and run it against a mock of the Obsidian API.

The plugin's version is the Styled Markdown release version (`manifest.json`; the release check fails otherwise). `versions.json` maps each version to the oldest Obsidian it supports, for Obsidian's community plugin list.

## Listing it in Obsidian's community plugins (maintainers)

Submitting the plugin to [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) is a manual step, not part of the release workflow. Obsidian reads a listed plugin's `manifest.json` from the root of its repository and downloads `main.js`, `manifest.json` and `styles.css` as separate assets of a GitHub release whose tag is exactly the version (`1.7.0`, no `v`). This repository keeps the plugin in `integrations/obsidian/` and tags `v1.7.0`, so listing it needs a small repository of its own (for example `bislink360/obsidian-styled-markdown`) holding `manifest.json`, `versions.json`, this README and the license, with a release per version carrying the three files from the release zip. Then open a pull request that adds the plugin to `community-plugins.json` (id `styled-markdown`) and go through Obsidian's review, which checks the plugin guidelines (no `innerHTML` with note content, no remote code, a clear description).

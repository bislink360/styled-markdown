# Styled Markdown for JetBrains IDEs

A plugin that gives `.smd` files highlighting and the Styled Markdown language server in IntelliJ IDEA, PyCharm, WebStorm, GoLand, RustRover and the other JetBrains IDEs. Install it from the GitHub release: [docs/INSTALL.md](../../docs/INSTALL.md#jetbrains-ides).

> [!WARNING]
> The plugin is new in 2.1.0. CI builds it against IntelliJ IDEA 2025.3 and runs the platform's plugin structure checks, and it builds against IntelliJ IDEA 2026.1; the language server it starts is the one tested in this repository. It has not yet been tried in every IDE it supports. If something doesn't work in your IDE, please [open an issue](https://github.com/bislink360/styled-markdown/issues) with the IDE's name and version (**Help → About**) and the log (**Help → Show Log in Explorer/Finder**).

## What it does

| Feature | How |
|---|---|
| Highlighting of the `.smd` syntax and the Markdown around it | The VS Code extension's TextMate grammar ([`extension/syntaxes`](../../extension/syntaxes)), made into one file for the IDE, with its own copy of VS Code's Markdown grammar and the IDE's YAML grammar for the front matter (see [Highlighting](#highlighting)) |
| Problems as you type, with quick fixes | The language server (`smd lsp`, [docs/EDITORS.md](../../docs/EDITORS.md#what-the-server-does)), the same checks as `smd validate` |
| Completion: block names after `:::`, attributes, front matter, inline directives, fence languages, link paths and `#anchors` | The language server |
| Hover, go to definition, the outline (**Structure**), symbol search, **Reformat Code** | The language server |
| **Live preview** beside the editor (since 2.2.0): the rendered page, updated as you type, in the IDE's light or dark theme | The language server's `smd/renderHtml` (the page `smd export --to html` writes, from the editor's current text) in the IDE's embedded browser (JCEF) |
| **Open Styled Markdown Preview in Browser** (editor right-click menu, or **Tools**) | `smd export --to html` into a temporary folder, then the default browser |

The language server is the `smd` CLI's, shipped in the plugin as one file (`server/smd.cjs`, the same file as the agent skills' bundle), and runs on Node.js. Everything the server does is the same as in Neovim, Helix or Zed: see [docs/EDITORS.md](../../docs/EDITORS.md).

### The preview

A `.smd` file opens as a split editor, like Markdown files: the text on the left, the preview on the right. The buttons at the top right of the editor show only the text, both, or only the preview. The preview renders again about 300 ms after you stop typing, keeps its scroll position, and follows the IDE's light or dark theme unless the front matter sets `theme:`. Relative images and code embeds resolve from the document's folder; links open in the system browser. Diagrams (Mermaid) and math styles load from a CDN, as in an exported page, so they need a network connection.

The preview needs the IDE's embedded browser (JCEF), which every desktop IDE has unless it was turned off; without it the pane says so, and **Open Preview in Browser** still works. It needs the language server running, so Node.js too. It doesn't scroll with the editor, and clicking in it doesn't move the cursor.

Not in the plugin: the agent view, the tasks view and the Block Editor. Those are in the VS Code extension.

## Requirements

- A JetBrains IDE with the **LSP API**: IntelliJ IDEA 2025.3 or newer (the unified IDE, with or without a subscription), or PyCharm, WebStorm, PhpStorm, GoLand, RubyMine, CLion, RustRover, DataGrip, Rider 2025.1 or newer. Not Android Studio, and not builds of IntelliJ IDEA from its open-source code ([JetBrains: LSP](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html)).
- **Node.js 22 or newer** for the language server and the preview. Highlighting works without it.

## Settings

**Settings → Languages & Frameworks → Styled Markdown**:

| Setting | Empty means |
|---|---|
| Node.js executable | `node` on the `PATH` |
| smd CLI script | The CLI shipped with the plugin. To also get Mermaid syntax errors (the npm package includes Mermaid's parser; the single-file CLI doesn't), install the npm package and point this at its `dist/cli.js` |

The server restarts when you apply a change. The IDE's language server widget in the status bar shows whether it runs, and its log.

## Highlighting

The extension highlights `.smd` with two TextMate grammars: [`smd.tmLanguage.json`](../../extension/syntaxes/smd.tmLanguage.json) (front matter, then Markdown) and [`smd-directives.injection.json`](../../extension/syntaxes/smd-directives.injection.json) (containers, directives, spans, marks and math), which VS Code layers over it with `injectTo`. The IDE's TextMate support reads a VS Code grammar's `embeddedLanguages` but not `injectTo`, and its own Markdown bundle may be turned off. So the plugin ships:

- `bundle/syntaxes/smd.tmLanguage.json`: the extension's grammar with the injection grammar's rules as its own `injections`. [`scripts/bundle-grammar.mjs`](scripts/bundle-grammar.mjs) writes it, and a unit test fails when it is out of date (run `node integrations/jetbrains/scripts/bundle-grammar.mjs` after changing either extension grammar).
- `bundle/syntaxes/markdown.tmLanguage.json`: VS Code's Markdown grammar ([microsoft/vscode-markdown-tm-grammar](https://github.com/microsoft/vscode-markdown-tm-grammar), MIT, [notice](bundle/syntaxes/markdown.LICENSE.txt)) under its own scope, `text.html.markdown.smd`.

Code in fenced blocks is highlighted by the IDE's TextMate grammar for its language, when the IDE has one turned on.

## Build

The plugin is a Gradle project (Kotlin, [IntelliJ Platform Gradle Plugin](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html)). It needs a JDK 21 or newer. Its version is always the VS Code extension's (`extension/package.json`).

```sh
cd integrations/jetbrains
./gradlew buildPlugin            # downloads IntelliJ IDEA (gradle.properties: platformVersion) to compile against
./gradlew buildPlugin -PlocalIde="/path/to/an/installed/IDE"   # or compile against an installed IDE
```

The plugin zip is in `build/distributions/styled-markdown-jetbrains-X.Y.Z.zip`. `./gradlew runIde` opens an IDE with the plugin installed, for trying it. The build copies the language server (`skills/styled-markdown-reader/scripts/smd.cjs`) and the TextMate grammar (`extension/syntaxes`, `extension/language-configuration.json`) into the plugin; `bundle/package.json` lists them for the IDE's TextMate support, and a unit test ([`extension/test/jetbrains.test.ts`](../../extension/test/jetbrains.test.ts)) fails when it no longer matches the extension's `package.json`.

The plugin uses the LSP API's names from before IntelliJ 2026.1.4 (`LspServerSupportProvider`, `ProjectWideLspServerDescriptor`), which every IDE from 2025.1 on has; newer IDEs keep them as deprecated aliases.

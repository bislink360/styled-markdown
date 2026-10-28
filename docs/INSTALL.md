# Installation guide

This guide covers the **VS Code extension**, the **`smd` command-line tool**, the **MkDocs plugin**, the **Obsidian plugin**, the **JetBrains plugin**, and building from source. The agent skills have their own guide: [SKILLS.md](SKILLS.md).

## Contents

- [Requirements](#requirements)
- [Install the VS Code extension](#install-the-vs-code-extension)
- [Verify the installation](#verify-the-installation)
- [Recommended settings](#recommended-settings)
- [Install the `smd` CLI](#install-the-smd-cli)
- [Use `smd` in CI](#use-smd-in-ci)
- [Pre-commit hooks](#pre-commit-hooks)
- [MkDocs plugin](#mkdocs-plugin)
- [Web playground](#web-playground)
- [Obsidian plugin](#obsidian-plugin)
- [JetBrains IDEs](#jetbrains-ides)
- [Update or uninstall](#update-or-uninstall)
- [Upgrading to 2.0](#upgrading-to-20)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)

## Requirements

| Component | Needs |
|---|---|
| VS Code extension | VS Code **1.97 or newer**, or a VS Code-compatible editor that installs `.vsix` files (Cursor, VSCodium, Windsurf) |
| CLI and agent skills | **Node.js 22 or newer** |
| MkDocs plugin | Python 3.9+, MkDocs 1.6+ and **Node.js 22 or newer** on `PATH` |
| Obsidian plugin | Obsidian **1.4 or newer**, desktop or mobile |
| JetBrains plugin | A JetBrains IDE with the LSP API: IntelliJ IDEA **2025.3 or newer** (any edition of the unified IDE), or PyCharm, WebStorm, GoLand, RustRover and the others **2025.1 or newer**; not Android Studio. **Node.js 22 or newer** for the language server |
| Building from source | Node.js 22+, npm, Git |
| Word export | Nothing (built in). Optionally [Pandoc](https://pandoc.org/installing.html) **3.0 or newer**, for Word equations in `smd export --to docx` and **Export to Word (.docx)** |
| PDF export | Google Chrome, Microsoft Edge (comes with Windows), Chromium or Brave, for `smd export --to pdf` and **Export to PDF** in VS Code and JetBrains IDEs; or Playwright or Puppeteer |

## Install the VS Code extension

> **Visual Studio Marketplace and Open VSX:** coming once published. [Open VSX](https://open-vsx.org) is the extension registry of VSCodium, Cursor, Windsurf and Gitpod. Until the listings are live, install the `.vsix` from the GitHub release (Option A).

### Option A — from the release file (recommended)

1. Open the [latest release](https://github.com/bislink360/styled-markdown/releases/latest) and download **`styled-markdown-2.2.0.vsix`**.
2. Install it with **one** of these methods.

   **From the terminal:**

   ```bash
   code --install-extension styled-markdown-2.2.0.vsix
   ```

   **From VS Code:**
   1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   2. Click the **⋯** menu at the top of the view.
   3. Choose **Install from VSIX…** and select the downloaded file.

   **Drag and drop:** drag the `.vsix` file onto the Extensions view.
3. If VS Code was already open, run **Developer: Reload Window** from the Command Palette.

> Cursor, VSCodium and Windsurf use the same steps (`cursor --install-extension …`, `codium --install-extension …`). Once the Open VSX listing is live, they can also install **Styled Markdown** from their Extensions view.

### Option B — build and install from source

```bash
git clone https://github.com/bislink360/styled-markdown.git
cd styled-markdown/extension
npm install
npm run package
code --install-extension styled-markdown-2.2.0.vsix
```

## Verify the installation

1. Open [`examples/showcase.smd`](../examples/showcase.smd) (or create any file ending in `.smd`).
2. The language mode in the status bar shows **Styled Markdown**, and the file has the Styled Markdown icon in the Explorer.
3. Press **`Ctrl+K V`** (`Cmd+K V` on macOS). A live preview opens beside the editor with callouts, diagrams and math rendered.
4. Type `:::warnign` on a new line. A squiggle appears; press `Ctrl+.` and choose **Change to ":::warning"**.
5. Click the **🤖** button in the editor title bar. The agent view opens, showing what an AI agent reads. The status bar shows the estimated token count.

## Recommended settings

Open **Settings** and search for `smd`:

| Setting | Default | Description |
|---|---|---|
| `smd.preview.theme` | `auto` | `auto` follows VS Code; `light` or `dark` forces a theme |
| `smd.preview.showAgentBlocks` | `collapsed` | How `:::agent` blocks appear in the preview: `collapsed`, `expanded` or `hidden` |
| `smd.preview.allowHtml` | `true` | Render raw HTML in documents (scripts never run) |
| `smd.markdownPreview.enabled` | `opt-in` | Which `.md` files get `.smd` syntax in VS Code's built-in Markdown preview: `opt-in` (those with an `smd:` front matter key), `always` or `never` |
| `smd.validation.enabled` | `true` | Show problems as you type |
| `smd.validation.checkLinks` | `true` | Warn about relative links, images and `related:` entries that point to missing files or headings |

Keyboard shortcuts:

| Action | Windows / Linux | macOS |
|---|---|---|
| Preview to the side | `Ctrl+K V` | `Cmd+K V` |
| Preview in the current tab | `Ctrl+Shift+V` | `Cmd+Shift+V` |
| Quick fix | `Ctrl+.` | `Cmd+.` |
| Trigger suggestions | `Ctrl+Space` | `Ctrl+Space` |

All commands are in the Command Palette under **Styled Markdown:**. They cover opening the preview, opening the Block Editor (and **Reopen in Text Editor**), showing the (brief) agent view, copying the agent view or selected sections, exporting to HTML, Markdown, Confluence (storage format), Notion (JSON) or Word (.docx), converting a Markdown file to `.smd`, validating the whole workspace, **Migrate to Spec v2** and **Preview Migration to Spec v2**, **Set Document Status…**, setting up spell checking, and grouping, showing or hiding tasks in the SMD Tasks view.

## Install the `smd` CLI

The CLI is a **single self-contained file** with no dependencies. Pick one method.

**From the release's npm package (recommended):** npm installs straight from the tarball attached to the release. The npm registry listing is coming soon.

```bash
npm install -g https://github.com/bislink360/styled-markdown/releases/download/v2.2.0/styled-markdown-2.2.0.tgz
smd --version       # smd 2.2.0 (Styled Markdown spec v2)
```

The same package is also a library (`npm install https://github.com/bislink360/styled-markdown/releases/download/v2.2.0/styled-markdown-2.2.0.tgz`); see [npm/README.md](../npm/README.md).

**Use the copy bundled with the skills (no build needed):**

```bash
git clone https://github.com/bislink360/styled-markdown.git
node styled-markdown/skills/styled-markdown-reader/scripts/smd.cjs --version
```

**Put `smd` on your PATH:**

```bash
cd styled-markdown/extension
npm install && npm run build
npm link            # now `smd` works everywhere
smd --version       # smd 2.2.0 (Styled Markdown spec v2)
```

**Without linking:** `node extension/dist/cli.js <command>`.

**First document:** `smd init docs/plan.smd --template prd` writes a new document from a template (`smd templates` lists the 13). New documents, from `smd init`, `smd from-md` and the other writers, say `smd: 2` since 2.0; existing documents keep their rules until you run `smd migrate <files> --to 2` (SPEC.md §10.1).

### Optional: Pandoc for Word export

`smd export --to docx` and **Export to Word (.docx)** in VS Code and the JetBrains plugin write Word documents with nothing to install (since 2.4.0). When [Pandoc](https://pandoc.org/installing.html) is installed they hand the document to it instead, which gives Word's own equations and highlighted code. smd does not bundle Pandoc (the CLI and the npm package keep zero dependencies); install Pandoc 3.0 or newer if you want those:

```bash
winget install JohnMacFarlane.Pandoc   # Windows (or the installer or zip from pandoc.org)
brew install pandoc                    # macOS
sudo apt install pandoc                # Debian/Ubuntu (check pandoc --version: 3.0 or newer)
pandoc --version
```

smd finds Pandoc at `--pandoc <path>`, then the `SMD_PANDOC` environment variable, then on the `PATH`; the extension reads the `smd.export.pandocPath` setting first (a user setting, so a workspace can't point it at another program). Without Pandoc, the built-in writer is used; `--engine builtin|pandoc` (VS Code: `smd.export.docxEngine`; JetBrains: **Export to Word → Engine**) picks one, and `--engine pandoc` without Pandoc exits with code 2 and says how to install it (the extension offers an **Install Pandoc** button). `smd export <file.smd> --to docx --html-only -o page.html` writes the HTML smd would give Pandoc, to convert yourself: `pandoc page.html -f html -t docx -o page.docx`.


## Use `smd` in CI

### GitHub Actions

The `validate` action in this repository checks your `.smd` files, shows each problem as an inline annotation on the pull request's changed lines and writes a job summary (counts and the first 50 problems, linked to the file and line):

```yaml
# .github/workflows/docs.yml
name: docs
on: [pull_request]
jobs:
  smd:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bislink360/styled-markdown/validate@v2.2.0
        with:
          paths: |
            docs
            specs/product plan.smd
          fail-on: warning
```

It runs the `smd` CLI bundled in the repository with the runner's Node.js (22 or later since 2.0; add `actions/setup-node` with `node-version: 22` before it when the runner's is older). Nothing is installed or downloaded.

| Input | Default | Meaning |
|---|---|---|
| `paths` | `.` | Files or folders to check, one per line (spaces are fine), relative to the repository root |
| `fail-on` | `error` | Fail the step on `error`s, on `warning`s too (like `--strict`), or `never` (report only) |
| `strict` | `false` | `true` is the same as `fail-on: warning` |
| `config` | | A rule config file for every document (default: the nearest `smd.config.json` / `.smdrc`) |
| `mermaid` | `true` | `false` skips Mermaid syntax checks |
| `stale-after` | | Days before a document's `updated` date counts as stale (`0`: off; default 180) |
| `summary` | `true` | Write the job summary |
| `cli` | | Run another `smd` CLI, e.g. `node_modules/styled-markdown/dist/cli.js` |

Errors become `::error`, warnings `::warning` and info diagnostics `::notice` annotations; hints are left out. The bundled CLI has no Mermaid parser, so diagram syntax is only checked when `cli` points at the npm package's CLI (installed with `npm ci` in an earlier step).

### Any CI

```bash
curl -sSLo smd.cjs https://raw.githubusercontent.com/bislink360/styled-markdown/v2.2.0/skills/styled-markdown-reader/scripts/smd.cjs
node smd.cjs validate docs/ --strict
```

`validate` exits with code **1** on errors (and on warnings with `--strict`). Use `--json` for machine-readable output, or `--format github` for GitHub workflow commands; `--summary <file>` also appends a Markdown summary to a file (e.g. `"$GITHUB_STEP_SUMMARY"`).

Once your documents are on spec v2, `node smd.cjs migrate docs/ --to 2 --check` keeps them there: it writes nothing, lists each document that still needs migrating (a new one written with `smd: 1`, say) and then exits with code **1**.

## Pre-commit hooks

Check `.smd` files before they are committed. `smd validate` and `smd fmt` take any number of files, so a hook passes them only the staged ones. Pick the setup your project already uses.

### With the pre-commit framework

[pre-commit](https://pre-commit.com) works in any repository, whatever its language. Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/bislink360/styled-markdown
    rev: v2.2.0
    hooks:
      - id: smd-fmt
      - id: smd-validate
        args: [--strict]   # optional: fail on warnings too
```

Then run `pre-commit install` once. The hooks (from v1.5.0):

| Hook id | Runs | Fails the commit when |
|---|---|---|
| `smd-validate` | `smd validate <staged .smd files>` | a file has errors (or warnings, with `args: [--strict]`) |
| `smd-fmt` | `smd fmt <staged .smd files>` | it reformatted a file. pre-commit lists the changed files: review them, `git add` and commit again |
| `smd-fmt-check` | `smd fmt --check <staged .smd files>` | a file is not formatted (nothing is changed; for CI or if you'd rather format yourself) |

Other `args` are passed to the command, e.g. `[--config, docs/smd.config.json]` or `[--stale-after, '0']` for `smd-validate`.

The hooks use `language: node`: pre-commit installs this repository's root `package.json`, whose only file is the bundled single-file CLI (`skills/styled-markdown-reader/scripts/smd.cjs`), so there are no dependencies and nothing comes from the npm registry. On macOS and Linux pre-commit uses the `node` (22 or newer) and `npm` on your PATH; without them, and always on Windows, it downloads a private Node.js once. The single-file CLI doesn't include the Mermaid parser, so the hooks don't report `mermaid/syntax`; run `smd validate` from the npm package in CI for that.

### With lint-staged and husky

For JavaScript projects. The `styled-markdown` package isn't on the npm registry yet, so install it from the release's `.tgz`, which also gives you the Mermaid parser:

```bash
npm install --save-dev https://github.com/bislink360/styled-markdown/releases/download/v2.2.0/styled-markdown-2.2.0.tgz
npm install --save-dev lint-staged husky
npx husky init
echo "npx lint-staged" > .husky/pre-commit
```

and in `package.json`:

```json
{
  "lint-staged": {
    "*.smd": ["smd fmt", "smd validate"]
  }
}
```

lint-staged appends the staged files to each command, runs them in order and stages the formatting changes. Add `--strict` to `smd validate` to fail on warnings. To use the single-file CLI instead of the package, download it into the repository (`curl -sSLo tools/smd.cjs https://raw.githubusercontent.com/bislink360/styled-markdown/v2.2.0/skills/styled-markdown-reader/scripts/smd.cjs`) and use `"node tools/smd.cjs fmt"` and `"node tools/smd.cjs validate"`.

### With a plain Git hook

Without either tool, save this as `.git/hooks/pre-commit` and make it executable (`chmod +x .git/hooks/pre-commit`). It needs `smd` on your PATH; otherwise replace `smd` with `node path/to/smd.cjs`. Git for Windows runs it too.

```sh
#!/bin/sh
# Check the staged .smd files: formatting first, then validation.
staged() { git diff --cached --name-only -z --diff-filter=ACMR -- '*.smd'; }
git diff --cached --quiet --diff-filter=ACMR -- '*.smd' && exit 0   # no .smd files staged
staged | xargs -0 smd fmt --check -- || { echo "Run: smd fmt <files>, then git add them."; exit 1; }
staged | xargs -0 smd validate --
```

It checks the files as they are in the working tree and doesn't change them; `--` keeps a file name that starts with `-` from being read as an option. The hook lives only in your clone: to share it, commit it (e.g. as `.githooks/pre-commit`) and run `git config core.hooksPath .githooks`.

## MkDocs plugin

`mkdocs-styled-markdown` makes the `.smd` files in an [MkDocs](https://www.mkdocs.org) site's `docs_dir` pages, rendered by the same engine as `smd export --to html`, inside the site's theme. It is a Python package that ships the engine as a Node.js script, so the machine that builds the site needs Node.js 22+ on `PATH` (no npm install).

Until it is on PyPI, install the wheel from the GitHub release (each release attaches `mkdocs_styled_markdown-X.Y.Z-py3-none-any.whl` and the `.tar.gz` source):

```bash
pip install https://github.com/bislink360/styled-markdown/releases/download/v2.2.0/mkdocs_styled_markdown-2.2.0-py3-none-any.whl
```

Then add it to `mkdocs.yml`:

```yaml
plugins:
  - search
  - styled-markdown:
      validate: true      # smd errors become MkDocs warnings (mkdocs build --strict fails on them)
      md_syntax: false    # true: .md pages may use .smd syntax too
```

Options, links, the table of contents, dark mode and includes: [plugin README](../integrations/mkdocs/README.md).

## Web playground

The playground needs no installation: it is a static page that runs the engine in the browser (see [FEATURES.md §19](FEATURES.md#19-web-playground)).

- **From a release:** download `styled-markdown-playground.zip`, unzip it and open `index.html` in a browser.
- **From source:** `cd extension && npm ci && npm run build:playground`, then open `extension/dist/playground/index.html`.

It works from `file://` and from any static web server. It needs a current browser (Chrome or Edge 103+, Firefox 113+, Safari 16.4+) for the compressed share links. It is not hosted anywhere yet; publishing it (for example on GitHub Pages) is a separate maintainer decision.

## Obsidian plugin

The Styled Markdown plugin for [Obsidian](https://obsidian.md) renders `.smd` syntax in your notes' reading view: `:::` containers, inline directives such as `:badge[…]` and `:status[…]`, and `[text]{color=…}` spans, styled to follow your theme in light and dark mode. ```` ```smd ```` code blocks render in Live Preview too, and `.smd` files open as notes. The engine is bundled into the plugin, so nothing else needs installing.

Until it is in Obsidian's community plugin list, install it from the GitHub release:

1. Download `styled-markdown-obsidian-X.Y.Z.zip` from the [latest release](https://github.com/bislink360/styled-markdown/releases/latest).
2. Unzip it into your vault's `.obsidian/plugins/` folder, which gives `.obsidian/plugins/styled-markdown/` with `main.js`, `manifest.json` and `styles.css`.
3. In Obsidian, **Settings → Community plugins**: turn off Restricted mode if it is on, reload the list of installed plugins and turn on **Styled Markdown**.

To update, replace the three files and reload the plugin. Settings, what renders where, and the limitations (Live Preview, wikilinks and embeds inside containers, `.smd` files and Obsidian's index): [plugin README](../integrations/obsidian/README.md).

## JetBrains IDEs

The Styled Markdown plugin for JetBrains IDEs highlights `.smd` files with the VS Code extension's grammar and runs the Styled Markdown language server, which ships with the plugin: problems as you type with quick fixes, completion, hover, go to definition, the outline, workspace symbols and formatting. Since 2.2.0 `.smd` files open with a live preview beside the editor; **Open Styled Markdown Preview in Browser** (editor right-click menu, or **Tools**) shows the page in your browser.

Until it is on the JetBrains Marketplace, install it from the GitHub release:

1. Download `styled-markdown-jetbrains-X.Y.Z.zip` from the [latest release](https://github.com/bislink360/styled-markdown/releases/latest). Don't unzip it.
2. In the IDE, **Settings → Plugins → ⚙ → Install Plugin from Disk…**, choose the zip, and restart the IDE when asked.
3. Open a `.smd` file. The language server needs **Node.js 22 or newer**: `node` on the `PATH`, or its path in **Settings → Languages & Frameworks → Styled Markdown**. Without Node.js, highlighting still works, and the IDE says what is missing.

To update, install the new zip the same way. Settings, what the plugin does and doesn't do, and building it: [plugin README](../integrations/jetbrains/README.md).

## Update or uninstall

- **Update:** install the newer `.vsix` the same way. VS Code replaces the old version (add `--force` on the command line to reinstall the same version).
- **Uninstall:** Extensions view → Styled Markdown → **Uninstall**, or `code --uninstall-extension bislink360.styled-markdown`.
- **Check the installed version:** `code --list-extensions --show-versions | grep styled`.

## Upgrading to 2.0

2.0 brings spec v2. Your documents keep working; this is what changes when you update from 1.x. Every change, with its migration, is in the [CHANGELOG](../extension/CHANGELOG.md).

- **Platform:** Node.js 22 or newer for the CLI, the npm package, the GitHub Action, the pre-commit hooks and the MkDocs plugin, and VS Code 1.97 or newer (or Cursor, VSCodium, Windsurf based on it) for the extension. Older editors keep the 1.x extension.
- **Your documents keep their meaning.** A document without `smd: 2`, and every `.md` file, is read with the spec v1 rules, as in 1.x.
- **Stricter checks, in every document.** Duplicate attributes (`[x]{color=red color=blue}`), a container titled both by `title=` and by text (`:::note{title="A"} B`), a Mermaid syntax error and an invalid figure `kind` are now errors, so `smd validate` fails on them. Front matter that can't be read is shown in a red "Front matter could not be read" block instead of hiding the text above it. `smd validate --fix` repairs the duplicates, the title conflicts and a misspelt `kind`; fix a Mermaid error, and front matter that can't be read (often a missing closing `---`), by hand.
- **VS Code's `.md` preview is opt-in.** VS Code's built-in Markdown preview shows `.smd` syntax only in `.md` files whose front matter has an `smd:` key (`smd: 1` keeps the v1 rules). Set `smd.markdownPreview.enabled` to `always` for the 1.x behaviour, or `never`. `.smd` files and the Styled Markdown preview are unaffected.
- **New documents are `smd: 2`:** `smd init`, `smd from-md`, **Convert Markdown File to .smd** and the other writers write it. Spec v2 differs from v1 in:
  - text shown as written: straight quotes, `--`, `...` and `(c)` stay as typed unless the front matter says `typography: true`;
  - links: only GFM autolinks (`https://…`, `www.…`, e-mail addresses); a bare `example.com` is text;
  - `$$` display math opens and closes only on a line of its own (or `$$ x $$` on one line);
  - a closing fence closes the container opened with as many colons (`::::` closes `::::tabs`);
  - a heading's trailing `{}` or `{word}` is heading text (`## Returns {ok}`);
  - `\\` in a quoted attribute value is one backslash;
  - any `:name[…]` is a directive, its name in any case; write `\:name[…]` to keep the text;
  - `:::include` `section=` matches a heading's id or its whole text, not a part of it;
  - front matter values keep their YAML spelling (`version: 2.10` shows `2.10`).

  The rules, side by side with v1: [SPEC.md §10](SPEC.md#10-versioning).
- **Moving a document to spec v2:** `smd migrate docs --to 2 --dry-run` shows the plan, then `smd migrate docs --to 2` writes it (only `.smd` files, each checked after writing); in VS Code, **Migrate to Spec v2** (or **Preview Migration to Spec v2**). `--keep-typography` keeps curly quotes and dashes, and `--link-domains` keeps bare domains linked. In CI, `smd migrate docs --to 2 --check` fails while a document still needs migrating. The steps: [SPEC.md §10.1](SPEC.md#101-migrating-to-spec-v2).
- **Command names:** `smd export <file> --to html|md|pdf|docx|confluence|notion` replaces `smd render`, `smd to-md`, `smd pdf` and `smd docx`, which still work with the same options and output.
- **npm package:** `inlineText(line, options)` takes its options as one object; the vocabulary tables (`CONTAINERS`, `NAMED_COLORS`, …) are read-only, so copy one to extend it; and the markdown-it plugin's `preset: 'smd'` renders as `renderSmd` does. See [npm/README.md](../npm/README.md).

## Build from source

```bash
cd extension
npm install
npm run build          # esbuild bundles dist/extension.js and dist/cli.js, copies Mermaid/KaTeX into media/vendor,
                       # and refreshes skills/*/scripts/smd.cjs and the MkDocs plugin's bridge.cjs
npm test               # unit tests
npm run test:vscode    # integration tests in a real VS Code (uses your installed VS Code, isolated profile)
npm run package        # styled-markdown-2.2.0.vsix
```

Press **F5** with the `extension/` folder open to start an Extension Development Host with the examples loaded.

The Obsidian plugin builds with the same toolchain: after `npm install` in `extension/`, run `npm ci`, `npm run typecheck` and `npm run build` in `integrations/obsidian/` (see its [README](../integrations/obsidian/README.md#building-from-source)).

## Troubleshooting

| Problem | Fix |
|---|---|
| `.smd` opens as plain text | Reload the window. Check that the language mode (bottom right) is *Styled Markdown*; if not, click it and choose **Configure File Association for '.smd'** → Styled Markdown. |
| Preview shows diagram source instead of a diagram | The diagram has a syntax error, shown under the diagram, or its type isn't a Mermaid type (the Problems panel reports this). |
| Exported HTML has no diagrams or math offline | The HTML export loads Mermaid and KaTeX from a CDN, so open it with internet access. The in-editor preview works offline. |
| Embedded code shows "Cannot read …" | The path is relative to the `.smd` file and must stay inside the workspace (or the document's folder). |
| `code` command not found | In VS Code, run **Shell Command: Install 'code' command in PATH** (macOS), or reinstall VS Code with *Add to PATH* (Windows). |
| `smd` prints `node: not found` | Install Node.js 22+ from [nodejs.org](https://nodejs.org). |

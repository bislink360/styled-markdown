# Installation guide

This guide covers the **VS Code extension**, the **`smd` command-line tool**, and building from source. The agent skills have their own guide: [SKILLS.md](SKILLS.md).

## Contents

- [Requirements](#requirements)
- [Install the VS Code extension](#install-the-vs-code-extension)
- [Verify the installation](#verify-the-installation)
- [Recommended settings](#recommended-settings)
- [Install the `smd` CLI](#install-the-smd-cli)
- [Use `smd` in CI](#use-smd-in-ci)
- [Update or uninstall](#update-or-uninstall)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)

## Requirements

| Component | Needs |
|---|---|
| VS Code extension | VS Code **1.90 or newer**, or a VS Code-compatible editor that installs `.vsix` files (Cursor, VSCodium, Windsurf) |
| CLI and agent skills | **Node.js 18 or newer** |
| Building from source | Node.js 18+, npm, Git |

## Install the VS Code extension

> **Visual Studio Marketplace:** coming soon. Until the listing is live, install the `.vsix` from the GitHub release (Option A).

### Option A — from the release file (recommended)

1. Open the [latest release](https://github.com/bislink360/styled-markdown/releases/latest) and download **`styled-markdown-1.1.0.vsix`**.
2. Install it with **one** of these methods.

   **From the terminal:**

   ```bash
   code --install-extension styled-markdown-1.1.0.vsix
   ```

   **From VS Code:**
   1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   2. Click the **⋯** menu at the top of the view.
   3. Choose **Install from VSIX…** and select the downloaded file.

   **Drag and drop:** drag the `.vsix` file onto the Extensions view.
3. If VS Code was already open, run **Developer: Reload Window** from the Command Palette.

> Cursor, VSCodium and Windsurf use the same steps (`cursor --install-extension …`, `codium --install-extension …`).

### Option B — build and install from source

```bash
git clone https://github.com/bislink360/styled-markdown.git
cd styled-markdown/extension
npm install
npm run package
code --install-extension styled-markdown-1.1.0.vsix
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
| `smd.validation.enabled` | `true` | Show problems as you type |
| `smd.validation.checkLinks` | `true` | Warn about relative links, images and `related:` entries that point to missing files or headings |

Keyboard shortcuts:

| Action | Windows / Linux | macOS |
|---|---|---|
| Preview to the side | `Ctrl+K V` | `Cmd+K V` |
| Preview in the current tab | `Ctrl+Shift+V` | `Cmd+Shift+V` |
| Quick fix | `Ctrl+.` | `Cmd+.` |
| Trigger suggestions | `Ctrl+Space` | `Ctrl+Space` |

All commands are in the Command Palette under **Styled Markdown:**. They cover opening the preview, showing the (brief) agent view, copying the agent view or selected sections, exporting to HTML or Markdown, converting a Markdown file to `.smd`, and validating the whole workspace.

## Install the `smd` CLI

The CLI is a **single self-contained file** with no dependencies. Pick one method.

**From the release's npm package (recommended):** npm installs straight from the tarball attached to the release. The npm registry listing is coming soon.

```bash
npm install -g https://github.com/bislink360/styled-markdown/releases/download/v1.1.0/styled-markdown-1.1.0.tgz
smd --version       # smd 1.1.0 (Styled Markdown spec v1)
```

The same package is also a library (`npm install https://github.com/bislink360/styled-markdown/releases/download/v1.1.0/styled-markdown-1.1.0.tgz`); see [npm/README.md](../npm/README.md).

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
smd --version       # smd 1.1.0 (Styled Markdown spec v1)
```

**Without linking:** `node extension/dist/cli.js <command>`.


## Use `smd` in CI

```yaml
# .github/workflows/docs.yml
name: docs
on: [pull_request]
jobs:
  smd:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: curl -sSLo smd.cjs https://raw.githubusercontent.com/bislink360/styled-markdown/v1.1.0/skills/styled-markdown-reader/scripts/smd.cjs
      - run: node smd.cjs validate docs/ --strict
```

`validate` exits with code **1** on errors (and on warnings with `--strict`). Use `--json` for machine-readable output.

## Update or uninstall

- **Update:** install the newer `.vsix` the same way. VS Code replaces the old version (add `--force` on the command line to reinstall the same version).
- **Uninstall:** Extensions view → Styled Markdown → **Uninstall**, or `code --uninstall-extension bislink360.styled-markdown`.
- **Check the installed version:** `code --list-extensions --show-versions | grep styled`.

## Build from source

```bash
cd extension
npm install
npm run build          # esbuild bundles dist/extension.js and dist/cli.js, copies Mermaid/KaTeX into media/vendor,
                       # and refreshes skills/*/scripts/smd.cjs
npm test               # unit tests
npm run test:vscode    # integration tests in a real VS Code (uses your installed VS Code, isolated profile)
npm run package        # styled-markdown-1.1.0.vsix
```

Press **F5** with the `extension/` folder open to start an Extension Development Host with the examples loaded.

## Troubleshooting

| Problem | Fix |
|---|---|
| `.smd` opens as plain text | Reload the window. Check that the language mode (bottom right) is *Styled Markdown*; if not, click it and choose **Configure File Association for '.smd'** → Styled Markdown. |
| Preview shows diagram source instead of a diagram | The diagram has a syntax error, shown under the diagram, or its type isn't a Mermaid type (the Problems panel reports this). |
| Exported HTML has no diagrams or math offline | The HTML export loads Mermaid and KaTeX from a CDN, so open it with internet access. The in-editor preview works offline. |
| Embedded code shows "Cannot read …" | The path is relative to the `.smd` file and must stay inside the workspace (or the document's folder). |
| `code` command not found | In VS Code, run **Shell Command: Install 'code' command in PATH** (macOS), or reinstall VS Code with *Add to PATH* (Windows). |
| `smd` prints `node: not found` | Install Node.js 18+ from [nodejs.org](https://nodejs.org). |

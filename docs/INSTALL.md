# Installation guide

This guide covers the **VS Code extension**, the **`smd` command-line tool**, and building from source. The agent skills have their own guide: [SKILLS.md](SKILLS.md).

## Contents

- [Requirements](#requirements)
- [Install the VS Code extension](#install-the-vs-code-extension)
- [Verify the installation](#verify-the-installation)
- [Recommended settings](#recommended-settings)
- [Install the `smd` CLI](#install-the-smd-cli)
- [Use `smd` in CI](#use-smd-in-ci)
- [Pre-commit hooks](#pre-commit-hooks)
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

> **Visual Studio Marketplace and Open VSX:** coming once published. [Open VSX](https://open-vsx.org) is the extension registry of VSCodium, Cursor, Windsurf and Gitpod. Until the listings are live, install the `.vsix` from the GitHub release (Option A).

### Option A — from the release file (recommended)

1. Open the [latest release](https://github.com/bislink360/styled-markdown/releases/latest) and download **`styled-markdown-1.5.0.vsix`**.
2. Install it with **one** of these methods.

   **From the terminal:**

   ```bash
   code --install-extension styled-markdown-1.5.0.vsix
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
code --install-extension styled-markdown-1.5.0.vsix
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
npm install -g https://github.com/bislink360/styled-markdown/releases/download/v1.5.0/styled-markdown-1.5.0.tgz
smd --version       # smd 1.5.0 (Styled Markdown spec v1)
```

The same package is also a library (`npm install https://github.com/bislink360/styled-markdown/releases/download/v1.5.0/styled-markdown-1.5.0.tgz`); see [npm/README.md](../npm/README.md).

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
smd --version       # smd 1.5.0 (Styled Markdown spec v1)
```

**Without linking:** `node extension/dist/cli.js <command>`.


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
      - uses: bislink360/styled-markdown/validate@v1.5.0
        with:
          paths: |
            docs
            specs/product plan.smd
          fail-on: warning
```

It runs the `smd` CLI bundled in the repository with the runner's Node.js (18 or later; GitHub-hosted Ubuntu, Windows and macOS runners have it, otherwise add `actions/setup-node` first). Nothing is installed or downloaded.

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
curl -sSLo smd.cjs https://raw.githubusercontent.com/bislink360/styled-markdown/v1.5.0/skills/styled-markdown-reader/scripts/smd.cjs
node smd.cjs validate docs/ --strict
```

`validate` exits with code **1** on errors (and on warnings with `--strict`). Use `--json` for machine-readable output, or `--format github` for GitHub workflow commands; `--summary <file>` also appends a Markdown summary to a file (e.g. `"$GITHUB_STEP_SUMMARY"`).

## Pre-commit hooks

Check `.smd` files before they are committed. `smd validate` and `smd fmt` take any number of files, so a hook passes them only the staged ones. Pick the setup your project already uses.

### With the pre-commit framework

[pre-commit](https://pre-commit.com) works in any repository, whatever its language. Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/bislink360/styled-markdown
    rev: v1.5.0
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

The hooks use `language: node`: pre-commit installs this repository's root `package.json`, whose only file is the bundled single-file CLI (`skills/styled-markdown-reader/scripts/smd.cjs`), so there are no dependencies and nothing comes from the npm registry. On macOS and Linux pre-commit uses the `node` and `npm` on your PATH; without them, and always on Windows, it downloads a private Node.js once. The single-file CLI doesn't include the Mermaid parser, so the hooks don't report `mermaid/syntax`; run `smd validate` from the npm package in CI for that.

### With lint-staged and husky

For JavaScript projects. The `styled-markdown` package isn't on the npm registry yet, so install it from the release's `.tgz`, which also gives you the Mermaid parser:

```bash
npm install --save-dev https://github.com/bislink360/styled-markdown/releases/download/v1.5.0/styled-markdown-1.5.0.tgz
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

lint-staged appends the staged files to each command, runs them in order and stages the formatting changes. Add `--strict` to `smd validate` to fail on warnings. To use the single-file CLI instead of the package, download it into the repository (`curl -sSLo tools/smd.cjs https://raw.githubusercontent.com/bislink360/styled-markdown/v1.5.0/skills/styled-markdown-reader/scripts/smd.cjs`) and use `"node tools/smd.cjs fmt"` and `"node tools/smd.cjs validate"`.

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
npm run package        # styled-markdown-1.5.0.vsix
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

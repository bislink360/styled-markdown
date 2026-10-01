# Styled Markdown in other editors

The VS Code extension is the full experience (live preview, agent view, tasks view). For other editors, `smd lsp` is a **language server** that brings the editing features of the extension to any [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) client: Neovim, Helix, Zed, Sublime Text, Emacs and others.

> [!WARNING]
> The setups below were written from each editor's documented configuration format and checked against the server's own protocol tests. **They have not been tested in those editors here.** If one doesn't work for you, please [open an issue](https://github.com/bislink360/styled-markdown/issues) with your editor's version and log.

## Contents

1. [What the server does](#what-the-server-does)
2. [Install](#install)
3. [Neovim](#neovim)
4. [Helix](#helix)
5. [Zed](#zed)
6. [Other editors](#other-editors)
7. [Troubleshooting](#troubleshooting)

## What the server does

| Feature | LSP method | Same as in VS Code |
|---|---|---|
| Problems as you type, with codes and severities | `textDocument/publishDiagnostics` | Problems panel, `smd validate` |
| Quick fixes for problems that have one | `textDocument/codeAction` (`quickfix`) | Lightbulb, `smd validate --fix` |
| Outline: headings as a tree, with decisions, risks and API endpoints in their section | `textDocument/documentSymbol` | Outline view |
| Symbol search across every `.smd` file in the workspace | `workspace/symbol` | Ctrl+T |
| Hover: what a block or inline directive is, a preview of a linked section or document, the code a `file="…"` fence embeds | `textDocument/hover` | Hover |
| Completion: block names after `:::`, attribute keys and values, front matter keys and values, inline directives, fence languages, Mermaid diagram types, link paths and `#anchors` | `textDocument/completion` | IntelliSense |
| Go to definition: `#anchor` links, links to other files and their headings, reference links | `textDocument/definition` | F12 |
| Format the document | `textDocument/formatting` | Format Document, `smd fmt` |

Validation uses the same rules and config files as `smd validate`: the nearest `smd.config.json`, `.smdrc` or `.smdrc.json` above the document, and inline `<!-- smd-disable… -->` comments. Mermaid syntax errors are reported too when the server runs from the npm package (which ships Mermaid's parser next to the CLI).

Not in the server (VS Code only for now): the preview, the agent view, refactorings (wrap in a block, convert a blockquote), find references and rename of headings, color swatches, folding and the tasks view.

Technical details: stdio only (`--stdio`; `--socket`, `--pipe` and `--node-ipc` are refused), full document sync, UTF-16 positions by default (UTF-8 or UTF-32 when the client offers only those), logs on stderr.

## Install

The server is part of the `smd` command, from version 1.5.0. Install the npm package once (Node.js 18+), from the npm registry or from the tarball attached to the [GitHub release](https://github.com/bislink360/styled-markdown/releases):

```bash
npm install -g styled-markdown
# or
npm install -g https://github.com/bislink360/styled-markdown/releases/download/v1.5.0/styled-markdown-1.5.0.tgz
```

This puts two commands on your `PATH`:

| Command | What it is |
|---|---|
| `smd lsp --stdio` | the language server, as a subcommand of the CLI |
| `smd-language-server --stdio` | the same server under its own name, for editor configs |

Without a global install, use `npx -y -p styled-markdown smd-language-server --stdio` as the command (slower to start). A copy of the single-file CLI also works: `node path/to/smd.cjs lsp --stdio` (it is bundled in the agent skills and installed to `.smd/smd.cjs` by `smd skills install --target …`).

Check it starts (it waits for a client on stdin; press Ctrl+C to stop):

```bash
smd-language-server --stdio
# [smd lsp] smd-language-server 1.5.0 over stdio
```

## Neovim

Neovim has no `smd` file type, so first map the `.smd` extension to one (in `init.lua`):

```lua
vim.filetype.add({ extension = { smd = 'smd' } })

-- Optional: Markdown highlighting for .smd files (Neovim 0.9+ with the markdown Tree-sitter parser).
vim.treesitter.language.register('markdown', 'smd')
```

Then pick **one** of the three setups below.

### Neovim 0.11+: `vim.lsp.config`

```lua
vim.lsp.config('smd', {
  cmd = { 'smd-language-server', '--stdio' },
  filetypes = { 'smd' },
  root_markers = { 'smd.config.json', '.smdrc', '.git' },
})
vim.lsp.enable('smd')
```

### Neovim 0.8–0.10: `vim.lsp.start`

```lua
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'smd',
  callback = function(args)
    local marker = vim.fs.find({ 'smd.config.json', '.smdrc', '.git' }, {
      upward = true,
      path = vim.fs.dirname(vim.api.nvim_buf_get_name(args.buf)),
    })[1]
    vim.lsp.start({
      name = 'smd',
      cmd = { 'smd-language-server', '--stdio' },
      root_dir = marker and vim.fs.dirname(marker) or vim.fn.getcwd(),
    })
  end,
})
```

### nvim-lspconfig

nvim-lspconfig doesn't include this server, so register it as a custom server (this is the `lspconfig.configs` style; on Neovim 0.11+ prefer `vim.lsp.config` above):

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.smd then
  configs.smd = {
    default_config = {
      cmd = { 'smd-language-server', '--stdio' },
      filetypes = { 'smd' },
      root_dir = lspconfig.util.root_pattern('smd.config.json', '.smdrc', '.git'),
      single_file_support = true,
    },
  }
end
lspconfig.smd.setup({})
```

### Using it

Problems show as diagnostics. The usual LSP functions work: `vim.lsp.buf.code_action()` for quick fixes, `vim.lsp.buf.format()` to format, `vim.lsp.buf.hover()`, `vim.lsp.buf.definition()`, `vim.lsp.buf.document_symbol()` and `vim.lsp.buf.workspace_symbol()`. Neovim 0.11 maps several of these by default (`K`, `gra`, `gO`); completion needs a completion plugin or `vim.lsp.completion.enable()`.

On Windows, if Neovim can't start `smd-language-server`, point `cmd` at the `.cmd` shim or at Node directly: `{ 'smd-language-server.cmd', '--stdio' }`, or `{ 'node', 'C:/path/to/smd.cjs', 'lsp', '--stdio' }`.

## Helix

Add a language and its server to `languages.toml` (`~/.config/helix/languages.toml`, or `.helix/languages.toml` in a project):

```toml
[language-server.smd]
command = "smd-language-server"
args = ["--stdio"]

[[language]]
name = "smd"
scope = "text.smd"
file-types = ["smd"]
roots = ["smd.config.json", ".smdrc", ".git"]
language-servers = ["smd"]
grammar = "markdown"
indent = { tab-width = 2, unit = "  " }
```

Helix reads highlighting queries by language name, so for Markdown highlighting also create `~/.config/helix/runtime/queries/smd/highlights.scm` (and `injections.scm`) containing one line:

```scheme
; inherits: markdown
```

Run `hx --health smd` to check that Helix finds the server. Quick fixes are under `space a`, formatting is `:format`, the outline is `space s` and workspace symbols `space S`. To format on save, add `auto-format = true` to the `[[language]]` entry.

## Zed

Zed can map `.smd` files to its Markdown support with a setting alone (`settings.json`):

```json
{
  "file_types": {
    "Markdown": ["smd"]
  }
}
```

That gives highlighting, but **not the language server**: in Zed, a language server is attached by an extension, and settings can only configure servers an extension has registered. So using `smd-language-server` in Zed needs a small Zed extension. We don't publish one yet; this is the minimal shape of a [Zed language extension](https://zed.dev/docs/extensions/languages), to build and install with **zed: install dev extension**:

```text
smd-zed/
  extension.toml
  Cargo.toml
  src/lib.rs
  languages/smd/config.toml
  languages/smd/highlights.scm      (copy Zed's Markdown queries)
```

`extension.toml`:

```toml
id = "styled-markdown"
name = "Styled Markdown"
version = "0.0.1"
schema_version = 1
authors = ["You <you@example.com>"]
description = "Styled Markdown (.smd) with smd-language-server"

[language_servers.smd-language-server]
name = "smd-language-server"
languages = ["Styled Markdown"]

[grammars.markdown]
repository = "https://github.com/tree-sitter-grammars/tree-sitter-markdown"
rev = "<a commit of that repository>"
path = "tree-sitter-markdown"
```

`languages/smd/config.toml`:

```toml
name = "Styled Markdown"
grammar = "markdown"
path_suffixes = ["smd"]
```

`Cargo.toml` (a `cdylib` crate depending on the current [`zed_extension_api`](https://crates.io/crates/zed_extension_api)):

```toml
[package]
name = "smd-zed"
version = "0.0.1"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
zed_extension_api = "<current version>"
```

`src/lib.rs`, which starts the server found on your `PATH`:

```rust
use zed_extension_api::{self as zed, LanguageServerId, Result};

struct SmdExtension;

impl zed::Extension for SmdExtension {
    fn new() -> Self {
        SmdExtension
    }

    fn language_server_command(&mut self, _id: &LanguageServerId, worktree: &zed::Worktree) -> Result<zed::Command> {
        let command = worktree
            .which("smd-language-server")
            .ok_or("smd-language-server is not on PATH: run npm install -g styled-markdown")?;
        Ok(zed::Command { command, args: vec!["--stdio".into()], env: Default::default() })
    }
}

zed::register_extension!(SmdExtension);
```

With the extension installed, `"file_types"` above is not needed, and the server's command can still be overridden in settings:

```json
{
  "lsp": {
    "smd-language-server": {
      "binary": { "path": "smd-language-server", "arguments": ["--stdio"] }
    }
  }
}
```

## Other editors

Any LSP client works with the command `smd-language-server --stdio` for files ending in `.smd`. Use the language id `smd` where the client asks for one, and `smd.config.json`, `.smdrc` or `.git` as root markers. For example, Sublime Text's LSP package (`LSP.sublime-settings`):

```json
{
  "clients": {
    "smd": {
      "enabled": true,
      "command": ["smd-language-server", "--stdio"],
      "selector": "text.html.markdown"
    }
  }
}
```

(This attaches it to Markdown views; assign `.smd` files to Markdown with *View → Syntax → Open all with current extension as… → Markdown*.)

## Troubleshooting

- **Nothing happens:** run `smd-language-server --stdio` in a terminal. If the command isn't found, install the npm package globally or use the full path. The server writes a line to stderr when it starts and logs failures there; most editors show it in their LSP log (`:LspLog` / `:lua vim.cmd.edit(vim.lsp.get_log_path())` in Neovim, `:log-open` in Helix, *open language server logs* in Zed's command palette).
- **No diagnostics for links to other files or code embeds:** they need the document to be a file on disk (a `file:` URI). Buffers that are not files yet get every other check.
- **Rule settings ignored:** the server reads the nearest `smd.config.json` / `.smdrc` above the document, stopping at the repository root, like `smd validate`. Problems in that file are logged to stderr.
- **Wrong columns with emoji or other non-ASCII text:** the server uses UTF-16 columns unless the client offers only UTF-8 or UTF-32 (LSP 3.17 `positionEncodings`). Please report your editor if columns are off.

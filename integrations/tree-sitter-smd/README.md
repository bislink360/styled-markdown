# tree-sitter-smd

A [Tree-sitter](https://tree-sitter.github.io/) grammar for **Styled Markdown** (`.smd`), with highlight, injection and fold queries. It gives `.smd` files syntax highlighting in editors that use Tree-sitter: Neovim, Helix, Zed and Emacs 29+. The VS Code extension doesn't use it (VS Code highlights with its TextMate grammar).

> [!WARNING]
> The grammar is tested with `tree-sitter test`, and every `.smd` file in this repository parses without errors. The editor setups below were written from each editor's documented configuration. **They have not been tested in those editors here.** If one doesn't work for you, please [open an issue](https://github.com/bislink360/styled-markdown/issues) with your editor's version.

## How it works

Markdown in Tree-sitter is already two grammars: [tree-sitter-markdown](https://github.com/tree-sitter-grammars/tree-sitter-markdown) for blocks and `markdown_inline` for inline text. This grammar doesn't fork them. It parses only what `.smd` adds (see [docs/SPEC.md](../../docs/SPEC.md)), and the queries inject Markdown for the rest.

- **Parsed here:**
  - front matter (injected as YAML)
  - `:::name{attrs} Title` … `:::` containers, nested (a bare `:::` closes the innermost one, whatever the colon count)
  - fenced code (injected by its info string; `mermaid` included) and `$$` math (injected as LaTeX), so `:::` or `$` inside them is never `.smd` syntax
  - inline directives `:name[content]{attrs}`, styled spans `[text]{attrs}`, `==highlight==`, `$math$`, `{{variables}}`, `[^footnotes]` and their `[^label]:` definitions, task boxes, code spans, and attribute lists, including `{#id}` at the end of a heading
- **Everything else** is a `line`. `queries/injections.scm` hands all lines to the `markdown` parser as one combined document, so paragraphs, lists, headings and tables work across lines, and Markdown injects `markdown_inline` into its own inline text. The `.smd` constructs inside a line are named nodes, which injections leave out, so Markdown doesn't see them.

Container and directive names are not fixed in the grammar: a name it doesn't know parses like any other, so highlighting keeps working for new or misspelled ones. `queries/highlights.scm` lists the names in [`extension/src/core/spec.ts`](../../extension/src/core/spec.ts) (highlighted as `@tag.builtin` and `@function.builtin`, others as `@tag` and `@function`). A unit test (`extension/test/treeSitter.test.ts`) fails when the two lists differ.

### Why `.smd` is the host and Markdown is injected

The other way round, Markdown as the host with an `.smd` grammar injected on top, doesn't work in practice:

- **Neovim and Helix pick one parser for a file type.** For Markdown to be the host, `.smd` would have to be added to the Markdown queries themselves. In Neovim that changes every Markdown file (`;; extends`). In Helix, user queries replace the built-in ones, so users would maintain a copy of Helix's Markdown queries.
- **tree-sitter-markdown doesn't know `.smd` blocks.** It reads `:::note` lines as paragraph text, the LaTeX in a `$$` block as inline Markdown (so `_` and `*` become emphasis), and a `:::` inside fenced code the same as one outside. There would be nothing to fold or indent containers by.

With `.smd` as the host, each editor needs one parser and its own query folder, Markdown files are untouched, and Markdown is still parsed by the Markdown grammars. Neovim and Helix both support the combined injection (`injection.combined`) that this needs.

### Recognized, but simpler than the renderer

The scanner ([`src/scanner.c`](src/scanner.c)) follows the renderer's rules (`extension/src/core/markdownItRules.ts`): an opener is syntax only when its closer follows, and anything else is plain text, so unfinished syntax never produces ERROR nodes. A few differences, all in what is highlighted, never in how a document renders:

- Inline constructs end on their own line. The renderer lets `==mark==` or `$math$` continue onto the next line of a paragraph.
- The text inside a span, mark or directive is one node. `.smd` syntax nested in it, such as `:badge[v{{version}}]`, isn't highlighted separately.
- A `{…}` at the end of any line is highlighted as an attribute list, not only at the end of a heading.
- Fences, `$$` and `:::` count as blocks at any indentation, including in 4-space indented code.
- Directive names follow the renderer's syntax (`[a-z][a-z0-9-]*`), but every such name is highlighted, known or not.

There is no `indents.scm`: `.smd` container bodies are not indented by convention, and Markdown's indentation comes from lists, which the Markdown grammar handles.

## Editor setup

Every editor needs the `markdown` and `markdown_inline` parsers for Markdown highlighting. `yaml` (front matter) and `latex` (math) are optional, as are code languages for fenced code (`mermaid` too). An injected language the editor lacks just stays unhighlighted. Building the parser needs a C compiler, as for any Tree-sitter grammar with an external scanner.

Editors build the grammar from this repository, by URL, subdirectory and revision. Use a release tag (`v1.7.0` or later) as the revision so the parser matches its queries.

### Neovim

Map the file type once, in `init.lua` or as `~/.config/nvim/ftdetect/smd.lua`:

```lua
vim.filetype.add({ extension = { smd = 'smd' } })
```

**nvim-treesitter `main` branch** (Neovim 0.11+): register the parser and its queries, install, and start highlighting for the file type:

```lua
vim.api.nvim_create_autocmd('User', {
  pattern = 'TSUpdate',
  callback = function()
    require('nvim-treesitter.parsers').smd = {
      install_info = {
        url = 'https://github.com/bislink360/styled-markdown',
        revision = 'v1.7.0',
        location = 'integrations/tree-sitter-smd',
        queries = 'integrations/tree-sitter-smd/queries',
      },
    }
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'smd',
  callback = function()
    vim.treesitter.start()
    vim.wo.foldmethod = 'expr'
    vim.wo.foldexpr = 'v:lua.vim.treesitter.foldexpr()'
  end,
})
```

Then run `:TSInstall smd markdown markdown_inline yaml latex`.

**nvim-treesitter `master` branch** (Neovim 0.9 and 0.10):

```lua
local parsers = require('nvim-treesitter.parsers').get_parser_configs()
parsers.smd = {
  install_info = {
    url = 'https://github.com/bislink360/styled-markdown',
    revision = 'v1.7.0',
    location = 'integrations/tree-sitter-smd',
    files = { 'src/parser.c', 'src/scanner.c' },
  },
  filetype = 'smd',
}

require('nvim-treesitter.configs').setup({
  ensure_installed = { 'smd', 'markdown', 'markdown_inline', 'yaml', 'latex' },
  highlight = { enable = true },
})
```

This branch doesn't install queries for parsers you add, so copy `queries/*.scm` from this folder to `~/.config/nvim/queries/smd/`. Do the same on `main` if your nvim-treesitter doesn't install them from `queries` above.

Check with `:checkhealth nvim-treesitter` and `:InspectTree` in a `.smd` buffer. `:Inspect` on a word shows which grammar highlighted it.

### Helix

In `languages.toml` (`~/.config/helix/languages.toml`), declare the grammar and use it for the `smd` language. With the language server from [EDITORS.md](../../docs/EDITORS.md#helix), replace that entry's `grammar = "markdown"` with this:

```toml
[[language]]
name = "smd"
scope = "text.smd"
file-types = ["smd"]
roots = ["smd.config.json", ".smdrc", ".git"]
language-servers = ["smd"]
grammar = "smd"
injection-regex = "smd"
block-comment-tokens = { start = "<!--", end = "-->" }
indent = { tab-width = 2, unit = "  " }

[[grammar]]
name = "smd"
source = { git = "https://github.com/bislink360/styled-markdown", rev = "v1.7.0", subpath = "integrations/tree-sitter-smd" }
```

Then:

```sh
hx --grammar fetch
hx --grammar build
mkdir -p ~/.config/helix/runtime/queries/smd
cp queries/highlights.scm queries/injections.scm ~/.config/helix/runtime/queries/smd/
```

The `cp` is run from this folder (any checkout of the repository at the same tag). `hx --health smd` shows whether the grammar and queries are found. Helix ships the `markdown`, `markdown.inline`, `yaml` and `latex` grammars. The queries inject `markdown`, which then injects its own inline grammar, so the name difference (`markdown_inline` in Neovim) doesn't matter. Some capture names have no Helix theme scope (`markup.math`), and those stay unstyled.

### Zed

Zed reads grammars from extensions, so the grammar goes into a small extension like the one in [EDITORS.md](../../docs/EDITORS.md#zed). Declare the grammar in `extension.toml` instead of Markdown's:

```toml
[grammars.smd]
repository = "https://github.com/bislink360/styled-markdown"
rev = "<the commit of a release tag, v1.7.0 or later>"
path = "integrations/tree-sitter-smd"
```

Set `grammar = "smd"` in `languages/smd/config.toml`, and copy `highlights.scm` and `injections.scm` to `languages/smd/`. Zed's themes use fewer capture names than Neovim's, so some highlights may need renaming (for example `@markup.heading` to `@title`). This setup is the least checked of the three.

### Other editors

Emacs 29+ (`treesit`), and any other editor that loads Tree-sitter grammars, can build this one from the same URL and subdirectory. It needs the same `markdown` grammars for injections. GitHub's code view doesn't use third-party Tree-sitter grammars for highlighting: `.smd` files there are highlighted by Linguist, which would need the language added upstream.

## Development

```sh
cd integrations/tree-sitter-smd
npm ci                         # tree-sitter-cli, pinned in package.json
npx tree-sitter generate --abi 14
npx tree-sitter test           # test/corpus/*.txt
node scripts/parse-all.mjs     # every .smd file in the repository, also with CRLF line endings
npx tree-sitter parse ../../examples/showcase.smd
```

- **Generated files:** `src/parser.c`, `src/grammar.json`, `src/node-types.json` and `src/tree_sitter/` are generated and committed, as Tree-sitter grammars conventionally are, so editors can compile the parser without the CLI. Regenerate them after changing `grammar.js`; CI checks that they are up to date.
- **ABI:** `--abi 14` keeps the parser loadable by Neovim 0.9/0.10 and older Helix releases. ABI 15 needs Tree-sitter 0.25 or later in the editor.
- **Compiler:** `tree-sitter test` and `tree-sitter parse` compile the parser with the system C compiler (`cc`, or MSVC on Windows). Without one, they stop with a compiler error.
- **Names:** after adding a container or inline directive to `spec.ts`, add its name to the lists in `queries/highlights.scm`. The unit test fails until the lists match.

There is no release asset for the grammar, and no npm or crates.io package. Neovim, Helix and Zed all build grammars from a git URL, a subdirectory and a revision, and they compile `src/parser.c` and `src/scanner.c` for the user's platform, so a prebuilt library would not be used.

## License

MIT, like the rest of the repository.

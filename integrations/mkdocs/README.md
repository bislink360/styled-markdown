# mkdocs-styled-markdown

An [MkDocs](https://www.mkdocs.org) plugin for [Styled Markdown](https://github.com/bislink360/styled-markdown) (`.smd`): `.smd` files in your `docs_dir` become pages, rendered by the same engine as the `smd` CLI and the VS Code extension. Callouts, tabs, tasks, figures, decisions, risks, diagrams, math and `:::include` all work, inside your MkDocs theme.

## Requirements

- Python 3.9+ and MkDocs 1.6+
- **Node.js 18+** on `PATH`. The renderer is the Styled Markdown engine in JavaScript, shipped inside the package (`bridge.cjs`, no npm install). The plugin starts one `node` process per build. Without Node the build stops with a message saying so.

## Install

Until the package is on PyPI, install the wheel attached to the [GitHub Release](https://github.com/bislink360/styled-markdown/releases):

```bash
pip install https://github.com/bislink360/styled-markdown/releases/download/v1.7.0/mkdocs_styled_markdown-1.7.0-py3-none-any.whl
```

Once it is published to PyPI: `pip install mkdocs-styled-markdown`. The plugin's version is the Styled Markdown release it ships.

## Use

```yaml
# mkdocs.yml
site_name: Handbook
theme:
  name: mkdocs            # or material, readthedocs…
plugins:
  - search
  - styled-markdown:
      md_syntax: false    # true: also render .smd syntax in .md pages
      validate: false     # true: report smd problems; errors fail `mkdocs build --strict`
      node: node          # the Node.js executable, if it isn't `node` on PATH
exclude_docs: |
  _partials/              # documents that are only included, not pages
```

List `search` too when you add `plugins:`: MkDocs only adds it by itself when the setting is absent.

## What it does

- **Pages:** every `.smd` file in `docs_dir` is a page, at the URL a `.md` file of the same name would have (`guide/setup.smd` → `guide/setup/`). It shows up in the navigation, the search index and `nav:` like any page. When a `.smd` and a `.md` file have the same URL, the `.smd` page is built and the build warns.
- **Title:** front matter `title`, else the first `#` heading, else MkDocs' usual fallback. The front matter also renders as the page header (title, status, owners, tags), as in `smd render`.
- **Table of contents:** from the document's headings and their ids (`## Setup {#install}` → `#install`), so the theme's table of contents, permalinks and anchor checks work.
- **Links:** links between `.smd` pages, and from `.smd` to `.md` pages, point at the built pages (`setup.smd#install` → `../setup/#install`), with or without `use_directory_urls`. Links from `.md` pages to `.smd` files work through MkDocs itself. Images and other files keep their relative paths.
- **`:::include` and code embeds** (```` ```ts file="…" ````) read files inside `docs_dir` only; anything outside shows the block's fallback text. Put documents that are only included in a folder listed in `exclude_docs`.
- **Styles and scripts:** `smd.css` and the Styled Markdown runtime (tabs, copy buttons, diagrams) are added to every page under `assets/styled-markdown/`. smd's code colors apply only to `.smd` code blocks, so the theme keeps its own highlighting elsewhere. Pages with math or Mermaid diagrams load KaTeX's stylesheet and Mermaid from a CDN, as `smd build` does.
- **Dark mode:** `.smd` blocks follow the theme's light or dark mode (the `mkdocs` theme's `color_mode` and its toggle, Material's `slate` scheme). Other themes get the light palette.
- **Labels** the renderer adds ("Note", "Figure 2", status names) follow a document's `lang:`, else the theme's `locale`.

### `md_syntax: true`

`.md` pages are rendered by the Styled Markdown engine too, so they can use `.smd` syntax (callouts, tabs, task lists…). Their front matter is not shown as a header. These pages no longer go through Python-Markdown, so `markdown_extensions` (admonitions, `pymdownx`…) don't apply to them; leave the option off if your `.md` pages rely on those.

### `validate: true`

Each `.smd` page is checked as `smd validate` checks it, with the rules of the nearest `smd.config.json` or `.smdrc`. Problems are logged with their file, line and column:

```text
WARNING -  mkdocs_styled_markdown: guide.smd:12:1: ":::warning" is never closed. Add a line with ::: after its content. [container/unclosed]
INFO    -  mkdocs_styled_markdown: guide.smd:20:11: "setup.smd" does not exist. [link/missing-file]
```

Errors are MkDocs warnings, so `mkdocs build --strict` fails on them, as `smd validate` fails on errors. smd warnings are logged as info; information and hints only with `mkdocs build --verbose`. Links are checked against the files in `docs_dir`.

## Develop

The bridge is built from `extension/src/mkdocsBridge.ts` by `npm run build` in `extension/`, which copies it to `mkdocs_styled_markdown/bridge.cjs`; commit the copy with the change (CI fails when it is stale).

```bash
cd integrations/mkdocs
python -m venv .venv && .venv/bin/pip install -e ".[test]"   # .venv\Scripts\pip on Windows
.venv/bin/python -m pytest                                   # builds small sites with the real mkdocs
python -m build                                              # sdist and wheel in dist/
```

## License

MIT

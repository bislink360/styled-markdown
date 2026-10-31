# Styled Markdown on GitHub

GitHub renders `.md` files as pages, but shows a `.smd` file as its source text. People who browse your repository on github.com see `:::warning` fences and `{color=red}` attributes instead of a callout. This guide covers the ways around that, from the simplest to the most complete, and says what each one costs.

## Contents

- [Which path to choose](#which-path-to-choose)
- [A. Styled Markdown syntax in `.md` files](#a-styled-markdown-syntax-in-md-files)
- [B. Generate `.md` copies in CI](#b-generate-md-copies-in-ci)
- [C. Post the changes on pull requests](#c-post-the-changes-on-pull-requests)
- [`.gitattributes`: what it does and doesn't do](#gitattributes-what-it-does-and-doesnt-do)

## Which path to choose

| Path | GitHub shows | You keep | Cost |
|---|---|---|---|
| **A.** `.smd` syntax in `.md` files | GitHub's own rendering: alerts, tables, task lists, Mermaid and math render; `:::` fences and `:directives[…]` show as plain text | One file per document. The CLI, VS Code, MkDocs and the static-site plugins read it as Styled Markdown | Write the parts GitHub must show well in its subset. Folder scans and the MCP server look only at `.smd` files |
| **B.** `.md` copies made in CI | A rendered page for every `.smd` file: callouts become alerts, decisions and agent blocks become notes, tasks keep owners and dates | The full syntax in `.smd`; GitHub readers open the `.md` copy | A second file per document, written by a bot commit or checked on pull requests |
| **C.** A pull request comment | What changed, as an agent reads it, on each pull request | Everything as it is | Review aid only: browsing the repository still shows source |

Start with **A** if most of your documents are READMEs and guides that people read on GitHub. Use **B** when you want the full syntax (decisions, risks, tasks, layout) and still want readable pages on GitHub. Add **C** to either for reviews.

## A. Styled Markdown syntax in `.md` files

Every `.md` file is already a valid Styled Markdown document. Add `smd: 2` to its front matter and the tools read it with the spec v2 rules:

```markdown
---
smd: 2
title: Payments runbook
---

> [!WARNING]
> Rotate the keys before you deploy.

- [ ] Move the cron job to the new cluster :priority[P1] @ops :due[2026-12-01]
```

### What GitHub shows

GitHub renders the parts of Styled Markdown that are also GitHub Markdown, and shows the rest as text:

| Syntax | On GitHub | Use in a `.md` file read on GitHub |
|---|---|---|
| GitHub alerts (`> [!NOTE]`, `> [!WARNING]`…) | Rendered alerts | **Yes.** Styled Markdown reads them as callouts (`<warning>` in the agent view) |
| Tables, task lists, footnotes, `<details>` | Rendered | **Yes** |
| ```` ```mermaid ```` diagrams, `$math$` and `$$` math | Rendered | **Yes** |
| Front matter | A table at the top of the page | Yes |
| `:::warning`, `:::decision`, `:::risk`, `:::agent` and other containers | The fence lines show as text; the content renders as normal Markdown | Readable, but not styled. Prefer alerts for callouts |
| `:priority[P1]`, `:due[…]`, `:badge[…]` and other inline directives | Shown as written | Readable: `:priority[P1]` still says P1 |
| `[text]{color=red}`, `## Heading {agent=skip}` | The attribute list shows as text | Avoid in documents read on GitHub |

### What the tools do with `.md` files

| Tool | `.md` files |
|---|---|
| `smd validate`, `fmt`, `agent`, `outline`, `tasks`, `query`, `index`, `diff`, `meta`, `export` | Read a `.md` file you **name**, as Styled Markdown: `smd agent docs/runbook.md`, `smd validate README.md docs/*.md` |
| The same commands given a **folder** | Look only at `.smd` files in it (`smd validate docs/` with only `.md` files says "No .smd files found" and exits 2). Name the files, or let your shell expand `docs/*.md` |
| `smd build docs --md` | Publishes `.md` files as pages too |
| GitHub Action (`validate/`) | Checks `.md` files listed in `paths` one by one; folders give their `.smd` files only |
| MCP server (`smd mcp`) | Reads `.smd` files only |
| VS Code | The built-in Markdown preview renders the syntax in `.md` files that have an `smd:` key (the `smd.markdownPreview.enabled` setting). Validation, completion and the Styled Markdown preview are for `.smd` files |
| MkDocs plugin, remark and rehype plugins, markdown-it plugin, Obsidian | Render it in `.md` files (MkDocs: `md_syntax: true`) |

A `.md` file without an `smd:` key is read with the spec v1 rules, as every `.md` file was in 1.x. That is fine for most text; `smd: 2` keeps quotes and dashes as typed and links only full URLs, as GitHub does.

## B. Generate `.md` copies in CI

`smd export <file.smd> --to md` writes plain GitHub Markdown: callouts become alerts, a decision becomes a note titled "Decision (accepted · @maya): …", tasks keep their priority, owner and date, `:::agent` blocks become a "For agents" note, code embeds are inlined, and layout containers are flattened. Nothing is lost; styling that GitHub can't show is dropped.

The workflow below writes `docs/plan.md` next to every `docs/plan.smd`. On a push to `main` it commits the copies; on a pull request it fails when a copy is out of date and says which command to run. Links between documents (`[setup](setup.smd#install)`) are rewritten to the copies (`setup.md#install`); links with a scheme (`https://…`) are left alone.

```yaml
# .github/workflows/markdown-copies.yml
name: Markdown copies
on:
  push:
    branches: [main]
    paths: ['**.smd']
  pull_request:
    paths: ['**.smd']
  workflow_dispatch:

permissions:
  contents: write   # to commit the copies on main; pull requests only read

env:
  DOCS: docs                # the folder with your .smd files
  SMD_VERSION: v2.5.0       # the Styled Markdown release whose CLI to use

jobs:
  copies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download the smd CLI (one file, no dependencies)
        run: curl -sSfLo "$RUNNER_TEMP/smd.cjs" "https://raw.githubusercontent.com/bislink360/styled-markdown/$SMD_VERSION/skills/styled-markdown-reader/scripts/smd.cjs"
      - name: Write a .md copy next to every .smd file
        run: |
          set -euo pipefail
          git ls-files -z -- "$DOCS/*.smd" | while IFS= read -r -d '' file; do
            copy="${file%.smd}.md"
            node "$RUNNER_TEMP/smd.cjs" export "$file" --to md -o "$copy"
            # Links to other .smd documents point at their copies.
            sed -i -E 's/\]\(([^):#]*)\.smd([)#])/](\1.md\2/g' "$copy"
          done
      - name: Commit the copies
        if: github.event_name != 'pull_request'
        run: |
          git add -A -- "$DOCS"
          if git diff --cached --quiet; then echo "The copies are up to date."; exit 0; fi
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
            commit -m "docs: update the Markdown copies of .smd files"
          git push
      - name: Check the copies are up to date
        if: github.event_name == 'pull_request'
        run: |
          if [ -n "$(git status --porcelain -- "$DOCS")" ]; then
            git status --short -- "$DOCS"
            echo "::error::The .md copies are out of date. Run: smd export <file.smd> --to md -o <file.md> for each changed file, or let the push to main update them."
            exit 1
          fi
```

Notes:

- **Protected `main`:** if pushes to `main` need a pull request, drop the commit step and keep the check: contributors update the copies before merging (a [pre-commit hook](INSTALL.md#pre-commit-hooks) can run the same export).
- **No loop:** a commit pushed with the workflow's own `GITHUB_TOKEN` doesn't start another workflow run.
- **Deleted documents:** the workflow doesn't delete the copy of a `.smd` file you removed; delete it in the same commit.
- **Mark the copies as generated** so GitHub collapses them in diffs and leaves them out of language statistics. In `.gitattributes`, with your folder: `docs/**/*.md linguist-generated`. Add a line to the folder's README saying the `.smd` files are the source, so nobody edits a copy.
- **Agents:** tell them to read the `.smd` files (the [skills and rules](SKILLS.md) already do), not the copies.

## C. Post the changes on pull requests

`smd diff <files> --since <git-ref>` prints only the sections that changed, in the agent view: compact, without styling, with line numbers. Posted as a pull request comment, it lets reviewers (and review agents) read what a document change means without opening the source.

```yaml
# .github/workflows/smd-pr-comment.yml
name: Document changes
on:
  pull_request:
    paths: ['**.smd']

permissions:
  contents: read
  pull-requests: write   # to comment

env:
  SMD_VERSION: v2.5.0

jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # smd diff --since needs the base branch's history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download the smd CLI
        run: curl -sSfLo "$RUNNER_TEMP/smd.cjs" "https://raw.githubusercontent.com/bislink360/styled-markdown/$SMD_VERSION/skills/styled-markdown-reader/scripts/smd.cjs"
      - name: Changed sections, in the agent view
        env:
          BASE: origin/${{ github.base_ref }}
        run: |
          set -euo pipefail
          mapfile -t files < <(git diff --name-only --diff-filter=AM "$BASE"...HEAD -- '*.smd')
          if [ "${#files[@]}" -eq 0 ]; then
            echo "No .smd file was added or changed (only removed)." > diff.txt
          else
            node "$RUNNER_TEMP/smd.cjs" diff "${files[@]}" --since "$BASE" --brief > diff.txt
          fi
          {
            echo "### Document changes"
            echo
            echo "What changed in each \`.smd\` file, as an agent reads it (\`smd diff --since ${{ github.base_ref }}\`)."
            echo
            echo '```text'
            head -c 60000 diff.txt   # a comment holds at most 65,536 characters
            echo '```'
          } > comment.md
          cat comment.md >> "$GITHUB_STEP_SUMMARY"
      - name: Comment on the pull request
        # A pull request from a fork gets a read-only token: it has the job summary instead.
        if: github.event.pull_request.head.repo.full_name == github.repository
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file comment.md --edit-last --create-if-none
```

- `--edit-last --create-if-none` keeps one comment per pull request and updates it on every push (GitHub CLI 2.58 or later, which hosted runners have).
- Without a base to compare with, use the whole agent view instead: `node smd.cjs agent <file> --brief` for each file.
- For a rendered page instead of the agent view, `smd export <file> --to html -o page.html` and upload it with `actions/upload-artifact`: reviewers download it from the run page. The [`validate` action](INSTALL.md#github-actions) adds the problems as annotations on the changed lines.

## `.gitattributes`: what it does and doesn't do

```gitattributes
*.smd linguist-language=Markdown
```

This line tells [Linguist](https://github.com/github-linguist/linguist), GitHub's language detector, to treat `.smd` files as Markdown. It changes two things: the repository's language statistics count `.smd` files as Markdown, and GitHub's source view and diffs highlight them as Markdown (headings, emphasis, code fences) instead of plain text.

It does **not** make GitHub render a `.smd` file as a page: GitHub picks the files it renders by their extension, so the file view still shows source (now highlighted). For pages on GitHub, use path A or B.

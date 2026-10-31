# Styled Markdown syntax reference (spec v2)

Everything in CommonMark + GitHub-Flavored Markdown is valid. The `.smd` additions, with every attribute and allowed value, are split by topic. Read only the file for the construct you're using; `smd validate --fix` catches the rest.

| File | Covers |
|---|---|
| `syntax/basics.md` | Front matter keys, block container rules (`:::name{attrs} Title` … `:::`, nesting, closing fences), headings (`{agent=skip}`, `{#id}`), `:::agent` and `:::human` |
| `syntax/callouts.md` | `note` `info` `tip` `success` `warning` `danger` `question`, `{collapsible}`, `:::details`, GitHub alerts |
| `syntax/project.md` | Tasks (`- [ ] … :priority[P1] @owner :due[…]`), `:::decision`, `:::risk`, `:::risk-matrix`, `:::changelog` |
| `syntax/developer.md` | `:::api`, code fence options and source embeds, `:::include`, math, Mermaid diagrams |
| `syntax/layout.md` | `tabs`/`tab`, `columns`/`column`, `card`, `box`, `steps`, `timeline` |
| `syntax/figures-and-notes.md` | `:::figure` and `:ref`, `:::glossary`, `:::quote`, footnotes |
| `syntax/inline.md` | Inline directives (`:badge`, `:status`, `:priority`, `:due`, `:metric`, `:progress`, `:kbd`, `:mention`), `[text]{color=…}`, `{{variables}}`, attribute lists and named colors |
| `syntax/spec-v2.md` | What `smd: 2` changes from v1, errors in every document, silencing validation rules |

New syntax goes in the topic file it belongs to, and in this table if it adds a construct.

## Styled Markdown (.smd)

`.smd` is Markdown plus `:::` blocks, `{…}` attributes and `:name[…]` directives. CLI: `{{smd}} <command>` (Node 22+).

### Reading

- Under ≈6 KB: read the file, skipping `:::human` and `{agent=skip}` parts. Larger: `{{smd}} read <file>`, then `{{smd}} agent <file> --section "<heading>"` as needed. Edit only the raw lines its `[L42]` refs point to.
- Across files: `{{smd}} tasks docs/`, `{{smd}} query "decision, risk" docs/`.
- `:::agent` (`<agent-instructions>`) and accepted decisions are binding; `proposed` isn't decided, `rejected`/`superseded` means don't. Never answer a `:::question` yourself.

### Writing

- Start with `{{smd}} init <file> --template <name>` (`{{smd}} templates`), or front matter `smd: 2`, `title`, `summary`, `status: draft`.
- Write meaning (`:::decision{status=…}`, `:::risk`, `- [ ] task @owner`, `:::agent`), not colors or layout.
- Finish with `{{smd}} validate <file> --fix` until 0 errors. Syntax: https://github.com/bislink360/styled-markdown/blob/main/docs/SPEC.md

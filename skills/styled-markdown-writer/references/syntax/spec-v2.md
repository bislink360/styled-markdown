# Spec v2 rules and validation

Part of the syntax reference (`../syntax.md` lists the topics).

## Spec versions

`smd` selects the rules a document is read with. Write `smd: 2` in a new document. It shows text as written: no curly quotes or dashes unless `typography: true`, and only `https://…`, `www.…` and e-mail addresses become links (a bare `example.com` is text). A heading's trailing `{word}` is heading text, any `:name[…]` is a directive (write `\:name[…]` to keep the text as written), and `\\` in a quoted attribute value is one backslash. A document with `smd: 1` or no `smd` key keeps the v1 rules, so keep an existing document's value when you edit it; `smd migrate <file> --to 2` moves it to spec v2 and keeps what it shows (`--dry-run` reports the plan first).

## Errors in every document

Whatever its `smd` value (since 2.0): an attribute, `#id` or class given twice in one list (`{color=red color=blue}`), a container titled both by `title=` and by text (`:::note{title="A"} B`), a Mermaid syntax error, an invalid figure `kind`, and front matter that can't be read (usually a missing closing `---`; it is then shown as written in a red block). `smd validate --fix` fixes the first two and a misspelt `kind`.

## Silencing validation rules

Fix problems rather than silence them. When a finding is intended (a link to a file that is generated later, an example of a broken diagram), silence only that rule, on the fewest lines:

```markdown
<!-- smd-disable-next-line link/missing-file -->
See the [generated report](build/report.html).

<!-- smd-disable mermaid/* -->
…a section of deliberately broken diagrams…
<!-- smd-enable mermaid/* -->
```

- `smd-disable-next-line` covers the line below, `smd-disable-line` its own line, and `smd-disable` … `smd-enable` a range.
- Codes are separated by spaces or commas and may be `category/*`. No codes silences every rule, which is rarely what you want.
- An unknown code is reported as `rules/unknown`.
- Project-wide settings belong in `smd.config.json` (`{"rules": {"link/missing-file": "off"}}`), not in comments.

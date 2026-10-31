# Inline directives, variables, attributes and colors

Part of the syntax reference (`../syntax.md` lists the topics). Math is in `developer.md`, footnotes and `:ref` in `figures-and-notes.md`.

## Inline directives

| Syntax | Result |
|---|---|
| `[text]{color=red}` | Colored text. Style keys are listed under Attribute lists and colors below. |
| `==text==` | Highlight |
| `:badge[Beta]{color=amber}` | Pill label (`color`) |
| `:status[On track]{color=green}` | Status dot + label (`color`) |
| `:priority[P1]` | Priority pill: P0–P4 or critical/high/medium/low |
| `:due[2026-10-15]` | Due date: amber within 7 days, red when overdue |
| `:metric[42%]{label="Activation" delta="+3%" trend=up good=up}` | KPI tile. `trend`: up/down/flat; `good`: up/down (default up). `label` is expected. |
| `:progress{value=60 color=green label="6/10"}` | Progress bar (value 0–100) |
| `:kbd[Ctrl+Shift+P]` | Keyboard keys |
| `:mention[@team]` | Mention |
| `:ref[fig-checkout]` | "Figure 2", linked to the `:::figure{#fig-checkout}` (see `figures-and-notes.md`) |

A directive's `:` must follow whitespace or opening punctuation, so `10:30` is safe.

## Front matter variables (since 1.6)

```markdown
---
version: "2.10"
release:
  date: 2026-10-20
---

## What's new in {{version}}

Version {{version}} ships on {{release.date}}. :badge[v{{version}}]{color=indigo}
```

- `{{name}}` shows the value of a front matter key; dots reach nested keys and list items (`{{owners.0}}`), and a list shows as `a, b`. Spaces inside the braces are fine.
- Works in text, headings, lists, tables, link text, image alt text, block titles and directive content. Never in code, math, URLs, raw HTML, attribute lists or the front matter itself.
- Only defined keys are replaced: anything else stays as written (`variable/undefined`, info, fixes near misses such as `{{verison}}`). A key holding a mapping is `variable/not-text`. `\{{name}}` or a code span keeps literal braces.
- With `smd: 2`, values show as written: `version: 2.10` shows `2.10`. In `smd: 1` documents YAML reads it as the number 2.1, so quote it there (`version: "2.10"`).
- Heading ids use the heading as written (`#whats-new-in-version`), so they don't change with the value.
- Agents and `smd export --to md` see the values; tools before 1.6 and GitHub show `{{version}}` as written.

## Attribute lists and colors

`{key=value key2="quoted value" .class #id flag}`

| Style key | Values |
|---|---|
| `color`, `bg`, `border` | Named color, `#hex`, `rgb()`, `hsl()` |
| `size` | xs · sm · md · lg · xl · 2xl |
| `weight` | normal · medium · bold |
| `font` | sans · serif · mono |
| `style` | italic · underline · strike |
| `align` (blocks) | left · center · right |

Named colors: `red` `orange` `amber` `yellow` `green` `teal` `cyan` `blue` `indigo` `purple` `pink` `gray` `muted` `accent`. They adapt to light and dark themes.

Any other key or value is a validation error and is dropped by renderers.

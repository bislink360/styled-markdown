# Layout: tabs, columns, cards, boxes, steps, timeline

Part of the syntax reference (`../syntax.md` lists the topics). Layout is for people: agents see only labels, so use it where it helps readers, not to carry meaning.

```markdown
::::tabs
:::tab npm
…
:::
:::tab pnpm
…
:::
::::

::::columns
:::column{width=60%}
…
:::
:::column
…
:::
::::

:::card{accent=green} Title
…
:::

:::box{bg=indigo align=center}
…
:::

:::steps
1. First
2. Second
:::

:::timeline
- [x] **2026-09-15** — Kickoff
- [ ] **2026-10-20** — Beta
:::
```

- `tab` must be directly inside `tabs`, and `column` directly inside `columns`.
- `column` `width`: a percentage (`30%`) or a ratio (`2`).
- `card` `accent`: a color.
- `steps` and `timeline` style the list they wrap. In a timeline, `[x]` items show as done.

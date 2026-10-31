# Callouts and collapsibles

Part of the syntax reference (`../syntax.md` lists the topics).

| Name | Use for |
|---|---|
| `note` | Neutral remark |
| `info` | Background information |
| `tip` | Helpful advice |
| `success` | Done / good outcome |
| `warning` | Important caveat |
| `danger` | Hard constraint, breaking change, data loss |
| `question` | Unresolved decision (say who decides and by when) |

Attributes: `title`, `collapsible` (`{collapsible}` starts closed, `{collapsible=open}` starts open).

GitHub alerts render as callouts too: a blockquote whose first line is only `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (`> [!WARNING]`) is the `note`, `tip`, `info`, `warning` or `danger` callout. Prefer `:::` callouts in `.smd`: they take a title and `{collapsible}`.

```markdown
:::warning{collapsible} Breaking change in v2
Details…
:::

:::details Full log
Collapsed until opened. Attributes: title, open.
:::
```

# Project blocks: tasks, decisions, risks, changelog

Part of the syntax reference (`../syntax.md` lists the topics). These carry meaning that agents and `smd tasks`, `smd decisions`, `smd risks` and `smd query` read.

## Tasks

```markdown
- [ ] Add idempotency keys :priority[P0] @api-team :due[2026-10-03]
- [x] Kickoff with design @sam
```

The owner (`@name` or `:mention[@name]`), priority and due date are extracted by `smd tasks` and `smd meta`. Overdue open tasks produce an info diagnostic.

## Decisions and risks

```markdown
:::decision{status=accepted date=2026-09-08 owner=@maya} Use Postgres for saved searches
Why, and the alternatives considered.
:::

:::risk{impact=high likelihood=medium owner=@payments status=open} Apple Pay verification delays launch
Mitigation.
:::

:::risk-matrix Launch risks
:::
```

| Block | Attribute | Values |
|---|---|---|
| decision | `status` | proposed · accepted · rejected · superseded · deprecated |
| decision | `date` | YYYY-MM-DD |
| decision | `owner` | @name |
| risk | `impact`, `likelihood` | low · medium · high · critical |
| risk | `status` | open · mitigated · accepted · closed |
| risk | `owner` | @name |
| risk-matrix | title after the name | — (no body; draws this document's risks) |

`:::risk-matrix` draws an impact × likelihood grid of the `:::risk` blocks in the same document (closed ones left out), so set `impact` and `likelihood` on every risk: a missing level counts as medium. Leave its body empty. `smd risks DIR` lists the risks of many documents, highest impact × likelihood first.

## Release history

```markdown
:::changelog Release history
## 1.2.0 — 2026-03-01
- Added CSV export

## 1.1.0 — 2026-01-15
### Fixed
- Date picker in Safari
:::
```

- Each heading directly inside is a release: version, ` — ` (or ` - `), date as `YYYY-MM-DD`. `## Unreleased` needs no date; Keep a Changelog's `## [1.2.0] - 2026-03-01` works as written. Deeper headings (`### Fixed`) group a release's notes.
- Newest first. A date that isn't a real date is `changelog/date`, an older version above a newer one `changelog/order`, a version listed twice `changelog/duplicate` (all warnings).
- The headings stay normal headings (same ids and outline entries), so link to a release with its heading id.

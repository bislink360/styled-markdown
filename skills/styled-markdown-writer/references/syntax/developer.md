# Developer blocks: API, code, includes, math, diagrams

Part of the syntax reference (`../syntax.md` lists the topics).

## API endpoints

```markdown
:::api{method=POST path="/v1/orders" auth="bearer token"} Create an order
| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | array | yes | |

**Responses:** `201` created · `422` validation errors
:::
```

- `method` (required): GET · POST · PUT · PATCH · DELETE · HEAD · OPTIONS · WS · RPC · EVENT
- `path` (required), `auth` (optional).

## Code fences

| Info | Effect |
|---|---|
| ```` ```ts ```` | Syntax highlighting |
| ```` ```ts title="src/app.ts" ```` | File-name header |
| ```` ```ts {2,5-7} ```` | Highlight lines 2 and 5–7 |
| ```` ```ts file="../src/app.ts" lines="10-24" ```` | Embed real source (the body must be empty). Paths are relative to the document and must stay inside the workspace. With `lines`, highlight numbers refer to file lines. |
| ```` ```mermaid ```` | Diagram |
| ```` ```math ```` | Display math |

## Include another document (1.6+)

```markdown
:::include{file="shared/terms.smd" section="Pricing" level=3}
See [Pricing](shared/terms.smd#pricing) in the shared terms.
:::
```

| Attribute | Meaning |
|---|---|
| `file` (needed) | The `.smd` document to include, relative to this one. Its body is used, without its front matter. |
| `section` | Only one section and its subsections: a heading's id (`pricing`) or its whole text in any case (`Pricing`). With `smd: 2` a part of the text matches nothing (v1 documents also match a part); prefer the id. |
| `level` | 1–6: the level the included top heading becomes, so it nests under the current heading (here `###` under a `##`). |

- Write shared text (terms, glossary, setup steps) once and include it instead of copying it.
- The body is **fallback text**, shown only where the file can't be included and by tools older than 1.6. Put a link to the file there.
- Paths inside the included file (links, images, code embeds, nested includes) stay relative to that file.
- Links in this document may point at included headings by id. An included heading whose id this document already uses is numbered (`#pricing-1`).
- Don't make include chains loop (`a.smd` → `b.smd` → `a.smd`); `smd validate` warns (`include/*`).

## Math

`$E=mc^2$` inline and `$$ … $$` for display math (KaTeX). No space just inside the `$`; `$5 and $10` is not math. Put a block's `$$` delimiters on lines of their own (in an `smd: 2` document only such lines open and close it).

## Diagrams

The first non-comment line must be a Mermaid type: `flowchart` (or `graph`), `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `journey`, `gantt`, `pie`, `quadrantChart`, `requirementDiagram`, `gitGraph`, `mindmap`, `timeline`, `sankey-beta`, `xychart-beta`, `block-beta`, `packet-beta`, `kanban`, `architecture-beta`, `C4Context`…

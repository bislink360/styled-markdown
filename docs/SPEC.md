# Styled Markdown (`.smd`) — Specification v1

Styled Markdown is a **strict superset of CommonMark + GitHub-Flavored Markdown**. It adds a small, validated vocabulary for styling, layout, diagrams, math and audience-aware content, so a single file works well for developers, product managers and AI agents.

- File extension: `.smd`
- Author: Roshan Alwis
- Media type (suggested): `text/x-styled-markdown`
- Encoding: UTF-8
- Spec version: `1` (declared in front matter as `smd: 1`)

---

## 1. Design principles

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| 1 | **Superset, never fork** | Every valid `.md` file is a valid `.smd` file with identical meaning. Rename `.md` → `.smd` and nothing breaks. |
| 2 | **Readable as plain text** | The raw source must still read well in a terminal, a diff, a code review or an LLM context window. No HTML soup, no opaque IDs. |
| 3 | **Borrow proven syntax** | Containers follow the *generic directives* proposal used by remark-directive, MyST and Docusaurus; attribute lists follow Pandoc; alerts map to GitHub alerts. Nothing is invented where a convention already exists. |
| 4 | **Semantic before presentational** | Prefer `:::warning` over red text. Colors are *named tokens* (`red`, `green`, `accent`) that adapt to light/dark themes instead of hard-coded hex. |
| 5 | **Validated** | Every extension has a schema. Tools can report precise, line-level errors with stable rule codes and machine-applicable fixes. |
| 6 | **Safe** | No scripts. Style attributes are whitelisted keys with whitelisted values, so documents cannot inject CSS or JavaScript. |
| 7 | **Graceful degradation** | Every `.smd` feature has a defined plain-Markdown fallback (`smd to-md`), e.g. callouts → GitHub alerts. |
| 8 | **Agent-addressable** | Front matter gives agents a summary and status up front; `:::agent` blocks carry instructions without cluttering the human view. |

---

## 2. Document structure

```text
┌─────────────────────────────┐
│ ---                         │  Optional YAML front matter
│ smd: 1                      │  (recommended)
│ title: …                    │
│ ---                         │
├─────────────────────────────┤
│ Markdown body               │  CommonMark + GFM
│   + containers  :::name     │  + Styled Markdown extensions
│   + inline      :name[…]{…} │
│   + spans       […]{…}      │
└─────────────────────────────┘
```

### 2.1 Front matter

A YAML mapping between `---` lines at the very start of the file. It is parsed with the YAML *core* schema, so `2026-09-26` stays a string.

| Key | Type | Meaning |
|-----|------|---------|
| `smd` | number | Spec version. **Recommended.** Currently `1`. |
| `title` | string | Document title. Rendered as the page heading — don't repeat it as `# H1`. |
| `summary` | string | 1–2 sentences. Agents should read this first. Inline Markdown allowed. |
| `status` | enum | `draft` · `review` · `approved` · `deprecated` · `archived` |
| `owners` | list | People or teams, e.g. `["@alice", "@platform"]` |
| `audience` | enum | `humans` · `agents` · `both` |
| `tags` | list | Free-form tags |
| `version` | string/number | Document version |
| `created`, `updated` | date | `YYYY-MM-DD` |
| `theme` | enum | Rendering hint: `auto` · `light` · `dark` |
| `accent` | color | Accent color for headings, links, badges (see §5) |
| `toc` | boolean | `true` renders a table of contents after the header |
| `related` | list | Paths or URLs of related documents |

Unknown keys are allowed and preserved (reported as *hints* so typos are caught).

The table is published as a JSON Schema: [`extension/schemas/smd-frontmatter.schema.json`](https://raw.githubusercontent.com/bislink360/styled-markdown/main/extension/schemas/smd-frontmatter.schema.json), also shipped on npm as `styled-markdown/frontmatter.schema.json`. The validator and editor completion read the same schema, and YAML tools or pipelines can use it to check document metadata.

A document is **stale** when `updated` is more than 180 days before today (tools may make this configurable) and `status` is not `archived` or `deprecated`.

---

## 3. Block containers

```text
:::name{attributes} Optional title
Any Markdown content, including other containers.
:::
```

- An opening fence is **three or more colons**, then a name (`[a-zA-Z][\w-]*`), then an optional attribute list `{…}` directly after the name, then an optional title.
- A closing fence is a line with **three or more colons and nothing else**.
- **Nesting**: a closing fence always closes the *innermost* open container. Colon count is cosmetic — authors may use more colons on outer containers (`::::tabs`) for readability, but it's not required.
- Fenced code blocks inside a container are opaque; a `:::` inside a code block never closes the container.
- An unclosed container extends to the end of its parent (and is a validation error).
- Titles support inline Markdown.

### 3.1 Container vocabulary

| Name | Purpose | Extra attributes |
|------|---------|------------------|
| `note` `info` `tip` `success` `warning` `danger` `question` | Callouts | `title`, `collapsible` (value `open` starts expanded) |
| `details` | Collapsible section; title = summary | `title`, `open` |
| `card` | Bordered card with accent stripe | `title`, `accent` |
| `box` | Generic block for style attributes | — |
| `tabs` → `tab` | Tab group; each `tab` title is its label | `title` (on `tab`) |
| `columns` → `column` | Side-by-side layout (stacks on narrow screens) | `width` (`30%` or ratio `2`) |
| `steps` | Renders the ordered list inside as numbered steps | — |
| `agent` | Content addressed to AI agents (instructions, constraints) | `title`, `priority` |
| `human` | Content addressed to human readers only | `title` |

| `decision` | Decision record (ADR-style); title = the decision | `status` (`proposed` `accepted` `rejected` `superseded` `deprecated`), `date`, `owner` |
| `risk` | Risk with mitigation in the body | `impact`, `likelihood` (`low` `medium` `high` `critical`), `owner`, `status` (`open` `mitigated` `accepted` `closed`) |
| `api` | API endpoint; body documents params/responses | **`method`** (`GET` `POST` `PUT` `PATCH` `DELETE` `HEAD` `OPTIONS` `WS` `RPC` `EVENT`), **`path`**, `auth` |
| `timeline` | Renders the list inside as a vertical timeline (tasks inside show done state) | — |

All containers additionally accept the style attributes in §5. Attributes in **bold** are required.
`tab` must be a direct child of `tabs`; `column` of `columns`.
Unknown container names render as a plain `box` and produce a warning.

### 3.2 Audience semantics

- **`:::agent`** — Agents MUST treat the content as instructions/constraints relevant to the document. Human-facing renderers SHOULD show it collapsed (configurable: collapsed / expanded / hidden).
- **`:::human`** — Agents MAY skip this content when extracting instructions; it's context for people.
- Everything else is for both audiences.

---

## 4. Inline syntax

### 4.1 Styled spans

```text
[text]{attributes}
```

A bracketed span immediately followed by an attribute list. Only style attributes (§5) are allowed. Content may contain other inline Markdown. Links (`[text](url)`) and images are unaffected because a styled span requires `{` directly after `]`.

### 4.2 Inline directives

```text
:name[content]{attributes}
```

The `:` must be at the start of a line or preceded by whitespace or opening punctuation, so `10:30` and `note:[x]` are never directives.

| Directive | Content | Attributes | Example |
|-----------|---------|------------|---------|
| `badge` | required | `color` | `:badge[Shipped]{color=green}` |
| `status` | required | `color` | `:status[At risk]{color=red}` |
| `kbd` | required (`+` separates keys) | — | `:kbd[Ctrl+Shift+P]` |
| `mention` | required | — | `:mention[@platform]` |
| `progress` | — | `value` (0–100), `color`, `label` | `:progress{value=60}` |
| `priority` | required: `P0`–`P4` or `critical` `high` `medium` `low` | — | `:priority[P1]` |
| `due` | required: `YYYY-MM-DD` | — | `:due[2026-10-15]` (overdue = red, ≤ 7 days = amber) |
| `metric` | required: the value | `label` (recommended), `delta`, `trend` (`up` `down` `flat`), `good` (`up` `down`) | `:metric[42%]{label="Activation" delta="+3%" trend=up}` |

### 4.2.1 Task metadata

A task item may carry an owner (`@name` or `:mention[…]`), `:priority[…]` and `:due[…]`. Tools extract these (`smd tasks`, `smd meta`), and open tasks past their due date produce a `task/overdue` info diagnostic.

```text
- [ ] Idempotent order creation :priority[P0] @api-team :due[2026-10-03]
```

### 4.2.2 Heading attributes

A heading may end with an attribute list: `## Title {#custom-id .class agent=skip}`.

- `#id` sets the anchor id.
- `agent=skip` marks the section (up to the next heading of the same or higher level) as **human-only**. Agent views omit it, and the preview shows a "humans only" tag.

### 4.3 Highlight

`==text==` renders highlighted text (`<mark>`).

### 4.4 Math

- Inline: `$E = mc^2$` — no whitespace just inside the `$`, and the closing `$` must not be followed by a digit (so `$5 and $10` is plain text).
- Display: a `$$ … $$` block, or a fenced block with language `math`.
- Syntax: LaTeX as supported by KaTeX.

### 4.5 Task lists

GFM task lists (`- [ ]`, `- [x]`). Renderers connected to an editor MAY make them toggleable.

---

## 5. Attributes

```text
{key=value key2="quoted value" .class #id flag}
```

- Values may be bare, `"double-quoted"` or `'single-quoted'`.
- `.class` adds a utility class (rendered as `smd-u-<class>`); `#id` sets the element id.
- A bare `flag` means `flag=true`.

### 5.1 Style attributes

| Key | Values |
|-----|--------|
| `color` | named color · `#hex` · `rgb()/rgba()/hsl()/hsla()` |
| `bg` | same as `color` (named colors become a soft tint) |
| `border` | same as `color` |
| `size` | `xs` `sm` `md` `lg` `xl` `2xl` |
| `weight` | `normal` `medium` `bold` |
| `font` | `sans` `serif` `mono` |
| `align` | `left` `center` `right` (blocks) |
| `style` | `italic` `underline` `strike` (space- or comma-separated) |

### 5.2 Named colors

`red` `orange` `amber` `yellow` `green` `teal` `cyan` `blue` `indigo` `purple` `pink` `gray` `muted` `accent`

Named colors are theme tokens: renderers choose values with adequate contrast for light and dark backgrounds. `accent` follows the document's `accent` front matter. **Prefer named colors**; use hex only for brand colors.

Any value outside these lists is a validation error and is dropped by the renderer.

---

## 6. Fenced code blocks

| Info string | Behaviour |
|-------------|-----------|
| `mermaid` | Rendered as a Mermaid diagram. The first non-comment line must be a Mermaid diagram type (`flowchart`, `sequenceDiagram`, `gantt`, `pie`, `erDiagram`, `stateDiagram-v2`, `classDiagram`, `mindmap`, `timeline`, `xychart-beta`, …). |
| `math` / `latex` / `katex` | Display math |
| `<lang> title="path/file.ext"` | Code block with a file-name header |
| `<lang> {2,5-7}` | Highlight lines 2 and 5–7 (combinable with `title`) |
| `<lang> file="../src/x.ts" lines="10-24"` | **Embed** a real file (or a line range) instead of the block body, which must be empty. Paths are relative to the document and must stay inside the workspace/document folder. With `lines`, highlight numbers refer to the file's line numbers. |
| anything else | Syntax-highlighted code |

---

## 7. Validation rules

Every diagnostic has a stable `code`, a severity and, when safe, a machine-applicable `fix`.

| Code | Severity | Trigger |
|------|----------|---------|
| `frontmatter/invalid` | error | YAML does not parse, or is not a mapping, or is unclosed |
| `frontmatter/version` | info / warning | `smd` missing (fix: add it) or unsupported |
| `frontmatter/unknown-key` | hint | Non-standard key (fix when a close match exists) |
| `frontmatter/status` · `/audience` · `/accent` · `/type` · `/date` | warning / error | Invalid values (fix: the one close allowed value or color, `true`/`false` for `yes`/`no`/`"true"`, `2026-09-05` for `2026/9/5`) |
| `frontmatter/duplicate-title` | hint | First `# H1` repeats the front matter title |
| `frontmatter/value` | warning | A value outside the schema's allowed values for keys without their own rule (e.g. `theme`; fix when one allowed value is close) |
| `frontmatter/stale` | info | `updated` is older than the stale threshold and the document is not archived or deprecated |
| `container/unknown` | warning | Unknown container name (fix: closest name) |
| `container/unclosed` | error | Missing closing `:::` (fix: add it at the end of the document, for an unindented container) |
| `container/stray-close` | warning | `:::` with nothing open |
| `container/parent` | warning | `tab` outside `tabs`, `column` outside `columns` |
| `attrs/syntax` | error | Malformed `{…}` |
| `attrs/unknown` | warning | Attribute not accepted in this position (fix when one accepted name is close and not already set) |
| `attrs/value` | error | Invalid color, size, width, progress value… (fix when one allowed value is close, or a year-first date needs `-` separators) |
| `directive/unknown` | warning | `:name[…]` close to a known directive (fix: closest name) |
| `directive/content` | error | Directive needs `[content]` |
| `mermaid/type` · `mermaid/empty` | error / warning | Unknown diagram type (fix: closest type) / empty diagram |
| `mermaid/syntax` | warning | The diagram does not parse (checked with Mermaid's own parser where the tool ships it) |
| `math/syntax` · `math/unclosed` | error | KaTeX parse error / unclosed `$$` |
| `fence/unclosed` | error | Unclosed code fence (fix: add it at the end of the document, for an unindented fence) |
| `link/missing-anchor` | warning | `[x](#id)` or `[x](other.smd#id)` with no heading or element with that id (fix: closest id) |
| `link/missing-file` | warning | Relative link, image, reference definition, HTML `href`/`src` or `related:` entry does not exist |
| `link/undefined-reference` | warning | `[text][label]` or `[label][]` with no `[label]: …` definition |
| `attrs/required` | error / warning | Required attribute missing (`:::api` needs `method` and `path`; `:metric` should have `label`) |
| `fence/embed-missing` · `fence/range` · `fence/embed-body` · `fence/lines-without-file` | error / warning | Embedded file missing or outside the workspace, bad line range, non-empty embed body, `lines` without `file` |
| `task/overdue` | info | Open task past its `:due[…]` date |
| `rules/unknown` | warning | A suppression comment names an unknown rule code (fix: closest code) |

Tools must let users change these defaults. A `smd.config.json`, `.smdrc` or `.smdrc.json` file in the document's folder or a parent folder has `{"rules": {"<code>" | "<category>/*" | "*": "off" | "error" | "warning" | "info" | "hint"}}`. The nearest file applies, the search stops at the repository root, and the most specific key wins. Inside a document, the comments `<!-- smd-disable-next-line [codes] -->`, `<!-- smd-disable-line [codes] -->` and `<!-- smd-disable [codes] -->` … `<!-- smd-enable [codes] -->` silence rules. No codes means every rule. Codes are separated by spaces or commas and may be `category/*`.

---

## 8. Degradation to plain Markdown

| `.smd` | Plain Markdown (`smd to-md`) |
|--------|------------------------------|
| `:::note/info` | `> [!NOTE]` |
| `:::tip/success` | `> [!TIP]` |
| `:::question` | `> [!IMPORTANT]` |
| `:::warning` | `> [!WARNING]` |
| `:::danger` | `> [!CAUTION]` |
| `:::agent` / `:::human` | `> [!NOTE]` with **For agents / For humans** label |
| `:::details` | `<details><summary>` |
| `:::card` | blockquote with bold title |
| `:::tab Title` | **Title** paragraph followed by content |
| `box`, `columns`, `steps` | content only |
| `[text]{…}` | `text` (bold/italic/strike preserved from `weight`/`style`) |
| `:badge[x]` | `` `x` `` |
| `:status[x]{color=green}` | `🟢 x` |
| `:progress{value=60}` | `▰▰▰▰▰▰▱▱▱▱ 60%` |
| `:kbd[Ctrl+S]` | `<kbd>Ctrl</kbd>+<kbd>S</kbd>` |
| `==x==` | `**x**` |
| Mermaid, math, tables, tasks | unchanged (GitHub renders them) |

---

## 8a. Agent view (token-efficient reading)

The *agent view* is a canonical, lossless-in-meaning rendering for LLMs (`smd agent`):

| Source | Agent view |
|---|---|
| Front matter | `# title`, one `key: value · …` line, `summary:` line (`smd`, `theme`, `accent`, `toc` dropped) |
| Headings | Text plus `[L<n>]` source line reference; attribute lists removed |
| `{agent=skip}` sections, `:::human` | Omitted |
| `:::agent` | `<agent-instructions title="…">…</agent-instructions>` (always included, even when other sections are filtered out) |
| Callouts | `<warning title="…">…</warning>` etc. |
| `decision` / `risk` | `<decision status= date= owner=> title …</decision>` / `<risk impact= likelihood= …>` |
| `api` | `API POST /v1/x — title (auth: …)` |
| Tabs / cards | `Tab "name":` / `Title:` label lines; other layout containers vanish |
| Styling, badges, status, metrics | Plain words: `[Beta]`, `[status: On track (ok)]`, `Activation: 42% (+3%)`, `(due 2026-10-01, OVERDUE)` |
| Images, HTML comments | `[image: alt]`, removed |
| Tables | Cell padding removed |
| File embeds | `[code: path lines a-b — read that file]` (or inlined with `--embed`) |

`--brief` also condenses Mermaid diagrams to `[diagram: type, n lines — see Lx-Ly]`, long code blocks to their first 10 lines, `:::details` to a pointer, and completed tasks to a count.

## 9. Security model

- Raw HTML is permitted in source (as in Markdown) but hosts MUST NOT execute scripts from documents. The VS Code preview enforces a nonce-based Content Security Policy.
- Style attributes are converted to CSS only through the whitelist in §5; unknown keys and invalid values are dropped.
- Mermaid runs with `securityLevel: 'strict'`.

## 10. Versioning

Additive features (new containers, directives, front matter keys) keep `smd: 1`; older renderers degrade gracefully (unknown containers render as a box, unknown keys are kept). Only breaking changes increment `smd`.

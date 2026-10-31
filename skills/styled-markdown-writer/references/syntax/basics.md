# Basics: front matter, blocks, headings, audience

Part of the syntax reference (`../syntax.md` lists the topics). Everything in CommonMark + GitHub-Flavored Markdown is valid.

## Front matter

```yaml
---
smd: 2                       # the spec version: 2 for new documents; 1 (or no key) keeps the v1 rules
title: Saved Searches        # rendered as the page title; don't repeat as "# H1"
summary: One or two sentences. Agents read this first.
status: draft                # draft | review | approved | deprecated | archived
owners: ["@alice", "@team"]  # list
audience: both               # humans | agents | both
tags: [search, q4]           # list
version: 0.3
created: 2026-09-01          # YYYY-MM-DD
updated: 2026-09-26          # YYYY-MM-DD
theme: auto                  # auto | light | dark (preview hint)
accent: indigo               # named color or #hex for headings/links
toc: true                    # table of contents after the header
related: [docs/other.smd]    # list of paths/URLs
lang: de                     # optional: language of rendered labels (de es fr ja pt zh; default English)
typography: true             # optional, smd: 2 only: curly quotes, dashes, ellipses (v1 always has them)
---
```

`lang` changes only the words the renderer adds (callout titles, "Figure 2", "overdue", status names); the document's text, the agent view and `smd export --to md` are unchanged. Set it when the document is written in that language.

Unknown keys are allowed (reported as hints, except keys the text shows with `{{key}}`, see `inline.md`).

What `smd: 2` changes is in `spec-v2.md`.

## Block containers: general rules

```text
:::name{attributes} Optional title
content (any Markdown, including other blocks)
:::
```

- Open with 3+ colons, the name, optional `{attrs}` **immediately** after the name, then an optional title (inline Markdown allowed).
- Close with a line of 3+ colons and nothing else. It closes the **innermost** open block. In a document with `smd: 2` it closes the innermost block opened with **as many colons**, so write every closing fence with its opener's colons (as `smd fmt` does).
- Nesting works at any depth. Writing outer blocks with more colons (`::::tabs`) is a readability convention.
- A `:::` inside a code fence or `$$` display math never closes a block.
- Every block also accepts the style attributes listed in `inline.md` (Attribute lists and colors).

## Headings

```markdown
## Background {agent=skip}
## Installation {#install}
## Summary {.lead}
```

`agent=skip` omits the section, up to the next heading of the same or higher level, from agent views. It's the only allowed `agent` value. Keep `:::agent` blocks out of such sections: they would be omitted too (`container/agent-in-skip` warns).

## Audience blocks: agent, human

```markdown
:::agent Implementation constraints
- Imperative, checkable rules for implementers and coding agents.
:::

:::human Why this matters
Context for people only. Agents skip it.
:::
```

`:::agent` is collapsed for humans in the preview and **always** included in agent views, even when only one section is requested.

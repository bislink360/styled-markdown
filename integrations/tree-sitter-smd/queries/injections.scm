; Styled Markdown (.smd) injections.
;
; Markdown: every line the .smd grammar does not parse itself, as one combined document, so
; paragraphs, lists and headings work across lines. The .smd constructs inside a line (directives,
; spans, math, variables, attribute lists, task boxes…) are named children, which injections leave
; out, so Markdown never sees .smd syntax. Container fences, front matter, fenced code and $$ math
; are not lines and are left out too. Markdown injects markdown_inline into its own inline nodes.
([
  (line)
  (blank_line)
] @injection.content
  (#set! injection.language "markdown")
  (#set! injection.combined))

; Container titles hold inline Markdown. They are injected as markdown (block) rather than
; markdown_inline, whose name differs between editors (Helix calls it markdown.inline).
((container_title) @injection.content
  (#set! injection.language "markdown"))

((front_matter_content) @injection.content
  (#set! injection.language "yaml"))

; $math$ and $$ … $$ blocks.
((math_content) @injection.content
  (#set! injection.language "latex"))

; Fenced code by the first word of its info string; math fences are LaTeX. Mermaid needs a
; mermaid parser (nvim-treesitter has one); languages an editor doesn't have stay plain.
(fenced_code_block
  (info_string
    (language) @_language)
  (code_content) @injection.content
  (#any-of? @_language "math" "latex" "katex" "tex")
  (#set! injection.language "latex"))

(fenced_code_block
  (info_string
    (language) @injection.language)
  (code_content) @injection.content
  (#not-any-of? @injection.language "math" "latex" "katex" "tex"))

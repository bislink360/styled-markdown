; Styled Markdown (.smd) highlights.
;
; These cover the syntax .smd adds. Markdown itself (headings, emphasis, links, lists…) is
; highlighted by the injected markdown and markdown_inline grammars (see injections.scm).
; Capture names follow nvim-treesitter; Helix and Zed read the same names. Patterns never capture
; the same node twice, so they work whichever pattern order an editor gives precedence to.
;
; The known container and directive names below must match extension/src/core/spec.ts
; (CONTAINERS and INLINE_DIRECTIVES); extension/test/treeSitter.test.ts checks that they do.
; Names that are not known still parse and are highlighted as @tag / @function.

; ---------------------------------------------------------------- front matter

(front_matter_delimiter) @punctuation.delimiter

; ---------------------------------------------------------------- containers

(container_fence) @punctuation.special

((container_name) @tag.builtin
  (#any-of? @tag.builtin
    "note" "info" "tip" "success" "warning" "danger" "question"
    "details" "card" "box" "tabs" "tab" "columns" "column" "steps"
    "agent" "human" "include" "decision" "risk" "risk-matrix" "timeline"
    "changelog" "figure" "quote" "glossary" "api"))

((container_name) @tag
  (#not-any-of? @tag
    "note" "info" "tip" "success" "warning" "danger" "question"
    "details" "card" "box" "tabs" "tab" "columns" "column" "steps"
    "agent" "human" "include" "decision" "risk" "risk-matrix" "timeline"
    "changelog" "figure" "quote" "glossary" "api"))

(container_title) @markup.heading

; ---------------------------------------------------------------- attribute lists

(attribute_list
  [
    "{"
    "}"
  ] @punctuation.bracket)

(attribute_name) @attribute

(attribute
  "=" @operator)

(attribute_value) @string

(attribute_id) @label

(attribute_class) @type

; ---------------------------------------------------------------- inline directives

(directive
  ":" @punctuation.special)

((directive_name) @function.builtin
  (#any-of? @function.builtin
    "badge" "kbd" "progress" "mention" "status" "priority" "due" "metric" "ref"))

((directive_name) @function
  (#not-any-of? @function
    "badge" "kbd" "progress" "mention" "status" "priority" "due" "metric" "ref"))

(directive
  [
    "["
    "]"
  ] @punctuation.bracket)

(directive_content) @string

; ---------------------------------------------------------------- styled spans, highlight

(span
  [
    "["
    "]"
  ] @punctuation.bracket)

(span_content) @markup.italic

(mark
  "==" @punctuation.delimiter)

(mark_content) @diff.plus

; ---------------------------------------------------------------- math

(math_block
  (math_delimiter) @punctuation.delimiter)

(inline_math
  "$" @punctuation.delimiter)

(math_content) @markup.math

; ---------------------------------------------------------------- variables, footnotes, tasks

(variable
  [
    "{{"
    "}}"
  ] @punctuation.special)

(variable_name) @constant

[
  (footnote_reference)
  (footnote_label)
] @markup.link.label

(task_checked) @markup.list.checked

(task_unchecked) @markup.list.unchecked

; ---------------------------------------------------------------- code

(code_span) @markup.raw

(code_fence_delimiter) @punctuation.delimiter

(info_string
  (language) @label)

(code_content) @markup.raw.block

package com.bislink360.smd

import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/**
 * The Styled Markdown language server's requests beyond LSP. `smd/renderHtml` (extension/src/lsp.ts, announced as
 * `experimental.smdRenderHtml`) renders a document as the page `smd export --to html` writes, for the preview.
 */
interface SmdLanguageServerApi : LanguageServer {
    @JsonRequest("smd/renderHtml")
    fun renderHtml(params: RenderHtmlParams): CompletableFuture<RenderHtmlResult>
}

/** The document, its current text (unsaved edits too) and the theme for a page whose front matter names none. */
data class RenderHtmlParams(val textDocument: TextDocumentIdentifier, val text: String, val theme: String)

class RenderHtmlResult {
    var html: String? = null
}

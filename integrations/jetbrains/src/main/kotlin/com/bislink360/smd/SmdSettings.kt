package com.bislink360.smd

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/** The plugin's settings, for every project: Settings | Languages & Frameworks | Styled Markdown. */
@Service(Service.Level.APP)
@State(name = "StyledMarkdownSettings", storages = [Storage("styled-markdown.xml")])
class SmdSettings : SimplePersistentStateComponent<SmdSettings.Settings>(Settings()) {
    class Settings : BaseState() {
        /** The Node.js executable; empty for `node` on the PATH. */
        var nodePath by string("")

        /** The `smd` CLI script to run; empty for the one shipped with the plugin. */
        var cliPath by string("")

        /** The browser that prints Export to PDF; empty to let the CLI find one. */
        var browserPath by string("")

        /** The paper size of Export to PDF: A4 or Letter. */
        var pdfFormat by string("A4")

        /** Export to PDF in landscape. */
        var pdfLandscape by property(false)
    }

    var nodePath: String
        get() = state.nodePath.orEmpty()
        set(value) {
            state.nodePath = value.trim()
        }

    var cliPath: String
        get() = state.cliPath.orEmpty()
        set(value) {
            state.cliPath = value.trim()
        }

    var browserPath: String
        get() = state.browserPath.orEmpty()
        set(value) {
            state.browserPath = value.trim()
        }

    var pdfFormat: String
        get() = state.pdfFormat?.takeIf { it in PDF_FORMATS } ?: PDF_FORMATS.first()
        set(value) {
            state.pdfFormat = value
        }

    var pdfLandscape: Boolean
        get() = state.pdfLandscape
        set(value) {
            state.pdfLandscape = value
        }

    companion object {
        /** The paper sizes of `smd export --to pdf --format`. */
        val PDF_FORMATS = listOf("A4", "Letter")

        fun getInstance(): SmdSettings = service()
    }
}

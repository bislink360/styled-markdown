package com.bislink360.smd

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/** Settings | Languages & Frameworks | Styled Markdown: which Node.js and which `smd` CLI run the server. */
class SmdConfigurable : BoundConfigurable("Styled Markdown") {
    private val settings = SmdSettings.getInstance()

    override fun createPanel(): DialogPanel = panel {
        row("Node.js executable:") {
            textField()
                .bindText(settings::nodePath)
                .columns(COLUMNS_LARGE)
                .comment("Empty: <code>node</code> on the PATH. Node.js 22 or newer.")
        }
        row("smd CLI script:") {
            textField()
                .bindText(settings::cliPath)
                .columns(COLUMNS_LARGE)
                .comment(
                    "Empty: the CLI shipped with the plugin. To check Mermaid syntax too, point it at the npm " +
                        "package's <code>dist/cli.js</code> (<code>npm install -g styled-markdown</code>).",
                )
        }
    }

    override fun apply() {
        super.apply()
        SmdLspServerSupportProvider.restartAll()
    }
}

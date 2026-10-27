package com.bislink360.smd

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/** Settings | Languages & Frameworks | Styled Markdown: which Node.js and `smd` CLI run the server, and how PDFs print. */
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
        group("Export to PDF") {
            row("Browser:") {
                textField()
                    .bindText(settings::browserPath)
                    .columns(COLUMNS_LARGE)
                    .comment(
                        "Empty: an installed Google Chrome, Microsoft Edge, Chromium or Brave (or Playwright or " +
                            "Puppeteer, if installed). Set it to a Chromium-based browser's executable to use that one.",
                    )
            }
            row("Paper size:") {
                comboBox(SmdSettings.PDF_FORMATS)
                    .bindItem({ settings.pdfFormat }, { settings.pdfFormat = it ?: SmdSettings.PDF_FORMATS.first() })
            }
            row {
                checkBox("Landscape").bindSelected(settings::pdfLandscape)
            }
        }
    }

    override fun apply() {
        super.apply()
        SmdLspServerSupportProvider.restartAll()
    }
}

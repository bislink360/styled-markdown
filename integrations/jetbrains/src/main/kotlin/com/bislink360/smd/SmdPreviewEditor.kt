// LspServer is the pre-2026.1.4 name, the only one 2025.x has (see SmdLspServerSupportProvider).
@file:Suppress("DEPRECATION")

package com.bislink360.smd

import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import org.eclipse.lsp4j.TextDocumentIdentifier
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.SwingConstants

/**
 * The live preview beside a `.smd` file: the page `smd export --to html` writes, rendered by the language server
 * (`smd/renderHtml`) from the editor's current text, in the IDE's embedded browser. It renders again shortly after
 * each edit and when the IDE switches between light and dark, and keeps the scroll position. Links open in the
 * system browser; relative images and links resolve from the document's folder.
 */
class SmdPreviewEditor(private val project: Project, private val file: VirtualFile) : UserDataHolderBase(), FileEditor {
    private val document: Document? = FileDocumentManager.getInstance().getDocument(file)
    private val browser: JBCefBrowser? = if (JBCefApp.isSupported()) JBCefBrowser() else null
    private val scrollQuery: JBCefJSQuery? = browser?.let { JBCefJSQuery.create(it as JBCefBrowserBase) }
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private val view: JComponent = browser?.component ?: JBLabel(
        "<html><center>The Styled Markdown preview needs the IDE's embedded browser (JCEF), which is not available.<br>" +
            "Use <b>Open Styled Markdown Preview in Browser</b> instead.</center></html>",
        SwingConstants.CENTER,
    )

    @Volatile private var scrollY = 0
    @Volatile private var waits = 0
    @Volatile private var disposed = false

    init {
        if (browser != null) {
            Disposer.register(this, browser)
            browser.setOpenLinksInExternalBrowser(true)
            scrollQuery?.let { query ->
                Disposer.register(this, query)
                query.addHandler { y -> scrollY = y.toDoubleOrNull()?.toInt() ?: scrollY; null }
            }
            document?.addDocumentListener(object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) = schedule(RENDER_DELAY_MS)
            }, this)
            ApplicationManager.getApplication().messageBus.connect(this)
                .subscribe(LafManagerListener.TOPIC, LafManagerListener { schedule(0) })
            schedule(0)
        }
    }

    private fun schedule(delayMs: Int) {
        if (disposed) return
        alarm.cancelAllRequests()
        alarm.addRequest(::render, delayMs)
    }

    private fun render() {
        val text = ReadAction.compute<String?, RuntimeException> { document?.text } ?: return
        val server = SmdLspServerSupportProvider.runningServer(project)
        if (server == null) {
            when {
                SmdPlugin.node() == null -> show(message("The preview is rendered by the Styled Markdown language server, which needs Node.js 22 or newer. Set its path in Settings | Languages &amp; Frameworks | Styled Markdown."))
                waits++ < SERVER_WAITS -> { show(message("Starting the Styled Markdown language server…")); schedule(1000) }
                else -> show(message("The Styled Markdown language server is not running. The language server widget in the status bar shows its state and log."))
            }
            return
        }
        waits = 0
        val uri = runCatching { file.toNioPath().toUri().toString() }.getOrElse { file.url }
        val params = RenderHtmlParams(TextDocumentIdentifier(uri), text, if (JBColor.isBright()) "light" else "dark")
        val html = try {
            server.sendRequestSync(RENDER_TIMEOUT_MS) { (it as SmdLanguageServerApi).renderHtml(params) }?.html
        } catch (e: Exception) {
            return show(message("The preview could not be rendered: ${StringUtil.escapeXmlEntities(e.message ?: e.toString())}"))
        } ?: return
        show(keepScroll(html), uri)
    }

    /** The page with a script that restores the scroll position and reports it when it changes. */
    private fun keepScroll(html: String): String {
        val report = scrollQuery?.inject("String(window.scrollY)") ?: ""
        val script = "<script>(function(){var y=$scrollY;function go(){if(y)window.scrollTo(0,y);}go();" +
            "addEventListener('load',go);var t;addEventListener('scroll',function(){clearTimeout(t);" +
            "t=setTimeout(function(){$report},100);},{passive:true});})();</script>"
        val end = html.lastIndexOf("</body>")
        return if (end < 0) html + script else html.substring(0, end) + script + html.substring(end)
    }

    private fun message(text: String): String {
        val (fg, bg) = if (JBColor.isBright()) "#555" to "#fff" else "#bbb" to "#2b2d30"
        return "<!DOCTYPE html><html><body style=\"font-family:system-ui,sans-serif;color:$fg;background:$bg;padding:2em\">$text</body></html>"
    }

    private fun show(html: String, url: String = "about:blank") {
        ApplicationManager.getApplication().invokeLater({ if (!disposed) browser?.loadHTML(html, url) }, ModalityState.any())
    }

    override fun getComponent(): JComponent = view
    override fun getPreferredFocusedComponent(): JComponent? = null
    override fun getName(): String = "Preview"
    override fun getFile(): VirtualFile = file
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = false
    override fun isValid(): Boolean = file.isValid
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun dispose() {
        disposed = true
    }

    private companion object {
        const val RENDER_DELAY_MS = 300
        const val RENDER_TIMEOUT_MS = 10_000
        const val SERVER_WAITS = 60
    }
}

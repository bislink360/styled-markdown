package com.bislink360.smd

import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.io.FileUtil
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText

/**
 * Renders the current `.smd` file with `smd export --to html` and opens the page in the browser. The page is
 * written to a temporary folder, so relative image paths are made absolute to keep images showing.
 */
class OpenPreviewInBrowserAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabledAndVisible = file != null && file.isSmd() && file.isInLocalFileSystem
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val document = FileDocumentManager.getInstance().getDocument(file)
        if (document != null) FileDocumentManager.getInstance().saveDocument(document)
        val source = Path.of(file.path)
        object : Task.Backgroundable(project, "Rendering ${file.name}", false) {
            override fun run(indicator: ProgressIndicator) {
                val out = FileUtil.createTempDirectory("smd-preview", null).toPath().resolve("${file.nameWithoutExtension}.html")
                val command = SmdPlugin.command(source.parent, "export", source.toString(), "--to", "html", "-o", out.toString())
                if (command == null) return fail(project, "Node.js or the smd CLI was not found. Check the Styled Markdown settings.")
                val result = CapturingProcessHandler(command).runProcess(60_000)
                if (result.exitCode != 0 || result.isTimeout) {
                    return fail(project, result.stderr.ifBlank { result.stdout }.ifBlank { "smd export exited with ${result.exitCode}" })
                }
                out.writeText(absoluteImages(out.readText(), source.parent))
                BrowserUtil.browse(out.toFile())
            }
        }.queue()
    }

    private fun fail(project: Project, message: String) {
        NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
            .createNotification("Styled Markdown preview failed", message.take(2000), NotificationType.ERROR)
            .notify(project)
    }

    companion object {
        private val RELATIVE_SRC = Regex("""(<img\b[^>]*?\bsrc=")(?![a-zA-Z][a-zA-Z0-9+.-]*:|/|#)([^"]+)"""")

        /** The page with each `<img src>` that is relative to the document made absolute (a file: URL). */
        fun absoluteImages(html: String, documentFolder: Path): String =
            RELATIVE_SRC.replace(html) { m ->
                // The renderer percent-encodes link targets (`a b.png` is `a%20b.png`); the URI's path decodes them.
                val path = runCatching { java.net.URI(m.groupValues[2]).path }.getOrNull()
                if (path.isNullOrEmpty()) m.value else m.groupValues[1] + documentFolder.resolve(path).toUri().toString()
            }
    }
}

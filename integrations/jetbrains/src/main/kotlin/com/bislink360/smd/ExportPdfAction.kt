package com.bislink360.smd

import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.nio.file.Path

/**
 * Exports the current `.smd` file to PDF with `smd export --to pdf`: the CLI renders the page and prints it with
 * a headless browser (the one in the settings, else Playwright or Puppeteer, else an installed Chrome, Edge,
 * Chromium or Brave). Diagrams print as vectors; collapsed blocks are expanded.
 */
class ExportPdfAction : AnAction() {
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
        val descriptor = FileSaverDescriptor("Export to PDF", "Choose where to save the PDF", "pdf")
        val target = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
            .save(file.parent, "${file.nameWithoutExtension}.pdf") ?: return
        val out = target.file.toPath()
        object : Task.Backgroundable(project, "Exporting ${out.fileName}", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                val command = SmdPlugin.command(source.parent, *arguments(source, out, SmdSettings.getInstance()).toTypedArray())
                    ?: return notify(project, "Node.js or the smd CLI was not found. Check the Styled Markdown settings.", NotificationType.ERROR)
                val result = CapturingProcessHandler(command).runProcess(TIMEOUT_MS)
                if (result.isTimeout) return notify(project, "smd export did not finish within ${TIMEOUT_MS / 1000} s.", NotificationType.ERROR)
                if (result.exitCode != 0) {
                    return notify(project, result.stderr.ifBlank { result.stdout }.ifBlank { "smd export exited with ${result.exitCode}" }, NotificationType.ERROR)
                }
                LocalFileSystem.getInstance().refreshNioFiles(listOf(out))
                // "Wrote …/plan.pdf (printed with Google Chrome)", plus any warning before it.
                val printedWith = PRINTED_WITH.find(result.stderr)?.groupValues?.get(1)?.let { " (printed with $it)" }.orEmpty()
                NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
                    .createNotification("Exported ${out.fileName}$printedWith", NotificationType.INFORMATION)
                    .addAction(NotificationAction.createSimpleExpiring("Open") { BrowserUtil.browse(out.toUri()) })
                    .notify(project)
            }
        }.queue()
    }

    private fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
            .createNotification("Styled Markdown export to PDF failed", message.take(2000), type)
            .notify(project)
    }

    companion object {
        /** Long enough for a large document whose diagrams load from the CDN (the CLI waits up to 60 s twice). */
        private const val TIMEOUT_MS = 180_000

        private val PRINTED_WITH = Regex("""\(printed with (.+)\)\s*$""")

        /** The `smd` arguments: the document, the PDF, and the paper and browser from the settings. */
        fun arguments(source: Path, out: Path, settings: SmdSettings): List<String> = buildList {
            addAll(listOf("export", source.toString(), "--to", "pdf", "-o", out.toString(), "--format", settings.pdfFormat))
            if (settings.pdfLandscape) add("--landscape")
            if (settings.browserPath.isNotBlank()) addAll(listOf("--browser", settings.browserPath))
        }
    }
}

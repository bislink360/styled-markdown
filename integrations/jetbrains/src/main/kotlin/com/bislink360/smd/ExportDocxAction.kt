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
 * Exports the current `.smd` file to a Word document with `smd export --to docx`: converted by Pandoc when it is
 * set or on the PATH, else written by the CLI's built-in writer, so it works with nothing to install. The file
 * opens in Word, LibreOffice, Pages and Google Docs.
 */
class ExportDocxAction : AnAction() {
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
        val descriptor = FileSaverDescriptor("Export to Word", "Choose where to save the Word document", "docx")
        val target = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
            .save(file.parent, "${file.nameWithoutExtension}.docx") ?: return
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
                // Warnings (images that could not be embedded) come before "Wrote …".
                val warnings = result.stderr.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("Wrote ") }
                val note = if (warnings.isEmpty()) "" else "\n${warnings.joinToString("\n").take(1000)}"
                NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
                    .createNotification("Exported ${out.fileName}${engineNote(result.stderr)}", note,
                        if (warnings.isEmpty()) NotificationType.INFORMATION else NotificationType.WARNING)
                    .addAction(NotificationAction.createSimpleExpiring("Open") { BrowserUtil.browse(out.toUri()) })
                    .notify(project)
            }
        }.queue()
    }

    private fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
            .createNotification("Styled Markdown export to Word failed", message.take(2000), type)
            .notify(project)
    }

    companion object {
        /** Pandoc on a large document, or many images, can take a while. */
        private const val TIMEOUT_MS = 120_000

        private val WRITTEN_BY = Regex("""\((written by the built-in writer|converted with .+)\)\s*$""")

        /** " (converted with /usr/bin/pandoc)" or " (written by the built-in writer)", from the CLI's last line. */
        fun engineNote(stderr: String): String = WRITTEN_BY.find(stderr.trim())?.groupValues?.get(1)?.let { " ($it)" }.orEmpty()

        /** The `smd` arguments: the document, the .docx, and the engine and Pandoc from the settings. */
        fun arguments(source: Path, out: Path, settings: SmdSettings): List<String> = buildList {
            addAll(listOf("export", source.toString(), "--to", "docx", "-o", out.toString()))
            if (settings.docxEngine != SmdSettings.DOCX_ENGINES.first()) addAll(listOf("--engine", settings.docxEngine))
            if (settings.pandocPath.isNotBlank()) addAll(listOf("--pandoc", settings.pandocPath))
        }
    }
}

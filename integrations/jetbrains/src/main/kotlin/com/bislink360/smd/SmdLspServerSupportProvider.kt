// The pre-2026.1.4 LSP API names are deprecated in newer IDEs but are the only ones 2025.x has (see below).
@file:Suppress("DEPRECATION")

package com.bislink360.smd

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Starts the Styled Markdown language server (`smd lsp`, docs/EDITORS.md) when a `.smd` file opens. The server
 * gives diagnostics with quick fixes, completion, hover, go to definition, the outline, workspace symbols and
 * formatting; the IDE's LSP support shows them.
 *
 * This uses the LSP API's provider and descriptor classes as named before 2026.1.4 (LspServerSupportProvider,
 * ProjectWideLspServerDescriptor), which every IDE from 2025.1 on has; later IDEs keep them as deprecated aliases.
 */
class SmdLspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(project: Project, file: VirtualFile, serverStarter: LspServerSupportProvider.LspServerStarter) {
        if (!file.isSmd()) return
        if (SmdPlugin.node() == null) {
            warnNoNode(project)
            return
        }
        serverStarter.ensureServerStarted(SmdLspServerDescriptor(project))
    }

    companion object {
        private val warned = AtomicBoolean(false)

        /** Restart the server in every open project, after the settings change. */
        fun restartAll() {
            warned.set(false)
            for (project in ProjectManager.getInstance().openProjects) {
                LspServerManager.getInstance(project).stopAndRestartIfNeeded(SmdLspServerSupportProvider::class.java)
            }
        }

        /** Once per session: the server needs Node.js, and none was found. */
        private fun warnNoNode(project: Project) {
            if (!warned.compareAndSet(false, true)) return
            NotificationGroupManager.getInstance().getNotificationGroup(SmdPlugin.NOTIFICATIONS)
                .createNotification(
                    "Styled Markdown needs Node.js",
                    "The Styled Markdown language server runs on Node.js 22 or newer, which was not found on the PATH. " +
                        "Install it, or set its path in the Styled Markdown settings. Highlighting works without it.",
                    NotificationType.WARNING,
                )
                .addAction(NotificationAction.createSimpleExpiring("Open settings") {
                    ShowSettingsUtil.getInstance().showSettingsDialog(project, SmdConfigurable::class.java)
                })
                .notify(project)
        }
    }
}

private class SmdLspServerDescriptor(project: Project) : ProjectWideLspServerDescriptor(project, "Styled Markdown") {
    override fun isSupportedFile(file: VirtualFile): Boolean = file.isSmd()

    override fun createCommandLine(): GeneralCommandLine {
        val root = project.basePath?.let { java.nio.file.Path.of(it) }
        return SmdPlugin.command(root, "lsp", "--stdio")
            ?: throw ExecutionException("Styled Markdown: Node.js or the smd CLI (${SmdPlugin.cli()}) was not found")
    }
}

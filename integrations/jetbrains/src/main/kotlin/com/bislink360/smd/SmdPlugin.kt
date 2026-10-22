package com.bislink360.smd

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path
import kotlin.io.path.exists

/** Where the plugin's files are, and how it runs the `smd` CLI it ships. */
object SmdPlugin {
    const val ID = "com.bislink360.styled-markdown"
    const val NOTIFICATIONS = "Styled Markdown"

    /** The plugin's folder: its jar in lib/, the server in server/, the TextMate bundle in bundle/. */
    val directory: Path
        get() = PluginManagerCore.getPlugin(PluginId.getId(ID))?.pluginPath
            ?: error("The Styled Markdown plugin is not loaded")

    /** The TextMate bundle made from the VS Code extension's grammar (see build.gradle.kts). */
    val bundle: Path get() = directory.resolve("bundle")

    /** The `smd` CLI shipped with the plugin: one self-contained file, the same as the agent skills bundle. */
    val bundledCli: Path get() = directory.resolve("server").resolve("smd.cjs")

    /** The CLI to run: the one set in Settings | Languages & Frameworks | Styled Markdown, else the bundled one. */
    fun cli(): Path = SmdSettings.getInstance().cliPath.takeIf { it.isNotBlank() }?.let(Path::of) ?: bundledCli

    /** The Node.js executable: the one set in the settings, else `node` on the PATH (null when there is none). */
    fun node(): String? {
        val configured = SmdSettings.getInstance().nodePath.trim()
        if (configured.isNotEmpty()) return configured
        return PathEnvironmentVariableUtil.findExecutableInPathOnAnyOS("node")?.path
    }

    /** `node <cli> <args>`, run in [workDirectory]; null when Node.js or the CLI can't be found. */
    fun command(workDirectory: Path?, vararg args: String): GeneralCommandLine? {
        val node = node() ?: return null
        val cli = cli()
        if (!cli.exists()) return null
        return GeneralCommandLine(node, cli.toString(), *args)
            .withCharset(Charsets.UTF_8)
            .withWorkingDirectory(workDirectory)
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
    }
}

/** A Styled Markdown file: the `.smd` extension, as in the VS Code extension. */
fun VirtualFile.isSmd(): Boolean = !isDirectory && extension == "smd"

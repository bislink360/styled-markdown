package com.bislink360.smd

import org.jetbrains.plugins.textmate.api.TextMateBundleProvider

/**
 * Highlighting: the VS Code extension's TextMate grammar (extension/syntaxes), as a VS Code-style bundle in the
 * plugin's bundle/ folder. It includes the IDE's own Markdown and YAML TextMate bundles for the text around the
 * `.smd` syntax and for front matter.
 */
class SmdTextMateBundleProvider : TextMateBundleProvider {
    override fun getBundles(): List<TextMateBundleProvider.PluginBundle> =
        listOf(TextMateBundleProvider.PluginBundle("Styled Markdown", SmdPlugin.bundle))
}

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

    companion object {
        fun getInstance(): SmdSettings = service()
    }
}

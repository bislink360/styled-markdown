package com.bislink360.smd

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.TextEditorWithPreviewProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Opens `.smd` files in a split editor: the text on the left, the live preview on the right, with the IDE's usual
 * buttons to show only the editor, both, or only the preview (as for Markdown).
 */
class SmdSplitEditorProvider : TextEditorWithPreviewProvider(SmdPreviewEditorProvider()), DumbAware

/** The preview half of the split editor; not registered on its own. */
class SmdPreviewEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file.isSmd()
    override fun createEditor(project: Project, file: VirtualFile): FileEditor = SmdPreviewEditor(project, file)
    override fun getEditorTypeId(): String = "styled-markdown-preview"
    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR
}

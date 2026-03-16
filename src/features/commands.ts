import * as vscode from 'vscode'

import { CONFIG_SECTION, CONFIG_TSCONFIG, CONFIG_TYPE_ROOTS } from '../core/constants'
import { NotebookTsService } from '../core/notebookService'

export function registerCommands(context: vscode.ExtensionContext, service: NotebookTsService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('notebookTs.dumpVirtualDoc', async () => {
      const editor = vscode.window.activeNotebookEditor
      if (!editor) {
        vscode.window.showWarningMessage('No active notebook editor')
        return
      }
      const nb = editor.notebook
      const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
      const tsconfigPath = cfg.get<string>(CONFIG_TSCONFIG, '')
      const typeRoots = cfg.get<string[]>(CONFIG_TYPE_ROOTS, [])
      const resolved = await service.resolveTypeReferences(nb)

      await service.ensureVirtualDocument(nb)
      const key = service.notebookKey(nb)
      const state = service.stateByNotebook.get(key)
      if (!state) {
        vscode.window.showWarningMessage('No virtual document state')
        return
      }
      service.output.clear()
      service.output.appendLine(`Virtual document for ${nb.uri.toString()}`)
      service.output.appendLine(`Workspace: ${ws ? ws.uri.fsPath : '(none)'}`)
      service.output.appendLine(`Config tsconfigPath: ${tsconfigPath || '(empty)'}`)
      service.output.appendLine(`Config typeRoots: ${typeRoots.length ? typeRoots.join(', ') : '(empty)'}`)
      service.output.appendLine(`Resolved typeRoots: ${resolved.roots.length ? resolved.roots.join(', ') : '(empty)'}`)
      service.output.appendLine(`Used tsconfig: ${resolved.usedTsconfig || '(none)'}`)
      service.output.appendLine('---')
      service.output.appendLine(state.lines.join('\n'))
      service.output.show(true)
    }),
    vscode.commands.registerCommand('notebookTs.restart', async () => {
      await service.restartExtensionState()
      vscode.window.showInformationMessage('TypeScript Notebook: reloaded')
    })
  )
}

import * as vscode from 'vscode'

import { CONFIG_SECTION, CONFIG_TSCONFIG, CONFIG_TYPE_ROOTS } from '../core/constants'
import { NotebookTsService } from '../core/notebookService'

export function registerEvents(context: vscode.ExtensionContext, service: NotebookTsService): void {
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      service.adoptNotebookLanguages(nb)
        .then(() => service.cleanupVirtualFilesForNotebook(nb))
        .then(() => service.ensureVirtualDocument(nb))
        .catch(() => {})
    }),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      service.markNotebookDirty(e.notebook)
      service.adoptNotebookLanguages(e.notebook).catch(() => {})
      service.scheduleUpdate(e.notebook)
      service.scheduleBackgroundFlush(e.notebook)
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'vscode-notebook-cell') return
      if (service.shouldAdoptNotebookTsLanguage(e.document)) {
        service.adoptNotebookCellLanguage(e.document).catch(() => {})
        return
      }
      service.markCellDirty(e.document)
      const match = service.findNotebookStateForCell(e.document)
      if (match) {
        service.scheduleBackgroundFlush(match.cell.notebook)
      }
      const isTs = service.isTsLikeLanguage(e.document.languageId)
      if (isTs && e.contentChanges.length === 1) {
        const change = e.contentChanges[0]
        if (change.text.length === 1 && (change.text === '(' || change.text === ',')) {
          const flushedMatch = service.findNotebookStateForCell(e.document)
          if (flushedMatch) {
            service.flushCellUpdate(e.document).catch(() => {})
          }
        }
        if (change.text.length === 1 && change.text === '.') {
          const editor = vscode.window.activeTextEditor
          if (editor && editor.document.uri.toString() === e.document.uri.toString()) {
            setTimeout(() => {
              vscode.commands.executeCommand('editor.action.triggerSuggest').then(undefined, () => {})
            }, 0)
          }
        }
        if (change.text.length === 1 && (change.text === '(' || change.text === ',')) {
          const editor = vscode.window.activeTextEditor
          if (editor && editor.document.uri.toString() === e.document.uri.toString()) {
            setTimeout(() => {
              vscode.commands.executeCommand('editor.action.triggerParameterHints').then(undefined, () => {})
            }, 0)
          }
        }
      }
    }),
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const uri of e.uris) {
        const nbEntry = [...service.stateByNotebook.values()].find(s => s.virtualUri.toString() === uri.toString())
        if (!nbEntry) continue
        const mapped = service.mapDiagnostics(nbEntry, vscode.languages.getDiagnostics(uri))
        const allCellUris = nbEntry.ranges.map(r => r.cell.document.uri.toString())
        for (const cellUri of allCellUris) {
          const cellDiags = mapped.get(cellUri) ?? []
          service.diagnostics.set(vscode.Uri.parse(cellUri), cellDiags)
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_TYPE_ROOTS}`) &&
          !e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_TSCONFIG}`)) return
      vscode.workspace.notebookDocuments.forEach(nb => {
        service.ensureVirtualDocument(nb).catch(() => {})
      })
    })
  )
}

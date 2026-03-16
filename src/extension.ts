import * as vscode from 'vscode'

import { DIAG_COLLECTION, SCHEME } from './core/constants'
import { NotebookTsService } from './core/notebookService'
import { VirtualDocProvider } from './core/virtualDocProvider'
import { registerCommands } from './features/commands'
import { registerEvents } from './features/events'
import { registerProviders } from './features/providers'
import { registerStatusBar } from './features/status'

export function activate(context: vscode.ExtensionContext) {
  const provider = new VirtualDocProvider()
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAG_COLLECTION)
  const output = vscode.window.createOutputChannel('TypeScript Notebook')
  const service = new NotebookTsService(provider, diagnostics, output)

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    diagnostics,
    output
  )

  registerStatusBar(context)
  registerCommands(context, service)
  registerProviders(context, service)
  registerEvents(context, service)

  vscode.workspace.notebookDocuments.forEach(nb => {
    service.adoptNotebookLanguages(nb)
      .then(() => service.ensureVirtualDocument(nb))
      .catch(() => {})
  })
}

export function deactivate() {}

import * as vscode from 'vscode'

export class VirtualDocProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()
  private readonly store = new Map<string, string>()

  readonly onDidChange = this.onDidChangeEmitter.event

  update(uri: vscode.Uri, content: string) {
    this.store.set(uri.toString(), content)
    this.onDidChangeEmitter.fire(uri)
  }

  get(uri: vscode.Uri): string | undefined {
    return this.store.get(uri.toString())
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? ''
  }
}

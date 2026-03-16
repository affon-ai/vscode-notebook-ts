import * as vscode from 'vscode'

export function registerStatusBar(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  status.text = 'TypeScript Notebook: active'
  status.command = 'notebookTs.restart'
  status.show()
  context.subscriptions.push(status)
}

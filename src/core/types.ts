import * as vscode from 'vscode'

export interface CellRange {
  cell: vscode.NotebookCell
  startLine: number
  endLine: number
}

export interface NotebookState {
  virtualUri: vscode.Uri
  lines: string[]
  ranges: CellRange[]
}

export interface DiagnosticSuppressionContext {
  notebookState: NotebookState
  diagnostic: vscode.Diagnostic
  mapped: { uri: vscode.Uri; range: vscode.Range } | null
  cellRange: CellRange | null
}

export interface DiagnosticSuppressionRule {
  id: string
  matches(ctx: DiagnosticSuppressionContext): boolean
}

export interface TopLevelBindingStatement {
  names: string[]
  startLine: number
  endLine: number
}

export interface QueryStateDebugInfo {
  relevantCells: Array<{
    index: number
    uri: string
    statements: TopLevelBindingStatement[]
    maskedStatementIndices: number[]
  }>
}

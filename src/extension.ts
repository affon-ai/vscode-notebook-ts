import * as vscode from 'vscode'
import * as path from 'path'

const SCHEME = 'notebook-ts'
const DIAG_COLLECTION = 'notebook-ts'
const CONFIG_SECTION = 'notebookTs'
const CONFIG_TYPE_ROOTS = 'typeRoots'
const CONFIG_TSCONFIG = 'tsconfigPath'
const VIRTUAL_DIR = '.notebook-ts'
const UPDATE_DEBOUNCE_MS = 200
const BACKGROUND_FLUSH_MS = 500

interface CellRange {
  cell: vscode.NotebookCell
  startLine: number
  endLine: number
}

interface NotebookState {
  virtualUri: vscode.Uri
  lines: string[]
  ranges: CellRange[]
  headerLines: string[]
}

class VirtualDocProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  private readonly store = new Map<string, string>()

  readonly onDidChange = this._onDidChange.event

  update(uri: vscode.Uri, content: string) {
    this.store.set(uri.toString(), content)
    this._onDidChange.fire(uri)
  }

  get(uri: vscode.Uri): string | undefined {
    return this.store.get(uri.toString())
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? ''
  }
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new VirtualDocProvider()
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAG_COLLECTION)
  const output = vscode.window.createOutputChannel('TypeScript Notebook')

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    diagnostics,
    output
  )

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  status.text = 'TypeScript Notebook: active'
  status.command = 'notebookTs.restart'
  status.show()
  context.subscriptions.push(status)

  const stateByNotebook = new Map<string, NotebookState>()
  const pendingByNotebook = new Map<string, NotebookState>()
  const updateTimers = new Map<string, NodeJS.Timeout>()
  const dirtyCells = new Set<string>()
  const dirtyNotebooks = new Set<string>()
  const backgroundTimers = new Map<string, NodeJS.Timeout>()

  function notebookKey(nb: vscode.NotebookDocument): string {
    return nb.uri.toString()
  }

  function virtualUriFor(nb: vscode.NotebookDocument): vscode.Uri {
    const id = Buffer.from(nb.uri.toString()).toString('base64').replace(/[/+=]/g, '_')
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (ws) {
      const filePath = path.join(ws.uri.fsPath, VIRTUAL_DIR, `${id}.ts`)
      return vscode.Uri.file(filePath)
    }
    return vscode.Uri.from({ scheme: SCHEME, path: `/${id}.ts` })
  }

  async function cleanupVirtualDirs(): Promise<void> {
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const dir = vscode.Uri.file(path.join(ws.uri.fsPath, VIRTUAL_DIR))
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false })
      } catch {
        // ignore missing dir
      }
    }
  }

  function clearAllState(): void {
    for (const timer of updateTimers.values()) {
      clearTimeout(timer)
    }
    for (const timer of backgroundTimers.values()) {
      clearTimeout(timer)
    }
    updateTimers.clear()
    backgroundTimers.clear()
    stateByNotebook.clear()
    pendingByNotebook.clear()
    dirtyCells.clear()
    dirtyNotebooks.clear()
    diagnostics.clear()
  }

  async function restartExtensionState(): Promise<void> {
    clearAllState()
    await cleanupVirtualDirs()
    for (const nb of vscode.workspace.notebookDocuments) {
      await ensureVirtualDocument(nb)
    }
  }

  function configuredTsconfigPath(nb: vscode.NotebookDocument): string | null {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return null
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const tsconfigPath = cfg.get<string>(CONFIG_TSCONFIG, '')
    if (!tsconfigPath) {
      return path.join(ws.uri.fsPath, 'tsconfig.json')
    }
    return path.isAbsolute(tsconfigPath) ? tsconfigPath : path.join(ws.uri.fsPath, tsconfigPath)
  }

  function normalizePathForTsconfig(value: string): string {
    return value.replace(/\\/g, '/')
  }

  async function updateVirtualTsconfig(nb: vscode.NotebookDocument, vuri: vscode.Uri): Promise<void> {
    if (vuri.scheme !== 'file') return
    const sourcePath = configuredTsconfigPath(nb)
    if (!sourcePath) return

    let json: any
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(sourcePath))
      const text = Buffer.from(raw).toString('utf8')
      json = JSON.parse(stripJsonComments(text))
    } catch {
      return
    }

    const sourceDir = path.dirname(sourcePath)
    const virtualDir = path.dirname(vuri.fsPath)

    const compilerOptions = (json?.compilerOptions && typeof json.compilerOptions === 'object') ? json.compilerOptions : {}
    if (Array.isArray(compilerOptions.typeRoots)) {
      compilerOptions.typeRoots = compilerOptions.typeRoots.map((root: string) => {
        const abs = path.isAbsolute(root) ? root : path.join(sourceDir, root)
        const rel = path.relative(virtualDir, abs) || '.'
        return normalizePathForTsconfig(rel)
      })
    }
    json.compilerOptions = compilerOptions

    json.include = ['*.ts']

    const targetPath = path.join(virtualDir, 'tsconfig.json')
    const payload = `${JSON.stringify(json, null, 2)}\n`
    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(payload, 'utf8'))
  }

  function resolveTypeRootsFromConfig(nb: vscode.NotebookDocument): string[] {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return []
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const roots = cfg.get<string[]>(CONFIG_TYPE_ROOTS, [])
    return roots.map(root => path.isAbsolute(root) ? root : path.join(ws.uri.fsPath, root))
  }

  function isTsLikeLanguage(id: string): boolean {
    return id === 'typescript' || id === 'javascript'
  }

  async function resolveTypeRootsFromTsconfig(nb: vscode.NotebookDocument): Promise<{ roots: string[]; usedPath: string | null }> {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return { roots: [], usedPath: null }
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const tsconfigPath = cfg.get<string>(CONFIG_TSCONFIG, '')
    const absPath = tsconfigPath
      ? (path.isAbsolute(tsconfigPath) ? tsconfigPath : path.join(ws.uri.fsPath, tsconfigPath))
      : path.join(ws.uri.fsPath, 'tsconfig.json')

    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
      const text = Buffer.from(raw).toString('utf8')
      const json = JSON.parse(stripJsonComments(text)) as any
      const compilerOptions = json?.compilerOptions || {}
      const typeRoots: string[] = Array.isArray(compilerOptions.typeRoots) ? compilerOptions.typeRoots : []
      const baseDir = path.dirname(absPath)
      return {
        roots: typeRoots.map(root => path.isAbsolute(root) ? root : path.join(baseDir, root)),
        usedPath: absPath
      }
    } catch {
      return { roots: [], usedPath: null }
    }
  }

  async function resolveTypeRoots(nb: vscode.NotebookDocument): Promise<{ roots: string[]; usedPath: string | null }> {
    const fromTsconfig = await resolveTypeRootsFromTsconfig(nb)
    if (fromTsconfig.roots.length > 0) return fromTsconfig
    return { roots: resolveTypeRootsFromConfig(nb), usedPath: null }
  }

  async function resolveTypeReferences(nb: vscode.NotebookDocument): Promise<{ lines: string[]; usedTsconfig: string | null; roots: string[] }> {
    const resolved = await resolveTypeRoots(nb)
    const roots = resolved.roots
    if (roots.length === 0) return { lines: [], usedTsconfig: resolved.usedPath, roots }

    const lines: string[] = []
    for (const root of roots) {
      const dirUri = vscode.Uri.file(root)
      try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri)
        const files = entries
          .filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith('.d.ts'))
          .map(([name]) => name)
          .sort()

        for (const name of files) {
          const abs = path.join(root, name)
          lines.push(`/// <reference path=\"${abs}\" />`)
        }
      } catch {
        // ignore missing roots
      }
    }

    return { lines, usedTsconfig: resolved.usedPath, roots }
  }

  function buildVirtualContent(nb: vscode.NotebookDocument, headerLines: string[]): { lines: string[]; ranges: CellRange[] } {
    let line = 0
    const ranges: CellRange[] = []
    const parts: string[] = []

    if (headerLines.length > 0) {
      parts.push(...headerLines)
      line += headerLines.length
      parts.push('')
      line += 1
    }

    nb.getCells().forEach((cell, idx) => {
      if (cell.kind !== vscode.NotebookCellKind.Code) return
      if (!isTsLikeLanguage(cell.document.languageId)) return

      parts.push(`// Cell ${idx + 1}`)
      line += 1

      const text = cell.document.getText()
      const lines = text.split(/\r?\n/)
      const startLine = line
      const endLine = startLine + Math.max(lines.length - 1, 0)

      parts.push(text)
      line += lines.length

      ranges.push({ cell, startLine, endLine })

      parts.push('')
      line += 1
    })

    return { lines: parts, ranges }
  }

  async function ensureVirtualDocument(nb: vscode.NotebookDocument) {
    const vuri = virtualUriFor(nb)
    const resolved = await resolveTypeReferences(nb)
    const { lines, ranges } = buildVirtualContent(nb, resolved.lines)
    if (vuri.scheme === 'file') {
      const dir = vscode.Uri.file(path.dirname(vuri.fsPath))
      try {
        await vscode.workspace.fs.createDirectory(dir)
      } catch {
        // ignore
      }
      await vscode.workspace.fs.writeFile(vuri, Buffer.from(lines.join('\n')))
      await updateVirtualTsconfig(nb, vuri)
    } else {
      provider.update(vuri, lines.join('\n'))
    }

    const key = notebookKey(nb)
    stateByNotebook.set(key, { virtualUri: vuri, lines, ranges, headerLines: resolved.lines })

    const doc = await vscode.workspace.openTextDocument(vuri)
    await vscode.languages.setTextDocumentLanguage(doc, 'typescript')
  }

  async function updateVirtualFile(uri: vscode.Uri, content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri)
    const lastLine = Math.max(0, doc.lineCount - 1)
    const endChar = doc.lineCount > 0 ? doc.lineAt(lastLine).text.length : 0
    const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, endChar))
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, fullRange, content)
    await vscode.workspace.applyEdit(edit)
  }

  async function applyCellUpdate(cellDoc: vscode.TextDocument): Promise<boolean> {
    const match = findNotebookStateForCell(cellDoc)
    if (!match) return false
    const state = match.state
    const range = state.ranges.find(r => r.cell.document.uri.toString() === cellDoc.uri.toString())
    if (!range) return false
    if (state.virtualUri.scheme !== 'file') return false

    const lines = state.lines.slice()
    const oldStart = range.startLine
    const oldEnd = range.endLine
    if (oldStart < 0 || oldEnd >= lines.length) return false

    const oldLineCount = oldEnd - oldStart + 1
    const newText = cellDoc.getText()
    const newLines = newText.split(/\r?\n/)

    const oldEndChar = lines[oldEnd]?.length ?? 0
    const replaceRange = new vscode.Range(
      new vscode.Position(oldStart, 0),
      new vscode.Position(oldEnd, oldEndChar)
    )

    const edit = new vscode.WorkspaceEdit()
    edit.replace(state.virtualUri, replaceRange, newText)
    await vscode.workspace.applyEdit(edit)

    lines.splice(oldStart, oldLineCount, ...newLines)

    const delta = newLines.length - oldLineCount
    const updatedRanges = state.ranges.map(r => {
      if (r.cell.document.uri.toString() === cellDoc.uri.toString()) {
        return {
          cell: r.cell,
          startLine: r.startLine,
          endLine: r.startLine + newLines.length - 1
        }
      }
      if (r.startLine > oldEnd) {
        return {
          cell: r.cell,
          startLine: r.startLine + delta,
          endLine: r.endLine + delta
        }
      }
      return r
    })

    const key = notebookKey(match.cell.notebook)
    stateByNotebook.set(key, {
      virtualUri: state.virtualUri,
      lines,
      ranges: updatedRanges,
      headerLines: state.headerLines
    })
    dirtyCells.delete(cellDoc.uri.toString())
    return true
  }

  async function flushCellUpdate(cellDoc: vscode.TextDocument): Promise<void> {
    await applyCellUpdate(cellDoc)
  }

  function scheduleBackgroundFlush(nb: vscode.NotebookDocument) {
    const key = notebookKey(nb)
    const existing = backgroundTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flushBackground(nb).catch(() => {})
    }, BACKGROUND_FLUSH_MS)
    backgroundTimers.set(key, timer)
  }

  async function flushBackground(nb: vscode.NotebookDocument): Promise<void> {
    const key = notebookKey(nb)
    const timer = backgroundTimers.get(key)
    if (timer) clearTimeout(timer)
    backgroundTimers.delete(key)

    if (dirtyNotebooks.has(key)) {
      await flushPending(nb)
    }

    for (const cell of nb.getCells()) {
      const uri = cell.document.uri.toString()
      if (!dirtyCells.has(uri)) continue
      await flushCellUpdate(cell.document)
    }
  }


  function computeNotebookState(nb: vscode.NotebookDocument): NotebookState {
    const key = notebookKey(nb)
    const existing = stateByNotebook.get(key)
    const vuri = existing?.virtualUri ?? virtualUriFor(nb)
    const headerLines = existing?.headerLines ?? []
    const { lines, ranges } = buildVirtualContent(nb, headerLines)
    return { virtualUri: vuri, lines, ranges, headerLines }
  }

  async function updateFromNotebook(nb: vscode.NotebookDocument) {
    const key = notebookKey(nb)
    const next = computeNotebookState(nb)
    if (next.virtualUri.scheme === 'file') {
      await updateVirtualFile(next.virtualUri, next.lines.join('\n'))
    } else {
      provider.update(next.virtualUri, next.lines.join('\n'))
    }
    stateByNotebook.set(key, next)
    pendingByNotebook.delete(key)
    dirtyNotebooks.delete(key)
    const timer = updateTimers.get(key)
    if (timer) clearTimeout(timer)
    updateTimers.delete(key)
  }

  function scheduleUpdate(nb: vscode.NotebookDocument) {
    const key = notebookKey(nb)
    const next = computeNotebookState(nb)
    pendingByNotebook.set(key, next)
    const existing = updateTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flushPending(nb).catch(() => {})
    }, UPDATE_DEBOUNCE_MS)
    updateTimers.set(key, timer)
  }

  async function flushPending(nb: vscode.NotebookDocument) {
    const key = notebookKey(nb)
    const pending = pendingByNotebook.get(key)
    if (!pending) return
    if (pending.virtualUri.scheme === 'file') {
      await updateVirtualFile(pending.virtualUri, pending.lines.join('\n'))
    } else {
      provider.update(pending.virtualUri, pending.lines.join('\n'))
    }
    stateByNotebook.set(key, pending)
    pendingByNotebook.delete(key)
    const timer = updateTimers.get(key)
    if (timer) clearTimeout(timer)
    updateTimers.delete(key)
  }

  function mapDiagnostics(nbState: NotebookState, diags: readonly vscode.Diagnostic[]): Map<string, vscode.Diagnostic[]> {
    const map = new Map<string, vscode.Diagnostic[]>()
    const ranges = nbState.ranges

    for (const d of diags) {
      if (d.code === 6133) continue
      const line = d.range.start.line
      const range = ranges.find(r => line >= r.startLine && line <= r.endLine)
      if (!range) continue

      const cellLine = line - range.startLine
      const cellRange = new vscode.Range(
        new vscode.Position(cellLine, d.range.start.character),
        new vscode.Position(cellLine, d.range.end.character)
      )
      const mapped = new vscode.Diagnostic(cellRange, d.message, d.severity)
      mapped.code = d.code
      mapped.source = d.source
      mapped.relatedInformation = d.relatedInformation
      mapped.tags = d.tags

      const key = range.cell.document.uri.toString()
      const arr = map.get(key) ?? []
      arr.push(mapped)
      map.set(key, arr)
    }

    return map
  }

  function findNotebookStateForCell(cellDoc: vscode.TextDocument): { state: NotebookState; cell: vscode.NotebookCell } | null {
    for (const s of stateByNotebook.values()) {
      const match = s.ranges.find(r => r.cell.document.uri.toString() === cellDoc.uri.toString())
      if (match) return { state: s, cell: match.cell }
    }
    return null
  }

  function mapCellPositionToVirtual(state: NotebookState, cell: vscode.NotebookCell, pos: vscode.Position): vscode.Position | null {
    const range = state.ranges.find(r => r.cell.document.uri.toString() === cell.document.uri.toString())
    if (!range) return null
    return new vscode.Position(range.startLine + pos.line, pos.character)
  }

  function mapVirtualPositionToCell(state: NotebookState, pos: vscode.Position): { uri: vscode.Uri; position: vscode.Position } | null {
    const range = state.ranges.find(r => pos.line >= r.startLine && pos.line <= r.endLine)
    if (!range) return null
    return {
      uri: range.cell.document.uri,
      position: new vscode.Position(pos.line - range.startLine, pos.character)
    }
  }

  function mapVirtualRangeToCellRange(state: NotebookState, range: vscode.Range): { uri: vscode.Uri; range: vscode.Range } | null {
    const start = mapVirtualPositionToCell(state, range.start)
    const end = mapVirtualPositionToCell(state, range.end)
    if (!start || !end) return null
    if (start.uri.toString() !== end.uri.toString()) return null
    return { uri: start.uri, range: new vscode.Range(start.position, end.position) }
  }

  function mapLocationToCell(state: NotebookState, loc: vscode.Location | vscode.LocationLink): vscode.Location | vscode.LocationLink {
    if ('uri' in loc) {
      if (loc.uri.toString() !== state.virtualUri.toString()) return loc
      const mapped = mapVirtualRangeToCellRange(state, loc.range)
      if (!mapped) return loc
      return new vscode.Location(mapped.uri, mapped.range)
    }
    if (loc.targetUri.toString() !== state.virtualUri.toString()) return loc
    const targetRange = mapVirtualRangeToCellRange(state, loc.targetRange)
    const targetSelection = mapVirtualRangeToCellRange(state, loc.targetSelectionRange ?? loc.targetRange)
    if (!targetRange || !targetSelection) return loc
    const origin = loc.originSelectionRange
      ? mapVirtualRangeToCellRange(state, loc.originSelectionRange)
      : null
    return {
      originSelectionRange: origin ? origin.range : loc.originSelectionRange,
      targetUri: targetRange.uri,
      targetRange: targetRange.range,
      targetSelectionRange: targetSelection.range
    }
  }

  function isLocationLinkArray(defs: vscode.Location[] | vscode.LocationLink[]): defs is vscode.LocationLink[] {
    return defs.length > 0 && 'targetUri' in defs[0]
  }

  function mapRangeToCellRange(state: NotebookState, range: vscode.Range): vscode.Range | null {
    const mapped = mapVirtualRangeToCellRange(state, range)
    return mapped ? mapped.range : null
  }

  function mapTextEditToCell(state: NotebookState, edit: vscode.TextEdit): vscode.TextEdit | null {
    const mapped = mapRangeToCellRange(state, edit.range)
    if (!mapped) return null
    return new vscode.TextEdit(mapped, edit.newText)
  }

  function mapCompletionRangeToCell(
    state: NotebookState,
    range: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range }
  ): vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | null {
    if (range instanceof vscode.Range) {
      return mapRangeToCellRange(state, range)
    }
    const inserting = mapRangeToCellRange(state, range.inserting)
    const replacing = mapRangeToCellRange(state, range.replacing)
    if (!inserting || !replacing) return null
    return { inserting, replacing }
  }

  function mapCompletionItemToCell(state: NotebookState, item: vscode.CompletionItem): vscode.CompletionItem | null {
    if (item.range) {
      const mappedRange = mapCompletionRangeToCell(state, item.range)
      if (!mappedRange) return null
      item.range = mappedRange
    }
    if (item.textEdit) {
      const mappedEdit = mapTextEditToCell(state, item.textEdit)
      if (!mappedEdit) return null
      item.textEdit = mappedEdit
    }
    if (item.additionalTextEdits && item.additionalTextEdits.length > 0) {
      const mapped = item.additionalTextEdits
        .map(edit => mapTextEditToCell(state, edit))
        .filter((edit): edit is vscode.TextEdit => edit !== null)
      item.additionalTextEdits = mapped
    }
    return item
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      ensureVirtualDocument(nb).catch(() => {})
    }),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      dirtyNotebooks.add(notebookKey(e.notebook))
      scheduleUpdate(e.notebook)
      scheduleBackgroundFlush(e.notebook)
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'vscode-notebook-cell') return
      dirtyCells.add(e.document.uri.toString())
      const match = findNotebookStateForCell(e.document)
      if (match) {
        scheduleBackgroundFlush(match.cell.notebook)
      }
      const isTs = isTsLikeLanguage(e.document.languageId)
      if (isTs && e.contentChanges.length === 1) {
        const change = e.contentChanges[0]
        if (change.text.length === 1 && (change.text === '(' || change.text === ',')) {
          const match = findNotebookStateForCell(e.document)
          if (match) {
            flushCellUpdate(e.document).catch(() => {})
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
        const nbEntry = [...stateByNotebook.values()].find(s => s.virtualUri.toString() === uri.toString())
        if (!nbEntry) continue
        const mapped = mapDiagnostics(nbEntry, vscode.languages.getDiagnostics(uri))
        const allCellUris = nbEntry.ranges.map(r => r.cell.document.uri.toString())
        for (const cellUri of allCellUris) {
          const cellDiags = mapped.get(cellUri) ?? []
          diagnostics.set(vscode.Uri.parse(cellUri), cellDiags)
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_TYPE_ROOTS}`) &&
          !e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_TSCONFIG}`)) return
      vscode.workspace.notebookDocuments.forEach(nb => {
        ensureVirtualDocument(nb).catch(() => {})
      })
    }),
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
      const resolved = await resolveTypeReferences(nb)

      await ensureVirtualDocument(nb)
      const key = notebookKey(nb)
      const state = stateByNotebook.get(key)
      if (!state) {
        vscode.window.showWarningMessage('No virtual document state')
        return
      }
      output.clear()
      output.appendLine(`Virtual document for ${nb.uri.toString()}`)
      output.appendLine(`Workspace: ${ws ? ws.uri.fsPath : '(none)'}`)
      output.appendLine(`Config tsconfigPath: ${tsconfigPath || '(empty)'}`)
      output.appendLine(`Config typeRoots: ${typeRoots.length ? typeRoots.join(', ') : '(empty)'}`)
      output.appendLine(`Resolved typeRoots: ${resolved.roots.length ? resolved.roots.join(', ') : '(empty)'}`)
      output.appendLine(`Used tsconfig: ${resolved.usedTsconfig || '(none)'}`)
      output.appendLine('---')
      output.appendLine(state.lines.join('\n'))
      output.show(true)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('notebookTs.restart', async () => {
      await restartExtensionState()
      vscode.window.showInformationMessage('TypeScript Notebook: reloaded')
    })
  )

  // Completion provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideCompletionItems(doc, pos, _token, context) {
          if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) {
            const ch = context.triggerCharacter ?? ''
            if (ch !== '.') {
              return undefined
            }
          }
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          if (dirtyCells.has(doc.uri.toString())) {
            await flushCellUpdate(doc)
          }
          if (dirtyNotebooks.has(notebookKey(match.cell.notebook))) {
            await flushPending(match.cell.notebook)
          }
          const fresh = findNotebookStateForCell(doc) ?? match
          const vpos = mapCellPositionToVirtual(fresh.state, fresh.cell, pos)
          if (!vpos) return undefined
          const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            fresh.state.virtualUri,
            vpos,
            context.triggerCharacter,
            context.triggerKind
          )
          if (!list) return list

          const items = list.items
            .map(item => mapCompletionItemToCell(fresh.state, item))
            .filter((item): item is vscode.CompletionItem => item !== null)

          return new vscode.CompletionList(items, list.isIncomplete)
        }
      },
      '.'
    )
  )

  // Hover provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideHover(doc, pos) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          const vpos = mapCellPositionToVirtual(match.state, match.cell, pos)
          if (!vpos) return undefined
          const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            match.state.virtualUri,
            vpos
          )
          if (!hover || hover.length === 0) return undefined
          const h = hover[0]
          if (h.range) {
            const mapped = mapVirtualRangeToCellRange(match.state, h.range)
            if (mapped) return new vscode.Hover(h.contents, mapped.range)
          }
          return h
        }
      }
    )
  )

  // Definition provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDefinition(doc, pos) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          const vpos = mapCellPositionToVirtual(match.state, match.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            match.state.virtualUri,
            vpos
          )
          if (!defs) return defs
          if (isLocationLinkArray(defs)) {
            return defs.map(d => mapLocationToCell(match.state, d)) as vscode.LocationLink[]
          }
          return defs.map(d => mapLocationToCell(match.state, d)) as vscode.Location[]
        }
      }
    )
  )

  // Document highlight provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDocumentHighlights(doc, pos) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          const vpos = mapCellPositionToVirtual(match.state, match.cell, pos)
          if (!vpos) return undefined
          const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
            'vscode.executeDocumentHighlights',
            match.state.virtualUri,
            vpos
          )
          if (!highlights) return highlights
          const mapped = highlights
            .map(h => {
              const m = mapVirtualRangeToCellRange(match.state, h.range)
              return m ? new vscode.DocumentHighlight(m.range, h.kind) : null
            })
            .filter((h): h is vscode.DocumentHighlight => h !== null)
          return mapped
        }
      }
    )
  )

  // Signature help provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideSignatureHelp(doc, pos, _token, context) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          if (dirtyCells.has(doc.uri.toString())) {
            await flushCellUpdate(doc)
          }
          if (dirtyNotebooks.has(notebookKey(match.cell.notebook))) {
            await flushPending(match.cell.notebook)
          }
          const fresh = findNotebookStateForCell(doc) ?? match
          const vpos = mapCellPositionToVirtual(fresh.state, fresh.cell, pos)
          if (!vpos) return undefined
          const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider',
            fresh.state.virtualUri,
            vpos,
            context.triggerCharacter,
            context.isRetrigger
          )
          return help
        }
      },
      '(', ','
    )
  )

  // Initialize for already-open notebooks
  vscode.workspace.notebookDocuments.forEach(nb => {
    ensureVirtualDocument(nb).catch(() => {})
  })
}

export function deactivate() {}

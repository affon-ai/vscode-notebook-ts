import * as vscode from 'vscode'
import * as path from 'path'

const SCHEME = 'notebook-ts'
const DIAG_COLLECTION = 'ts-notebook'
const CONFIG_SECTION = 'notebookTs'
const CONFIG_TYPE_ROOTS = 'typeRoots'
const CONFIG_TSCONFIG = 'tsconfigPath'

interface CellRange {
  cell: vscode.NotebookCell
  startLine: number
  endLine: number
}

interface NotebookState {
  virtualUri: vscode.Uri
  content: string
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
  status.show()
  context.subscriptions.push(status)

  const hoverDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline'
  })
  context.subscriptions.push(hoverDecoration)
  const underlineTimers = new Map<string, NodeJS.Timeout>()

  const stateByNotebook = new Map<string, NotebookState>()

  function notebookKey(nb: vscode.NotebookDocument): string {
    return nb.uri.toString()
  }

  function virtualUriFor(nb: vscode.NotebookDocument): vscode.Uri {
    const id = Buffer.from(nb.uri.toString()).toString('base64')
    return vscode.Uri.from({ scheme: SCHEME, path: `/${id}.ts` })
  }

  function resolveTypeRootsFromConfig(nb: vscode.NotebookDocument): string[] {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return []
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const roots = cfg.get<string[]>(CONFIG_TYPE_ROOTS, [])
    return roots.map(root => path.isAbsolute(root) ? root : path.join(ws.uri.fsPath, root))
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

  function buildVirtualContent(nb: vscode.NotebookDocument, headerLines: string[]): { content: string; ranges: CellRange[] } {
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
      if (cell.document.languageId !== 'typescript' && cell.document.languageId !== 'javascript') return

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

    return { content: parts.join('\n'), ranges }
  }

  async function ensureVirtualDocument(nb: vscode.NotebookDocument) {
    const vuri = virtualUriFor(nb)
    const resolved = await resolveTypeReferences(nb)
    const { content, ranges } = buildVirtualContent(nb, resolved.lines)
    provider.update(vuri, content)

    const key = notebookKey(nb)
    stateByNotebook.set(key, { virtualUri: vuri, content, ranges, headerLines: resolved.lines })

    const doc = await vscode.workspace.openTextDocument(vuri)
    await vscode.languages.setTextDocumentLanguage(doc, 'typescript')
  }

  function updateFromNotebook(nb: vscode.NotebookDocument) {
    const key = notebookKey(nb)
    const existing = stateByNotebook.get(key)
    const vuri = existing?.virtualUri ?? virtualUriFor(nb)
    const headerLines = existing?.headerLines ?? []
    const { content, ranges } = buildVirtualContent(nb, headerLines)
    provider.update(vuri, content)
    stateByNotebook.set(key, { virtualUri: vuri, content, ranges, headerLines })
  }

  function mapDiagnostics(nbState: NotebookState, diags: readonly vscode.Diagnostic[]): Map<string, vscode.Diagnostic[]> {
    const map = new Map<string, vscode.Diagnostic[]>()
    const ranges = nbState.ranges

    for (const d of diags) {
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
      if (loc.uri.scheme !== SCHEME) return loc
      const mapped = mapVirtualRangeToCellRange(state, loc.range)
      if (!mapped) return loc
      return new vscode.Location(mapped.uri, mapped.range)
    }
    if (loc.targetUri.scheme !== SCHEME) return loc
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

  function underlineRange(doc: vscode.TextDocument, range: vscode.Range | undefined) {
    if (!range) return
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString())
    if (!editor) return
    const key = editor.document.uri.toString()
    const existing = underlineTimers.get(key)
    if (existing) clearTimeout(existing)
    editor.setDecorations(hoverDecoration, [range])
    const timer = setTimeout(() => {
      editor.setDecorations(hoverDecoration, [])
      underlineTimers.delete(key)
    }, 400)
    underlineTimers.set(key, timer)
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      ensureVirtualDocument(nb).catch(() => {})
    }),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      updateFromNotebook(e.notebook)
    }),
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const uri of e.uris) {
        if (uri.scheme !== SCHEME) continue
        const nbEntry = [...stateByNotebook.values()].find(s => s.virtualUri.toString() === uri.toString())
        if (!nbEntry) continue
        const mapped = mapDiagnostics(nbEntry, vscode.languages.getDiagnostics(uri))
        for (const [cellUri, cellDiags] of mapped.entries()) {
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
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor) {
        e.textEditor.setDecorations(hoverDecoration, [])
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e) {
        e.setDecorations(hoverDecoration, [])
      }
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
      output.appendLine(state.content)
      output.show(true)
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
        async provideCompletionItems(doc, pos) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined
          const vpos = mapCellPositionToVirtual(match.state, match.cell, pos)
          if (!vpos) return undefined
          const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            match.state.virtualUri,
            vpos
          )
          return list
        }
      },
      '.', ':', '_'
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
            if (mapped) {
              underlineRange(doc, mapped.range)
              return new vscode.Hover(h.contents, mapped.range)
            }
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

  // Document link provider (caret-only link to avoid global underlines)
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      [
        { language: 'typescript', scheme: 'vscode-notebook-cell' },
        { language: 'javascript', scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDocumentLinks(doc) {
          const match = findNotebookStateForCell(doc)
          if (!match) return undefined

          const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString())
          if (!editor) return []
          const pos = editor.selection.active
          if (!editor.selection.isEmpty) return []

          const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/)
          if (!wordRange) return []

          const vpos = mapCellPositionToVirtual(match.state, match.cell, pos)
          if (!vpos) return []

          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            match.state.virtualUri,
            vpos
          )
          if (!defs || defs.length === 0) return []

          const mapped = mapLocationToCell(match.state, defs[0])
          const targetUri = 'uri' in mapped ? mapped.uri : mapped.targetUri
          return [new vscode.DocumentLink(wordRange, targetUri)]
        }
      }
    )
  )

  // Initialize for already-open notebooks
  vscode.workspace.notebookDocuments.forEach(nb => {
    ensureVirtualDocument(nb).catch(() => {})
  })
}

export function deactivate() {}

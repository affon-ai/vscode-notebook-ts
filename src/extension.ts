import * as vscode from 'vscode'
import * as path from 'path'
import * as ts from 'typescript'
import { createHash } from 'crypto'

const SCHEME = 'notebook-ts'
const DIAG_COLLECTION = 'notebook-ts'
const CONFIG_SECTION = 'notebookTs'
const CONFIG_TYPE_ROOTS = 'typeRoots'
const CONFIG_TSCONFIG = 'tsconfigPath'
const VIRTUAL_DIR = '.notebook-ts'
const NOTEBOOK_TS_LANGUAGE = 'typescript-notebook'
const TS_LANGUAGE = 'typescript'
const JS_LANGUAGE = 'javascript'
const UPDATE_DEBOUNCE_MS = 200
const BACKGROUND_FLUSH_MS = 500
const SUPPRESSED_DUPLICATE_DECLARATION_CODES = new Set([2300, 2451])

interface CellRange {
  cell: vscode.NotebookCell
  startLine: number
  endLine: number
}

interface NotebookState {
  virtualUri: vscode.Uri
  lines: string[]
  ranges: CellRange[]
}

interface DiagnosticSuppressionContext {
  notebookState: NotebookState
  diagnostic: vscode.Diagnostic
  mapped: { uri: vscode.Uri; range: vscode.Range } | null
  cellRange: CellRange | null
}

interface DiagnosticSuppressionRule {
  id: string
  matches(ctx: DiagnosticSuppressionContext): boolean
}

interface TopLevelBindingStatement {
  names: string[]
  startLine: number
  endLine: number
}

interface QueryStateDebugInfo {
  relevantCells: Array<{
    index: number
    uri: string
    statements: TopLevelBindingStatement[]
    maskedStatementIndices: number[]
  }>
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
    const id = createHash('sha1').update(nb.uri.toString()).digest('hex').slice(0, 16)
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (ws) {
      const filePath = path.join(ws.uri.fsPath, VIRTUAL_DIR, `${id}.ts`)
      return vscode.Uri.file(filePath)
    }
    return vscode.Uri.from({ scheme: SCHEME, path: `/${id}.ts` })
  }

  function virtualBaseNameForUri(uri: vscode.Uri): string {
    return path.basename(uri.scheme === 'file' ? uri.fsPath : uri.path, '.ts')
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

  async function cleanupVirtualFilesForNotebook(nb: vscode.NotebookDocument): Promise<void> {
    const vuri = virtualUriFor(nb)
    const key = notebookKey(nb)
    const pending = pendingByNotebook.get(key)

    stateByNotebook.delete(key)
    pendingByNotebook.delete(key)
    dirtyNotebooks.delete(key)

    const updateTimer = updateTimers.get(key)
    if (updateTimer) {
      clearTimeout(updateTimer)
      updateTimers.delete(key)
    }

    const backgroundTimer = backgroundTimers.get(key)
    if (backgroundTimer) {
      clearTimeout(backgroundTimer)
      backgroundTimers.delete(key)
    }

    for (const cell of nb.getCells()) {
      dirtyCells.delete(cell.document.uri.toString())
      diagnostics.delete(cell.document.uri)
    }

    const candidates = new Set<string>([vuri.toString()])
    if (pending) {
      candidates.add(pending.virtualUri.toString())
    }

    if (vuri.scheme === 'file') {
      const dir = vscode.Uri.file(path.dirname(vuri.fsPath))
      const baseName = virtualBaseNameForUri(vuri)
      try {
        const entries = await vscode.workspace.fs.readDirectory(dir)
        for (const [name, kind] of entries) {
          if (kind !== vscode.FileType.File) continue
          if (name === `${baseName}.ts` || name.startsWith(`${baseName}-cell-`) || name === 'tsconfig.json') {
            candidates.add(vscode.Uri.file(path.join(dir.fsPath, name)).toString())
          }
        }
      } catch {
        // ignore missing dir
      }
    }

    for (const ref of candidates) {
      const uri = vscode.Uri.parse(ref)
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false })
      } catch {
        // ignore missing files
      }
      if (uri.scheme !== 'file') {
        provider.update(uri, '')
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

  function toArrayOfStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }

  function getTypeScriptInlayPreferences(resource: vscode.Uri): ts.UserPreferences {
    const config = vscode.workspace.getConfiguration(undefined, resource)
    return {
      includeInlayParameterNameHints: config.get<'none' | 'literals' | 'all'>('js/ts.inlayHints.parameterNames.enabled', 'none'),
      includeInlayParameterNameHintsWhenArgumentMatchesName: !config.get<boolean>('js/ts.inlayHints.parameterNames.suppressWhenArgumentMatchesName', true),
      includeInlayFunctionParameterTypeHints: config.get<boolean>('js/ts.inlayHints.parameterTypes.enabled', false),
      includeInlayVariableTypeHints: config.get<boolean>('js/ts.inlayHints.variableTypes.enabled', false),
      includeInlayVariableTypeHintsWhenTypeMatchesName: !config.get<boolean>('js/ts.inlayHints.variableTypes.suppressWhenTypeMatchesName', true),
      includeInlayPropertyDeclarationTypeHints: config.get<boolean>('js/ts.inlayHints.propertyDeclarationTypes.enabled', false),
      includeInlayFunctionLikeReturnTypeHints: config.get<boolean>('js/ts.inlayHints.functionLikeReturnTypes.enabled', false),
      includeInlayEnumMemberValueHints: config.get<boolean>('js/ts.inlayHints.enumMemberValues.enabled', false),
      interactiveInlayHints: true
    }
  }

  function hasAnyTypeScriptInlayHintsEnabled(resource: vscode.Uri): boolean {
    const prefs = getTypeScriptInlayPreferences(resource)
    return (
      prefs.includeInlayParameterNameHints !== 'none' ||
      !!prefs.includeInlayFunctionParameterTypeHints ||
      !!prefs.includeInlayVariableTypeHints ||
      !!prefs.includeInlayPropertyDeclarationTypeHints ||
      !!prefs.includeInlayFunctionLikeReturnTypeHints ||
      !!prefs.includeInlayEnumMemberValueHints
    )
  }

  function getParsedNotebookTsConfig(vuri: vscode.Uri): { parsed: ts.ParsedCommandLine; tsconfigPath: string } | null {
    if (vuri.scheme !== 'file') return null
    const tsconfigPath = path.join(path.dirname(vuri.fsPath), 'tsconfig.json')
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {}
    })
    if (!parsed) return null
    return { parsed, tsconfigPath }
  }

  function createNotebookLanguageService(vuri: vscode.Uri): { service: ts.LanguageService; fileName: string } | null {
    const parsedConfig = getParsedNotebookTsConfig(vuri)
    if (!parsedConfig) return null

    const fileVersions = new Map<string, string>()
    for (const fileName of parsedConfig.parsed.fileNames) {
      try {
        const stat = ts.sys.getModifiedTime?.(fileName)
        fileVersions.set(fileName, stat ? String(stat.getTime()) : '0')
      } catch {
        fileVersions.set(fileName, '0')
      }
    }

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsedConfig.parsed.options,
      getScriptFileNames: () => parsedConfig.parsed.fileNames,
      getScriptVersion: fileName => fileVersions.get(fileName) ?? '0',
      getScriptSnapshot: fileName => {
        const text = ts.sys.readFile(fileName)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => path.dirname(parsedConfig.tsconfigPath),
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists?.bind(ts.sys),
      getDirectories: ts.sys.getDirectories?.bind(ts.sys)
    }

    return {
      service: ts.createLanguageService(host),
      fileName: vuri.fsPath
    }
  }

  function mapTypeScriptInlayKind(kind: ts.InlayHintKind): vscode.InlayHintKind | undefined {
    switch (kind) {
      case ts.InlayHintKind.Parameter:
        return vscode.InlayHintKind.Parameter
      case ts.InlayHintKind.Type:
        return vscode.InlayHintKind.Type
      default:
        return undefined
    }
  }

  function provideNotebookInlayHints(
    doc: vscode.TextDocument,
    state: NotebookState,
    cell: vscode.NotebookCell,
    range: vscode.Range
  ): vscode.InlayHint[] | undefined {
    if (!hasAnyTypeScriptInlayHintsEnabled(doc.uri)) return undefined
    if (state.virtualUri.scheme !== 'file') return undefined
    const serviceEntry = createNotebookLanguageService(state.virtualUri)
    if (!serviceEntry) return undefined

    const program = serviceEntry.service.getProgram()
    const sourceFile = program?.getSourceFile(serviceEntry.fileName)
    if (!sourceFile) return undefined

    const start = mapCellPositionToVirtual(state, cell, range.start)
    const end = mapCellPositionToVirtual(state, cell, range.end)
    if (!start || !end) return undefined
    const lineStarts = sourceFile.getLineStarts()
    if (start.line >= lineStarts.length || end.line >= lineStarts.length) return undefined

    const spanStart = sourceFile.getPositionOfLineAndCharacter(start.line, start.character)
    const spanEnd = sourceFile.getPositionOfLineAndCharacter(end.line, end.character)
    const preferences = getTypeScriptInlayPreferences(doc.uri)
    const hints = serviceEntry.service.provideInlayHints(serviceEntry.fileName, { start: spanStart, length: spanEnd - spanStart }, preferences)

    return hints
      .map(hint => {
        const loc = sourceFile.getLineAndCharacterOfPosition(hint.position)
        const mapped = mapVirtualPositionToCell(state, new vscode.Position(loc.line, loc.character))
        if (!mapped || mapped.uri.toString() !== doc.uri.toString()) return null

        const label = hint.displayParts && hint.displayParts.length > 0
          ? hint.displayParts.map(part => new vscode.InlayHintLabelPart(part.text))
          : hint.text
        const mappedHint = new vscode.InlayHint(mapped.position, label, mapTypeScriptInlayKind(hint.kind))
        mappedHint.paddingLeft = hint.whitespaceBefore
        mappedHint.paddingRight = hint.whitespaceAfter
        return mappedHint
      })
      .filter((hint): hint is vscode.InlayHint => hint !== null)
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
    const rebasedTypeRoots: string[] = []
    if (Array.isArray(compilerOptions.typeRoots)) {
      compilerOptions.typeRoots = compilerOptions.typeRoots.map((root: string) => {
        const abs = path.isAbsolute(root) ? root : path.join(sourceDir, root)
        const rel = path.relative(virtualDir, abs) || '.'
        const normalized = normalizePathForTsconfig(rel)
        rebasedTypeRoots.push(normalized)
        return normalized
      })
    }
    json.compilerOptions = compilerOptions

    const rebasedIncludes = toArrayOfStrings(json.include).map(entry => {
      const abs = path.isAbsolute(entry) ? entry : path.join(sourceDir, entry)
      const rel = path.relative(virtualDir, abs) || '.'
      return normalizePathForTsconfig(rel)
    })

    const typeRootIncludes = rebasedTypeRoots.map(root => normalizePathForTsconfig(path.posix.join(root, '**/*.d.ts')))
    json.include = Array.from(new Set(['*.ts', ...rebasedIncludes, ...typeRootIncludes]))

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
    return id === TS_LANGUAGE || id === NOTEBOOK_TS_LANGUAGE || id === JS_LANGUAGE
  }

  function shouldAdoptNotebookTsLanguage(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'vscode-notebook-cell' && doc.languageId === TS_LANGUAGE
  }

  async function adoptNotebookCellLanguage(doc: vscode.TextDocument): Promise<void> {
    if (!shouldAdoptNotebookTsLanguage(doc)) return
    await vscode.languages.setTextDocumentLanguage(doc, NOTEBOOK_TS_LANGUAGE)
  }

  async function adoptNotebookLanguages(nb: vscode.NotebookDocument): Promise<void> {
    for (const cell of nb.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue
      await adoptNotebookCellLanguage(cell.document)
    }
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

  async function resolveTypeReferences(nb: vscode.NotebookDocument): Promise<{ usedTsconfig: string | null; roots: string[] }> {
    const resolved = await resolveTypeRoots(nb)
    return { usedTsconfig: resolved.usedPath, roots: resolved.roots }
  }

  function buildVirtualContent(nb: vscode.NotebookDocument): { lines: string[]; ranges: CellRange[] } {
    return buildVirtualContentForCells(
      nb.getCells().filter(cell => cell.kind === vscode.NotebookCellKind.Code && isTsLikeLanguage(cell.document.languageId))
    )
  }

  function buildVirtualContentForCells(
    cells: readonly vscode.NotebookCell[],
    textOverrides = new Map<string, string>()
  ): { lines: string[]; ranges: CellRange[] } {
    let line = 0
    const ranges: CellRange[] = []
    const parts: string[] = []

    cells.forEach(cell => {
      parts.push(`// Cell ${cell.index + 1}`)
      line += 1

      const originalText = textOverrides.get(cell.document.uri.toString()) ?? cell.document.getText()
      const text = rewriteTopLevelBindingsForNotebook(originalText)
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

  function rewriteTopLevelBindingsForNotebook(text: string): string {
    const sourceFile = ts.createSourceFile('cell.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const replacements: Array<{ start: number; end: number; text: string }> = []

    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue
      const start = statement.declarationList.getStart(sourceFile)
      if (text.slice(start, start + 5) === 'const') {
        replacements.push({ start, end: start + 5, text: 'var  ' })
        continue
      }
      if (text.slice(start, start + 3) === 'let') {
        replacements.push({ start, end: start + 3, text: 'var' })
      }
    }

    if (replacements.length === 0) return text

    let next = text
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end)
    }
    return next
  }

  function collectBindingNames(name: ts.BindingName, out: string[]): void {
    if (ts.isIdentifier(name)) {
      out.push(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      collectBindingNames(element.name, out)
    }
  }

  function topLevelBindingStatements(text: string): TopLevelBindingStatement[] {
    const sourceFile = ts.createSourceFile('cell.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const statements: TopLevelBindingStatement[] = []

    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue
      const names: string[] = []
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names)
      }
      if (names.length === 0) continue
      const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
      const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd())
      statements.push({
        names,
        startLine: start.line,
        endLine: end.line
      })
    }

    return statements
  }

  function maskTextLines(text: string, startLine: number, endLine: number): string {
    const lines = text.split(/\r?\n/)
    for (let i = startLine; i <= endLine && i < lines.length; i += 1) {
      lines[i] = lines[i].replace(/[^\r\n]/g, ' ')
    }
    return lines.join('\n')
  }

  function buildQueryStateForCell(baseState: NotebookState, targetCell: vscode.NotebookCell): NotebookState {
    return buildQueryStateForCellWithDebug(baseState, targetCell).state
  }

  function buildQueryStateForCellWithDebug(
    baseState: NotebookState,
    targetCell: vscode.NotebookCell
  ): { state: NotebookState; debug: QueryStateDebugInfo } {
    const relevantCells = targetCell.notebook.getCells().filter(cell =>
      cell.kind === vscode.NotebookCellKind.Code &&
      isTsLikeLanguage(cell.document.languageId) &&
      cell.index <= targetCell.index
    )

    const shadowedStatements = new Map<string, Set<number>>()
    const latestByName = new Map<string, { cellUri: string; statementIndex: number }>()
    const cellStatements = new Map<string, TopLevelBindingStatement[]>()

    for (const cell of relevantCells) {
      const cellUri = cell.document.uri.toString()
      const statements = topLevelBindingStatements(cell.document.getText())
      cellStatements.set(cellUri, statements)

      statements.forEach((statement, statementIndex) => {
        for (const name of statement.names) {
          const previous = latestByName.get(name)
          if (previous) {
            const masked = shadowedStatements.get(previous.cellUri) ?? new Set<number>()
            masked.add(previous.statementIndex)
            shadowedStatements.set(previous.cellUri, masked)
          }
          latestByName.set(name, { cellUri, statementIndex })
        }
      })
    }

    const textOverrides = new Map<string, string>()
    const debugCells: QueryStateDebugInfo['relevantCells'] = []
    for (const cell of relevantCells) {
      const cellUri = cell.document.uri.toString()
      const maskedIndices = shadowedStatements.get(cellUri)
      const statements = cellStatements.get(cellUri) ?? []
      debugCells.push({
        index: cell.index,
        uri: cellUri,
        statements,
        maskedStatementIndices: maskedIndices ? [...maskedIndices].sort((a, b) => a - b) : []
      })
      if (!maskedIndices || maskedIndices.size === 0) continue

      let text = cell.document.getText()
      for (const statementIndex of [...maskedIndices].sort((a, b) => b - a)) {
        const statement = statements[statementIndex]
        if (!statement) continue
        text = maskTextLines(text, statement.startLine, statement.endLine)
      }
      textOverrides.set(cellUri, text)
    }

    const { lines, ranges } = buildVirtualContentForCells(relevantCells, textOverrides)
    const baseName = path.basename(baseState.virtualUri.path, '.ts') || 'notebook'
    const virtualUri = baseState.virtualUri.scheme === 'file'
      ? vscode.Uri.file(path.join(path.dirname(baseState.virtualUri.fsPath), `${baseName}-cell-${targetCell.index}.ts`))
      : vscode.Uri.from({ scheme: SCHEME, path: `/${baseName}-cell-${targetCell.index}.ts` })

    return {
      state: {
        virtualUri,
        lines,
        ranges
      },
      debug: {
        relevantCells: debugCells
      }
    }
  }

  async function prepareQueryState(
    doc: vscode.TextDocument
  ): Promise<{ state: NotebookState; cell: vscode.NotebookCell } | null> {
    const match = findNotebookStateForCell(doc)
    if (!match) return null
    if (dirtyCells.has(doc.uri.toString())) {
      await flushCellUpdate(doc)
    }
    if (dirtyNotebooks.has(notebookKey(match.cell.notebook))) {
      await flushPending(match.cell.notebook)
    }
    const fresh = findNotebookStateForCell(doc) ?? match
    return { state: fresh.state, cell: fresh.cell }
  }

  async function ensureVirtualDocument(nb: vscode.NotebookDocument) {
    const vuri = virtualUriFor(nb)
    const resolved = await resolveTypeReferences(nb)
    const { lines, ranges } = buildVirtualContent(nb)
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
    stateByNotebook.set(key, { virtualUri: vuri, lines, ranges })
    if (vuri.scheme !== 'file') {
      await ensureVirtualTextDocument(vuri)
    }
  }

  async function ensureVirtualTextDocument(uri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri)
    if (uri.scheme !== 'file') {
      await vscode.languages.setTextDocumentLanguage(doc, TS_LANGUAGE)
    }
  }

  async function updateVirtualFile(uri: vscode.Uri, content: string): Promise<void> {
    if (uri.scheme === 'file') {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content))
      return
    }
    provider.update(uri, content)
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
    const rewrittenText = rewriteTopLevelBindingsForNotebook(newText)
    const newLines = rewrittenText.split(/\r?\n/)

    lines.splice(oldStart, oldLineCount, ...newLines)
    await updateVirtualFile(state.virtualUri, lines.join('\n'))

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
        ranges: updatedRanges
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
    const { lines, ranges } = buildVirtualContent(nb)
    return { virtualUri: vuri, lines, ranges }
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

    const suppressionRules: readonly DiagnosticSuppressionRule[] = [
      {
        id: 'duplicate-top-level-binding',
        matches(ctx) {
          const code = typeof ctx.diagnostic.code === 'number'
            ? ctx.diagnostic.code
            : typeof ctx.diagnostic.code === 'string'
              ? Number(ctx.diagnostic.code)
              : NaN
          if (!SUPPRESSED_DUPLICATE_DECLARATION_CODES.has(code)) return false
          if (!ctx.cellRange || !ctx.mapped) return false

          const startLine = ctx.cellRange.startLine
          const endLine = ctx.cellRange.endLine
          const targetLine = ctx.diagnostic.range.start.line
          if (targetLine < startLine || targetLine > endLine) return false

          const cellLine = targetLine - startLine
          const lineText = ctx.cellRange.cell.document.lineAt(cellLine).text
          return /^\s*(export\s+)?(declare\s+)?(const|let|var|function|class)\b/.test(lineText)
        }
      }
    ]

    function shouldSuppressDiagnostic(ctx: DiagnosticSuppressionContext): boolean {
      return suppressionRules.some(rule => rule.matches(ctx))
    }

    for (const d of diags) {
      if (d.code === 6133) continue
      const line = d.range.start.line
      const range = ranges.find(r => line >= r.startLine && line <= r.endLine)
      if (!range) continue

      const mappedRange = mapVirtualRangeToCellRange(nbState, d.range)
      if (!mappedRange) continue

      const mapped = new vscode.Diagnostic(mappedRange.range, d.message, d.severity)
      mapped.code = d.code
      mapped.source = d.source
      mapped.relatedInformation = d.relatedInformation
      mapped.tags = d.tags

      const suppressionContext: DiagnosticSuppressionContext = {
        notebookState: nbState,
        diagnostic: d,
        mapped: mappedRange,
        cellRange: range
      }
      if (shouldSuppressDiagnostic(suppressionContext)) continue

      const key = mappedRange.uri.toString()
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

  function isNotebookVirtualUriForState(state: NotebookState, uri: vscode.Uri): boolean {
    if (uri.toString() === state.virtualUri.toString()) return true

    if (state.virtualUri.scheme === 'file' && uri.scheme === 'file') {
      const stateDir = path.dirname(state.virtualUri.fsPath)
      const stateBase = path.basename(state.virtualUri.fsPath, '.ts')
      const candidateDir = path.dirname(uri.fsPath)
      const candidateBase = path.basename(uri.fsPath, '.ts')
      return candidateDir === stateDir && (candidateBase === stateBase || candidateBase.startsWith(`${stateBase}-cell-`))
    }

    if (state.virtualUri.scheme === uri.scheme) {
      const stateBase = path.basename(state.virtualUri.path, '.ts')
      const candidateBase = path.basename(uri.path, '.ts')
      return candidateBase === stateBase || candidateBase.startsWith(`${stateBase}-cell-`)
    }

    return false
  }

  function mapLocationToCell(state: NotebookState, loc: vscode.Location | vscode.LocationLink): vscode.Location | vscode.LocationLink {
    if ('uri' in loc) {
      if (!isNotebookVirtualUriForState(state, loc.uri)) return loc
      const mapped = mapVirtualRangeToCellRange(state, loc.range)
      if (!mapped) return loc
      return new vscode.Location(mapped.uri, mapped.range)
    }
    if (!isNotebookVirtualUriForState(state, loc.targetUri)) return loc
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

  function mapInlayHintLabelPartToCell(
    state: NotebookState,
    part: vscode.InlayHintLabelPart
  ): vscode.InlayHintLabelPart | null {
    if (!part.location) return part
    if (part.location.uri.toString() !== state.virtualUri.toString()) return part
    const mapped = mapVirtualRangeToCellRange(state, part.location.range)
    if (!mapped) return null
    return {
      ...part,
      location: new vscode.Location(mapped.uri, mapped.range)
    }
  }

  function mapInlayHintToCell(state: NotebookState, hint: vscode.InlayHint): vscode.InlayHint | null {
    const mappedPosition = mapVirtualPositionToCell(state, hint.position)
    if (!mappedPosition) return null

    const mappedLabel = Array.isArray(hint.label)
      ? hint.label
          .map(part => mapInlayHintLabelPartToCell(state, part))
          .filter((part): part is vscode.InlayHintLabelPart => part !== null)
      : hint.label

    const mappedHint = new vscode.InlayHint(mappedPosition.position, mappedLabel, hint.kind)
    mappedHint.paddingLeft = hint.paddingLeft
    mappedHint.paddingRight = hint.paddingRight
    mappedHint.textEdits = hint.textEdits
    mappedHint.tooltip = hint.tooltip
    return mappedHint
  }

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideInlayHints(doc, range, _token) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          return provideNotebookInlayHints(doc, query.state, query.cell, range)
        }
      }
    ),
    vscode.workspace.onDidOpenNotebookDocument(nb => {
      adoptNotebookLanguages(nb)
        .then(() => cleanupVirtualFilesForNotebook(nb))
        .then(() => ensureVirtualDocument(nb))
        .catch(() => {})
    }),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      dirtyNotebooks.add(notebookKey(e.notebook))
      adoptNotebookLanguages(e.notebook).catch(() => {})
      scheduleUpdate(e.notebook)
      scheduleBackgroundFlush(e.notebook)
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'vscode-notebook-cell') return
      if (shouldAdoptNotebookTsLanguage(e.document)) {
        adoptNotebookCellLanguage(e.document).catch(() => {})
        return
      }
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
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideCompletionItems(doc, pos, _token, context) {
          if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) {
            const ch = context.triggerCharacter ?? ''
            if (ch !== '.') {
              return undefined
            }
          }
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            query.state.virtualUri,
            vpos,
            context.triggerCharacter,
            context.triggerKind
          )
          if (!list) return list

          const items = list.items
            .map(item => mapCompletionItemToCell(query.state, item))
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
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideHover(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            query.state.virtualUri,
            vpos
          )
          if (!hover || hover.length === 0) return undefined
          const h = hover[0]
          if (h.range) {
            const mapped = mapVirtualRangeToCellRange(query.state, h.range)
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
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDefinition(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            query.state.virtualUri,
            vpos
          )
          if (!defs) return defs
          if (isLocationLinkArray(defs)) {
            return defs.map(d => mapLocationToCell(query.state, d)) as vscode.LocationLink[]
          }
          return defs.map(d => mapLocationToCell(query.state, d)) as vscode.Location[]
        }
      }
    )
  )

  // Implementation provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerImplementationProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideImplementation(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const impls = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeImplementationProvider',
            query.state.virtualUri,
            vpos
          )
          if (!impls) return impls
          if (isLocationLinkArray(impls)) {
            return impls.map(loc => mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return impls.map(loc => mapLocationToCell(query.state, loc)) as vscode.Location[]
        }
      }
    )
  )

  // Type definition provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerTypeDefinitionProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideTypeDefinition(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeTypeDefinitionProvider',
            query.state.virtualUri,
            vpos
          )
          if (!defs) return defs
          if (isLocationLinkArray(defs)) {
            return defs.map(loc => mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return defs.map(loc => mapLocationToCell(query.state, loc)) as vscode.Location[]
        }
      }
    )
  )

  // Declaration provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerDeclarationProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDeclaration(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDeclarationProvider',
            query.state.virtualUri,
            vpos
          )
          const resolvedDefs = defs && defs.length > 0
            ? defs
            : await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                'vscode.executeDefinitionProvider',
                query.state.virtualUri,
                vpos
              )
          if (!resolvedDefs) return resolvedDefs
          if (isLocationLinkArray(resolvedDefs)) {
            return resolvedDefs.map(loc => mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return resolvedDefs.map(loc => mapLocationToCell(query.state, loc)) as vscode.Location[]
        }
      }
    )
  )

  // Document highlight provider (basic mapping)
  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDocumentHighlights(doc, pos) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
            'vscode.executeDocumentHighlights',
            query.state.virtualUri,
            vpos
          )
          if (!highlights) return highlights
          const mapped = highlights
            .map(h => {
              const m = mapVirtualRangeToCellRange(query.state, h.range)
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
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideSignatureHelp(doc, pos, _token, context) {
          const query = await prepareQueryState(doc)
          if (!query) return undefined
          const vpos = mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider',
            query.state.virtualUri,
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
    adoptNotebookLanguages(nb)
      .then(() => ensureVirtualDocument(nb))
      .catch(() => {})
  })
}

export function deactivate() {}

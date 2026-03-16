import * as vscode from 'vscode'
import * as path from 'path'
import * as ts from 'typescript'
import { createHash } from 'crypto'

import {
  BACKGROUND_FLUSH_MS,
  CONFIG_SECTION,
  CONFIG_TSCONFIG,
  CONFIG_TYPE_ROOTS,
  JS_LANGUAGE,
  NOTEBOOK_TS_LANGUAGE,
  SCHEME,
  SUPPRESSED_DUPLICATE_DECLARATION_CODES,
  TS_LANGUAGE,
  UPDATE_DEBOUNCE_MS,
  VIRTUAL_DIR
} from './constants'
import {
  CellRange,
  DiagnosticSuppressionContext,
  DiagnosticSuppressionRule,
  NotebookState,
  QueryStateDebugInfo,
  TopLevelBindingStatement
} from './types'
import { stripJsonComments } from './utils'
import { VirtualDocProvider } from './virtualDocProvider'

export class NotebookTsService {
  readonly stateByNotebook = new Map<string, NotebookState>()
  private readonly pendingByNotebook = new Map<string, NotebookState>()
  private readonly updateTimers = new Map<string, NodeJS.Timeout>()
  private readonly dirtyCells = new Set<string>()
  private readonly dirtyNotebooks = new Set<string>()
  private readonly backgroundTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly provider: VirtualDocProvider,
    readonly diagnostics: vscode.DiagnosticCollection,
    readonly output: vscode.OutputChannel
  ) {}

  notebookKey(nb: vscode.NotebookDocument): string {
    return nb.uri.toString()
  }

  virtualUriFor(nb: vscode.NotebookDocument): vscode.Uri {
    const id = createHash('sha1').update(nb.uri.toString()).digest('hex').slice(0, 16)
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (ws) {
      const filePath = path.join(ws.uri.fsPath, VIRTUAL_DIR, `${id}.ts`)
      return vscode.Uri.file(filePath)
    }
    return vscode.Uri.from({ scheme: SCHEME, path: `/${id}.ts` })
  }

  private virtualBaseNameForUri(uri: vscode.Uri): string {
    return path.basename(uri.scheme === 'file' ? uri.fsPath : uri.path, '.ts')
  }

  async cleanupVirtualDirs(): Promise<void> {
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const dir = vscode.Uri.file(path.join(ws.uri.fsPath, VIRTUAL_DIR))
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false })
      } catch {
        // ignore missing dir
      }
    }
  }

  async cleanupVirtualFilesForNotebook(nb: vscode.NotebookDocument): Promise<void> {
    const vuri = this.virtualUriFor(nb)
    const key = this.notebookKey(nb)
    const pending = this.pendingByNotebook.get(key)

    this.stateByNotebook.delete(key)
    this.pendingByNotebook.delete(key)
    this.dirtyNotebooks.delete(key)

    const updateTimer = this.updateTimers.get(key)
    if (updateTimer) {
      clearTimeout(updateTimer)
      this.updateTimers.delete(key)
    }

    const backgroundTimer = this.backgroundTimers.get(key)
    if (backgroundTimer) {
      clearTimeout(backgroundTimer)
      this.backgroundTimers.delete(key)
    }

    for (const cell of nb.getCells()) {
      this.dirtyCells.delete(cell.document.uri.toString())
      this.diagnostics.delete(cell.document.uri)
    }

    const candidates = new Set<string>([vuri.toString()])
    if (pending) {
      candidates.add(pending.virtualUri.toString())
    }

    if (vuri.scheme === 'file') {
      const dir = vscode.Uri.file(path.dirname(vuri.fsPath))
      const baseName = this.virtualBaseNameForUri(vuri)
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
        this.provider.update(uri, '')
      }
    }
  }

  clearAllState(): void {
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer)
    }
    for (const timer of this.backgroundTimers.values()) {
      clearTimeout(timer)
    }
    this.updateTimers.clear()
    this.backgroundTimers.clear()
    this.stateByNotebook.clear()
    this.pendingByNotebook.clear()
    this.dirtyCells.clear()
    this.dirtyNotebooks.clear()
    this.diagnostics.clear()
  }

  async restartExtensionState(): Promise<void> {
    this.clearAllState()
    await this.cleanupVirtualDirs()
    for (const nb of vscode.workspace.notebookDocuments) {
      await this.ensureVirtualDocument(nb)
    }
  }

  private configuredTsconfigPath(nb: vscode.NotebookDocument): string | null {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return null
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const tsconfigPath = cfg.get<string>(CONFIG_TSCONFIG, '')
    if (!tsconfigPath) {
      return path.join(ws.uri.fsPath, 'tsconfig.json')
    }
    return path.isAbsolute(tsconfigPath) ? tsconfigPath : path.join(ws.uri.fsPath, tsconfigPath)
  }

  private normalizePathForTsconfig(value: string): string {
    return value.replace(/\\/g, '/')
  }

  private toArrayOfStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }

  private getTypeScriptInlayPreferences(resource: vscode.Uri): ts.UserPreferences {
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

  private hasAnyTypeScriptInlayHintsEnabled(resource: vscode.Uri): boolean {
    const prefs = this.getTypeScriptInlayPreferences(resource)
    return (
      prefs.includeInlayParameterNameHints !== 'none' ||
      !!prefs.includeInlayFunctionParameterTypeHints ||
      !!prefs.includeInlayVariableTypeHints ||
      !!prefs.includeInlayPropertyDeclarationTypeHints ||
      !!prefs.includeInlayFunctionLikeReturnTypeHints ||
      !!prefs.includeInlayEnumMemberValueHints
    )
  }

  private getParsedNotebookTsConfig(vuri: vscode.Uri): { parsed: ts.ParsedCommandLine; tsconfigPath: string } | null {
    if (vuri.scheme !== 'file') return null
    const tsconfigPath = path.join(path.dirname(vuri.fsPath), 'tsconfig.json')
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {}
    })
    if (!parsed) return null
    return { parsed, tsconfigPath }
  }

  private createNotebookLanguageService(vuri: vscode.Uri): { service: ts.LanguageService; fileName: string } | null {
    const parsedConfig = this.getParsedNotebookTsConfig(vuri)
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

  private mapTypeScriptInlayKind(kind: ts.InlayHintKind): vscode.InlayHintKind | undefined {
    switch (kind) {
      case ts.InlayHintKind.Parameter:
        return vscode.InlayHintKind.Parameter
      case ts.InlayHintKind.Type:
        return vscode.InlayHintKind.Type
      default:
        return undefined
    }
  }

  provideNotebookInlayHints(
    doc: vscode.TextDocument,
    state: NotebookState,
    cell: vscode.NotebookCell,
    range: vscode.Range
  ): vscode.InlayHint[] | undefined {
    if (!this.hasAnyTypeScriptInlayHintsEnabled(doc.uri)) return undefined
    if (state.virtualUri.scheme !== 'file') return undefined
    const serviceEntry = this.createNotebookLanguageService(state.virtualUri)
    if (!serviceEntry) return undefined

    const program = serviceEntry.service.getProgram()
    const sourceFile = program?.getSourceFile(serviceEntry.fileName)
    if (!sourceFile) return undefined

    const start = this.mapCellPositionToVirtual(state, cell, range.start)
    const end = this.mapCellPositionToVirtual(state, cell, range.end)
    if (!start || !end) return undefined
    const lineStarts = sourceFile.getLineStarts()
    if (start.line >= lineStarts.length || end.line >= lineStarts.length) return undefined

    const spanStart = sourceFile.getPositionOfLineAndCharacter(start.line, start.character)
    const spanEnd = sourceFile.getPositionOfLineAndCharacter(end.line, end.character)
    const preferences = this.getTypeScriptInlayPreferences(doc.uri)
    const hints = serviceEntry.service.provideInlayHints(serviceEntry.fileName, { start: spanStart, length: spanEnd - spanStart }, preferences)

    return hints
      .map(hint => {
        const loc = sourceFile.getLineAndCharacterOfPosition(hint.position)
        const mapped = this.mapVirtualPositionToCell(state, new vscode.Position(loc.line, loc.character))
        if (!mapped || mapped.uri.toString() !== doc.uri.toString()) return null

        const label = hint.displayParts && hint.displayParts.length > 0
          ? hint.displayParts.map(part => new vscode.InlayHintLabelPart(part.text))
          : hint.text
        const mappedHint = new vscode.InlayHint(mapped.position, label, this.mapTypeScriptInlayKind(hint.kind))
        mappedHint.paddingLeft = hint.whitespaceBefore
        mappedHint.paddingRight = hint.whitespaceAfter
        return mappedHint
      })
      .filter((hint): hint is vscode.InlayHint => hint !== null)
  }

  async updateVirtualTsconfig(nb: vscode.NotebookDocument, vuri: vscode.Uri): Promise<void> {
    if (vuri.scheme !== 'file') return
    const sourcePath = this.configuredTsconfigPath(nb)
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
        const normalized = this.normalizePathForTsconfig(rel)
        rebasedTypeRoots.push(normalized)
        return normalized
      })
    }
    json.compilerOptions = compilerOptions

    const rebasedIncludes = this.toArrayOfStrings(json.include).map(entry => {
      const abs = path.isAbsolute(entry) ? entry : path.join(sourceDir, entry)
      const rel = path.relative(virtualDir, abs) || '.'
      return this.normalizePathForTsconfig(rel)
    })

    const typeRootIncludes = rebasedTypeRoots.map(root => this.normalizePathForTsconfig(path.posix.join(root, '**/*.d.ts')))
    json.include = Array.from(new Set(['*.ts', ...rebasedIncludes, ...typeRootIncludes]))

    const targetPath = path.join(virtualDir, 'tsconfig.json')
    const payload = `${JSON.stringify(json, null, 2)}\n`
    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(payload, 'utf8'))
  }

  private resolveTypeRootsFromConfig(nb: vscode.NotebookDocument): string[] {
    const ws = vscode.workspace.getWorkspaceFolder(nb.uri)
    if (!ws) return []
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, nb.uri)
    const roots = cfg.get<string[]>(CONFIG_TYPE_ROOTS, [])
    return roots.map(root => path.isAbsolute(root) ? root : path.join(ws.uri.fsPath, root))
  }

  isTsLikeLanguage(id: string): boolean {
    return id === TS_LANGUAGE || id === NOTEBOOK_TS_LANGUAGE || id === JS_LANGUAGE
  }

  shouldAdoptNotebookTsLanguage(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'vscode-notebook-cell' && doc.languageId === TS_LANGUAGE
  }

  async adoptNotebookCellLanguage(doc: vscode.TextDocument): Promise<void> {
    if (!this.shouldAdoptNotebookTsLanguage(doc)) return
    await vscode.languages.setTextDocumentLanguage(doc, NOTEBOOK_TS_LANGUAGE)
  }

  async adoptNotebookLanguages(nb: vscode.NotebookDocument): Promise<void> {
    for (const cell of nb.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue
      await this.adoptNotebookCellLanguage(cell.document)
    }
  }

  private async resolveTypeRootsFromTsconfig(nb: vscode.NotebookDocument): Promise<{ roots: string[]; usedPath: string | null }> {
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

  private async resolveTypeRoots(nb: vscode.NotebookDocument): Promise<{ roots: string[]; usedPath: string | null }> {
    const fromTsconfig = await this.resolveTypeRootsFromTsconfig(nb)
    if (fromTsconfig.roots.length > 0) return fromTsconfig
    return { roots: this.resolveTypeRootsFromConfig(nb), usedPath: null }
  }

  async resolveTypeReferences(nb: vscode.NotebookDocument): Promise<{ usedTsconfig: string | null; roots: string[] }> {
    const resolved = await this.resolveTypeRoots(nb)
    return { usedTsconfig: resolved.usedPath, roots: resolved.roots }
  }

  buildVirtualContent(nb: vscode.NotebookDocument): { lines: string[]; ranges: CellRange[] } {
    return this.buildVirtualContentForCells(
      nb.getCells().filter(cell => cell.kind === vscode.NotebookCellKind.Code && this.isTsLikeLanguage(cell.document.languageId))
    )
  }

  buildVirtualContentForCells(
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
      const text = this.rewriteTopLevelBindingsForNotebook(originalText)
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

  rewriteTopLevelBindingsForNotebook(text: string): string {
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

  private collectBindingNames(name: ts.BindingName, out: string[]): void {
    if (ts.isIdentifier(name)) {
      out.push(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      this.collectBindingNames(element.name, out)
    }
  }

  private topLevelBindingStatements(text: string): TopLevelBindingStatement[] {
    const sourceFile = ts.createSourceFile('cell.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const statements: TopLevelBindingStatement[] = []

    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue
      const names: string[] = []
      for (const declaration of statement.declarationList.declarations) {
        this.collectBindingNames(declaration.name, names)
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

  private maskTextLines(text: string, startLine: number, endLine: number): string {
    const lines = text.split(/\r?\n/)
    for (let i = startLine; i <= endLine && i < lines.length; i += 1) {
      lines[i] = lines[i].replace(/[^\r\n]/g, ' ')
    }
    return lines.join('\n')
  }

  buildQueryStateForCell(baseState: NotebookState, targetCell: vscode.NotebookCell): NotebookState {
    return this.buildQueryStateForCellWithDebug(baseState, targetCell).state
  }

  buildQueryStateForCellWithDebug(
    baseState: NotebookState,
    targetCell: vscode.NotebookCell
  ): { state: NotebookState; debug: QueryStateDebugInfo } {
    const relevantCells = targetCell.notebook.getCells().filter(cell =>
      cell.kind === vscode.NotebookCellKind.Code &&
      this.isTsLikeLanguage(cell.document.languageId) &&
      cell.index <= targetCell.index
    )

    const shadowedStatements = new Map<string, Set<number>>()
    const latestByName = new Map<string, { cellUri: string; statementIndex: number }>()
    const cellStatements = new Map<string, TopLevelBindingStatement[]>()

    for (const cell of relevantCells) {
      const cellUri = cell.document.uri.toString()
      const statements = this.topLevelBindingStatements(cell.document.getText())
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
        text = this.maskTextLines(text, statement.startLine, statement.endLine)
      }
      textOverrides.set(cellUri, text)
    }

    const { lines, ranges } = this.buildVirtualContentForCells(relevantCells, textOverrides)
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

  async prepareQueryState(
    doc: vscode.TextDocument
  ): Promise<{ state: NotebookState; cell: vscode.NotebookCell } | null> {
    const match = this.findNotebookStateForCell(doc)
    if (!match) return null
    if (this.dirtyCells.has(doc.uri.toString())) {
      await this.flushCellUpdate(doc)
    }
    if (this.dirtyNotebooks.has(this.notebookKey(match.cell.notebook))) {
      await this.flushPending(match.cell.notebook)
    }
    const fresh = this.findNotebookStateForCell(doc) ?? match
    return { state: fresh.state, cell: fresh.cell }
  }

  async ensureVirtualDocument(nb: vscode.NotebookDocument) {
    const vuri = this.virtualUriFor(nb)
    await this.resolveTypeReferences(nb)
    const { lines, ranges } = this.buildVirtualContent(nb)
    if (vuri.scheme === 'file') {
      const dir = vscode.Uri.file(path.dirname(vuri.fsPath))
      try {
        await vscode.workspace.fs.createDirectory(dir)
      } catch {
        // ignore
      }
      await vscode.workspace.fs.writeFile(vuri, Buffer.from(lines.join('\n')))
      await this.updateVirtualTsconfig(nb, vuri)
    } else {
      this.provider.update(vuri, lines.join('\n'))
    }

    const key = this.notebookKey(nb)
    this.stateByNotebook.set(key, { virtualUri: vuri, lines, ranges })
    if (vuri.scheme !== 'file') {
      await this.ensureVirtualTextDocument(vuri)
    }
  }

  private async ensureVirtualTextDocument(uri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri)
    if (uri.scheme !== 'file') {
      await vscode.languages.setTextDocumentLanguage(doc, TS_LANGUAGE)
    }
  }

  private async updateVirtualFile(uri: vscode.Uri, content: string): Promise<void> {
    if (uri.scheme === 'file') {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content))
      return
    }
    this.provider.update(uri, content)
  }

  private async applyCellUpdate(cellDoc: vscode.TextDocument): Promise<boolean> {
    const match = this.findNotebookStateForCell(cellDoc)
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
    const rewrittenText = this.rewriteTopLevelBindingsForNotebook(cellDoc.getText())
    const newLines = rewrittenText.split(/\r?\n/)

    lines.splice(oldStart, oldLineCount, ...newLines)
    await this.updateVirtualFile(state.virtualUri, lines.join('\n'))

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

    const key = this.notebookKey(match.cell.notebook)
    this.stateByNotebook.set(key, {
      virtualUri: state.virtualUri,
      lines,
      ranges: updatedRanges
    })
    this.dirtyCells.delete(cellDoc.uri.toString())
    return true
  }

  async flushCellUpdate(cellDoc: vscode.TextDocument): Promise<void> {
    await this.applyCellUpdate(cellDoc)
  }

  scheduleBackgroundFlush(nb: vscode.NotebookDocument) {
    const key = this.notebookKey(nb)
    const existing = this.backgroundTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.flushBackground(nb).catch(() => {})
    }, BACKGROUND_FLUSH_MS)
    this.backgroundTimers.set(key, timer)
  }

  private async flushBackground(nb: vscode.NotebookDocument): Promise<void> {
    const key = this.notebookKey(nb)
    const timer = this.backgroundTimers.get(key)
    if (timer) clearTimeout(timer)
    this.backgroundTimers.delete(key)

    if (this.dirtyNotebooks.has(key)) {
      await this.flushPending(nb)
    }

    for (const cell of nb.getCells()) {
      const uri = cell.document.uri.toString()
      if (!this.dirtyCells.has(uri)) continue
      await this.flushCellUpdate(cell.document)
    }
  }

  private computeNotebookState(nb: vscode.NotebookDocument): NotebookState {
    const key = this.notebookKey(nb)
    const existing = this.stateByNotebook.get(key)
    const vuri = existing?.virtualUri ?? this.virtualUriFor(nb)
    const { lines, ranges } = this.buildVirtualContent(nb)
    return { virtualUri: vuri, lines, ranges }
  }

  scheduleUpdate(nb: vscode.NotebookDocument) {
    const key = this.notebookKey(nb)
    const next = this.computeNotebookState(nb)
    this.pendingByNotebook.set(key, next)
    const existing = this.updateTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.flushPending(nb).catch(() => {})
    }, UPDATE_DEBOUNCE_MS)
    this.updateTimers.set(key, timer)
  }

  async flushPending(nb: vscode.NotebookDocument) {
    const key = this.notebookKey(nb)
    const pending = this.pendingByNotebook.get(key)
    if (!pending) return
    if (pending.virtualUri.scheme === 'file') {
      await this.updateVirtualFile(pending.virtualUri, pending.lines.join('\n'))
    } else {
      this.provider.update(pending.virtualUri, pending.lines.join('\n'))
    }
    this.stateByNotebook.set(key, pending)
    this.pendingByNotebook.delete(key)
    this.dirtyNotebooks.delete(key)
    const timer = this.updateTimers.get(key)
    if (timer) clearTimeout(timer)
    this.updateTimers.delete(key)
  }

  mapDiagnostics(nbState: NotebookState, diags: readonly vscode.Diagnostic[]): Map<string, vscode.Diagnostic[]> {
    const map = new Map<string, vscode.Diagnostic[]>()
    const ranges = nbState.ranges

    const suppressionRules: readonly DiagnosticSuppressionRule[] = [
      {
        id: 'duplicate-top-level-binding',
        matches: (ctx: DiagnosticSuppressionContext) => {
          const code = typeof ctx.diagnostic.code === 'number'
            ? ctx.diagnostic.code
            : typeof ctx.diagnostic.code === 'string'
              ? Number(ctx.diagnostic.code)
              : NaN
          if (!SUPPRESSED_DUPLICATE_DECLARATION_CODES.has(code)) return false
          if (!ctx.cellRange || !ctx.mapped) return false

          const targetLine = ctx.diagnostic.range.start.line
          if (targetLine < ctx.cellRange.startLine || targetLine > ctx.cellRange.endLine) return false

          const cellLine = targetLine - ctx.cellRange.startLine
          const lineText = ctx.cellRange.cell.document.lineAt(cellLine).text
          return /^\s*(export\s+)?(declare\s+)?(const|let|var|function|class)\b/.test(lineText)
        }
      }
    ]

    const shouldSuppressDiagnostic = (ctx: DiagnosticSuppressionContext): boolean =>
      suppressionRules.some(rule => rule.matches(ctx))

    for (const d of diags) {
      if (d.code === 6133) continue
      const range = ranges.find(r => d.range.start.line >= r.startLine && d.range.start.line <= r.endLine)
      if (!range) continue

      const mappedRange = this.mapVirtualRangeToCellRange(nbState, d.range)
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

  findNotebookStateForCell(cellDoc: vscode.TextDocument): { state: NotebookState; cell: vscode.NotebookCell } | null {
    for (const s of this.stateByNotebook.values()) {
      const match = s.ranges.find(r => r.cell.document.uri.toString() === cellDoc.uri.toString())
      if (match) return { state: s, cell: match.cell }
    }
    return null
  }

  mapCellPositionToVirtual(state: NotebookState, cell: vscode.NotebookCell, pos: vscode.Position): vscode.Position | null {
    const range = state.ranges.find(r => r.cell.document.uri.toString() === cell.document.uri.toString())
    if (!range) return null
    return new vscode.Position(range.startLine + pos.line, pos.character)
  }

  mapVirtualPositionToCell(state: NotebookState, pos: vscode.Position): { uri: vscode.Uri; position: vscode.Position } | null {
    const range = state.ranges.find(r => pos.line >= r.startLine && pos.line <= r.endLine)
    if (!range) return null
    return {
      uri: range.cell.document.uri,
      position: new vscode.Position(pos.line - range.startLine, pos.character)
    }
  }

  mapVirtualRangeToCellRange(state: NotebookState, range: vscode.Range): { uri: vscode.Uri; range: vscode.Range } | null {
    const start = this.mapVirtualPositionToCell(state, range.start)
    const end = this.mapVirtualPositionToCell(state, range.end)
    if (!start || !end) return null
    if (start.uri.toString() !== end.uri.toString()) return null
    return { uri: start.uri, range: new vscode.Range(start.position, end.position) }
  }

  private isNotebookVirtualUriForState(state: NotebookState, uri: vscode.Uri): boolean {
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

  mapLocationToCell(state: NotebookState, loc: vscode.Location | vscode.LocationLink): vscode.Location | vscode.LocationLink {
    if ('uri' in loc) {
      if (!this.isNotebookVirtualUriForState(state, loc.uri)) return loc
      const mapped = this.mapVirtualRangeToCellRange(state, loc.range)
      if (!mapped) return loc
      return new vscode.Location(mapped.uri, mapped.range)
    }
    if (!this.isNotebookVirtualUriForState(state, loc.targetUri)) return loc
    const targetRange = this.mapVirtualRangeToCellRange(state, loc.targetRange)
    const targetSelection = this.mapVirtualRangeToCellRange(state, loc.targetSelectionRange ?? loc.targetRange)
    if (!targetRange || !targetSelection) return loc
    const origin = loc.originSelectionRange
      ? this.mapVirtualRangeToCellRange(state, loc.originSelectionRange)
      : null
    return {
      originSelectionRange: origin ? origin.range : loc.originSelectionRange,
      targetUri: targetRange.uri,
      targetRange: targetRange.range,
      targetSelectionRange: targetSelection.range
    }
  }

  isLocationLinkArray(defs: vscode.Location[] | vscode.LocationLink[]): defs is vscode.LocationLink[] {
    return defs.length > 0 && 'targetUri' in defs[0]
  }

  mapRangeToCellRange(state: NotebookState, range: vscode.Range): vscode.Range | null {
    const mapped = this.mapVirtualRangeToCellRange(state, range)
    return mapped ? mapped.range : null
  }

  mapTextEditToCell(state: NotebookState, edit: vscode.TextEdit): vscode.TextEdit | null {
    const mapped = this.mapRangeToCellRange(state, edit.range)
    if (!mapped) return null
    return new vscode.TextEdit(mapped, edit.newText)
  }

  mapCompletionRangeToCell(
    state: NotebookState,
    range: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range }
  ): vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | null {
    if (range instanceof vscode.Range) {
      return this.mapRangeToCellRange(state, range)
    }
    const inserting = this.mapRangeToCellRange(state, range.inserting)
    const replacing = this.mapRangeToCellRange(state, range.replacing)
    if (!inserting || !replacing) return null
    return { inserting, replacing }
  }

  mapCompletionItemToCell(state: NotebookState, item: vscode.CompletionItem): vscode.CompletionItem | null {
    if (item.range) {
      const mappedRange = this.mapCompletionRangeToCell(state, item.range)
      if (!mappedRange) return null
      item.range = mappedRange
    }
    if (item.textEdit) {
      const mappedEdit = this.mapTextEditToCell(state, item.textEdit)
      if (!mappedEdit) return null
      item.textEdit = mappedEdit
    }
    if (item.additionalTextEdits && item.additionalTextEdits.length > 0) {
      const mapped = item.additionalTextEdits
        .map(edit => this.mapTextEditToCell(state, edit))
        .filter((edit): edit is vscode.TextEdit => edit !== null)
      item.additionalTextEdits = mapped
    }
    return item
  }

  private mapInlayHintLabelPartToCell(
    state: NotebookState,
    part: vscode.InlayHintLabelPart
  ): vscode.InlayHintLabelPart | null {
    if (!part.location) return part
    if (part.location.uri.toString() !== state.virtualUri.toString()) return part
    const mapped = this.mapVirtualRangeToCellRange(state, part.location.range)
    if (!mapped) return null
    return {
      ...part,
      location: new vscode.Location(mapped.uri, mapped.range)
    }
  }

  mapInlayHintToCell(state: NotebookState, hint: vscode.InlayHint): vscode.InlayHint | null {
    const mappedPosition = this.mapVirtualPositionToCell(state, hint.position)
    if (!mappedPosition) return null

    const mappedLabel = Array.isArray(hint.label)
      ? hint.label
          .map(part => this.mapInlayHintLabelPartToCell(state, part))
          .filter((part): part is vscode.InlayHintLabelPart => part !== null)
      : hint.label

    const mappedHint = new vscode.InlayHint(mappedPosition.position, mappedLabel, hint.kind)
    mappedHint.paddingLeft = hint.paddingLeft
    mappedHint.paddingRight = hint.paddingRight
    mappedHint.textEdits = hint.textEdits
    mappedHint.tooltip = hint.tooltip
    return mappedHint
  }

  markNotebookDirty(nb: vscode.NotebookDocument): void {
    this.dirtyNotebooks.add(this.notebookKey(nb))
  }

  markCellDirty(doc: vscode.TextDocument): void {
    this.dirtyCells.add(doc.uri.toString())
  }

  isCellDirty(doc: vscode.TextDocument): boolean {
    return this.dirtyCells.has(doc.uri.toString())
  }

  isNotebookDirty(nb: vscode.NotebookDocument): boolean {
    return this.dirtyNotebooks.has(this.notebookKey(nb))
  }
}

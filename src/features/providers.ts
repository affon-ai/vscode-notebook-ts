import * as vscode from 'vscode'

import { JS_LANGUAGE, NOTEBOOK_TS_LANGUAGE } from '../core/constants'
import { NotebookTsService } from '../core/notebookService'

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

function getIdentifierRangeForIndex(text: string, line: number, index: number): vscode.Range | undefined {
  if (index < 0 || index >= text.length) return undefined
  if (!isIdentifierChar(text[index] ?? '')) return undefined

  let start = index
  while (start > 0 && isIdentifierChar(text[start - 1] ?? '')) {
    start -= 1
  }

  let end = index + 1
  while (end < text.length && isIdentifierChar(text[end] ?? '')) {
    end += 1
  }

  return new vscode.Range(new vscode.Position(line, start), new vscode.Position(line, end))
}

function getIdentifierRangeAtPosition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  const text = doc.lineAt(pos.line).text
  if (!text) return undefined

  const index = Math.min(pos.character, text.length - 1)
  if (index < 0) return undefined

  const current = text[index] ?? ''
  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''

  if (isIdentifierChar(current)) {
    return getIdentifierRangeForIndex(text, pos.line, index)
  }

  if (isIdentifierChar(previous)) {
    return getIdentifierRangeForIndex(text, pos.line, index - 1)
  }

  if (current === '.' && isIdentifierChar(next)) {
    return getIdentifierRangeForIndex(text, pos.line, index + 1)
  }

  return undefined
}

function selectHoverRange(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  mappedRange?: vscode.Range
): vscode.Range | undefined {
  const identifierRange = getIdentifierRangeAtPosition(doc, pos)
  if (!mappedRange) return identifierRange
  if (!identifierRange) return mappedRange
  if (!mappedRange.contains(pos)) return identifierRange
  if (mappedRange.isEqual(identifierRange)) return mappedRange
  if (mappedRange.contains(identifierRange.start) && mappedRange.contains(identifierRange.end)) {
    return identifierRange
  }
  return mappedRange
}

function toLocationLinks(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  locations: vscode.Location[] | vscode.LocationLink[],
  mapLocation: (loc: vscode.Location | vscode.LocationLink) => vscode.Location | vscode.LocationLink
): vscode.LocationLink[] {
  const originSelectionRange = getIdentifierRangeAtPosition(doc, pos)

  return locations.map(location => {
    const mapped = mapLocation(location)
    if ('targetUri' in mapped) {
      return {
        ...mapped,
        originSelectionRange: originSelectionRange ?? mapped.originSelectionRange
      }
    }
    return {
      originSelectionRange,
      targetUri: mapped.uri,
      targetRange: mapped.range,
      targetSelectionRange: mapped.range
    }
  })
}

export function registerProviders(context: vscode.ExtensionContext, service: NotebookTsService): void {
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideInlayHints(doc, range, _token) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          return service.provideNotebookInlayHints(doc, query.state, query.cell, range)
        }
      }
    )
  )

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
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
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
            .map(item => service.mapCompletionItemToCell(query.state, item))
            .filter((item): item is vscode.CompletionItem => item !== null)

          return new vscode.CompletionList(items, list.isIncomplete)
        }
      },
      '.'
    )
  )

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideHover(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            query.state.virtualUri,
            vpos
          )
          if (!hover || hover.length === 0) return undefined
          const first = hover[0]
          if (first.range) {
            const mapped = service.mapVirtualRangeToCellRange(query.state, first.range)
            if (mapped) {
              const range = selectHoverRange(doc, pos, mapped.range)
              return new vscode.Hover(first.contents, range)
            }
          }
          const fallbackRange = selectHoverRange(doc, pos)
          return fallbackRange
            ? new vscode.Hover(first.contents, fallbackRange)
            : first
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDefinition(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            query.state.virtualUri,
            vpos
          )
          if (!defs) return defs
          return toLocationLinks(doc, pos, defs, d => service.mapLocationToCell(query.state, d))
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerImplementationProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideImplementation(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const impls = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeImplementationProvider',
            query.state.virtualUri,
            vpos
          )
          if (!impls) return impls
          return toLocationLinks(doc, pos, impls, loc => service.mapLocationToCell(query.state, loc))
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerTypeDefinitionProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideTypeDefinition(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeTypeDefinitionProvider',
            query.state.virtualUri,
            vpos
          )
          if (!defs) return defs
          return toLocationLinks(doc, pos, defs, loc => service.mapLocationToCell(query.state, loc))
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerDeclarationProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDeclaration(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
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
          return toLocationLinks(doc, pos, resolvedDefs, loc => service.mapLocationToCell(query.state, loc))
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideDocumentHighlights(doc, pos) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
            'vscode.executeDocumentHighlights',
            query.state.virtualUri,
            vpos
          )
          if (!highlights) return highlights
          return highlights
            .map(h => {
              const mapped = service.mapVirtualRangeToCellRange(query.state, h.range)
              return mapped ? new vscode.DocumentHighlight(mapped.range, h.kind) : null
            })
            .filter((h): h is vscode.DocumentHighlight => h !== null)
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      [
        { language: NOTEBOOK_TS_LANGUAGE, scheme: 'vscode-notebook-cell' },
        { language: JS_LANGUAGE, scheme: 'vscode-notebook-cell' }
      ],
      {
        async provideSignatureHelp(doc, pos, _token, triggerContext) {
          const query = await service.prepareQueryState(doc)
          if (!query) return undefined
          const vpos = service.mapCellPositionToVirtual(query.state, query.cell, pos)
          if (!vpos) return undefined
          return vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider',
            query.state.virtualUri,
            vpos,
            triggerContext.triggerCharacter,
            triggerContext.isRetrigger
          )
        }
      },
      '(',
      ','
    )
  )
}

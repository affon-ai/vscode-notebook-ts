import * as vscode from 'vscode'

import { JS_LANGUAGE, NOTEBOOK_TS_LANGUAGE } from '../core/constants'
import { NotebookTsService } from '../core/notebookService'

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
            if (mapped) return new vscode.Hover(first.contents, mapped.range)
          }
          return first
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
          if (service.isLocationLinkArray(defs)) {
            return defs.map(d => service.mapLocationToCell(query.state, d)) as vscode.LocationLink[]
          }
          return defs.map(d => service.mapLocationToCell(query.state, d)) as vscode.Location[]
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
          if (service.isLocationLinkArray(impls)) {
            return impls.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return impls.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.Location[]
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
          if (service.isLocationLinkArray(defs)) {
            return defs.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return defs.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.Location[]
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
          if (service.isLocationLinkArray(resolvedDefs)) {
            return resolvedDefs.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.LocationLink[]
          }
          return resolvedDefs.map(loc => service.mapLocationToCell(query.state, loc)) as vscode.Location[]
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

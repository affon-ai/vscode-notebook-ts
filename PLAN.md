# TypeScript Notebook Support Plan

## Goal

Make this extension the primary TypeScript experience owner for notebook cells while still using VS Code's built-in TypeScript service to analyze a generated virtual `.ts` file.

## Architecture Direction

1. Introduce a dedicated notebook cell language id such as `typescript-notebook`.
2. Register this extension's providers against `typescript-notebook` rather than plain `typescript`.
3. Keep the generated virtual analysis file as plain `typescript`.
4. Use the built-in TypeScript extension only as the analysis engine for the virtual file.
5. Map TypeScript results from the virtual file back into notebook cells.
6. Keep generated virtual files as an implementation detail and avoid surfacing them in normal editor workflows.

This avoids competing directly with the built-in TypeScript providers on `vscode-notebook-cell` documents whose language id is `typescript`.

## Diagnostic Strategy

Notebook execution semantics do not always match normal TypeScript file semantics. The first concrete mismatch to handle is duplicate top-level declarations across cells.

Decision:
- Suppress notebook-misleading duplicate declaration diagnostics during diagnostic mapping.
- Keep notebook cell source unchanged, but allow virtual-file-only transforms when needed for notebook compatibility.
- Make suppression extendable through a rule-based filter layer rather than one-off hardcoded checks.

Desired implementation shape:
- Collect diagnostics from the virtual TypeScript file.
- Map each diagnostic into notebook-cell coordinates.
- Run mapped diagnostics through a suppression pipeline.
- Publish only the remaining diagnostics.

The suppression pipeline should support multiple narrow rules so future notebook-specific false positives can be handled without changing the overall design.

## Priority Tiers

### Must-Have

- `hover`
  - Example: hover a symbol in one cell and see the correct cross-cell type or signature from another cell.
  - Effort: low to medium.
  - Status: implemented and verified.

- `definition`
  - Example: jump from a symbol use in one cell to its defining declaration in another cell.
  - Effort: low to medium.
  - Status: implemented and verified.

- `implementation`
  - Example: jump from `interface Model` method to a concrete implementation in another cell.
  - Effort: low to medium.
  - Status: implemented.

- `type definition`
  - Example: jump from a typed symbol to its type alias or interface declaration in another cell.
  - Effort: low to medium.
  - Status: implemented.

- `declaration`
  - Example: jump from a symbol use to its declared symbol location across cells.
  - Effort: low to medium.
  - Status: partial. Provider wiring exists, but notebook editor command routing is not reliable enough to treat this as complete.

- `semantic tokens`
  - Example: TS-aware highlighting for interfaces, classes, parameters, properties, and type aliases inside notebook cells.
  - Effort: high.
  - Status: blocked under the current delegation architecture. There is no practical public `execute...` command path to retrieve built-in TypeScript semantic tokens from the virtual file and remap them back into notebook cells. Completing this feature likely requires a custom semantic-token implementation using the TypeScript compiler API rather than the current execute-command forwarding pattern.

- `inlay hints`
  - Example: parameter name hints for `greet(user, true)` and type hints like `const message: string`.
  - Effort: medium.
  - Status: partial. Provider wiring exists, and raw hints can be produced for the generated `.ts` file when it is explicitly opened, but notebook-cell inlay support is not reliable enough to count as working.

- Notebook-misleading diagnostic suppression
  - Example: suppress duplicate top-level declaration errors that arise from notebook redefinition patterns.
  - Effort: low.
  - Status: initial framework implemented, with duplicate top-level declaration suppression support designed to be extendable.

- Notebook top-level rebinding compatibility
  - Example: repeated top-level `const a = tensor(...)` across cells is allowed when the effective type remains compatible.
  - Effort: medium.
  - Status: implemented as a virtual-file-only rewrite of top-level `const`/`let` bindings to offset-preserving `var`.
  - Limitation: this supports same-type or type-compatible rebinding only. Cross-type rebinding is still unsupported under the current TypeScript single-file analysis model.

### Lower Priority

- `document symbols`
  - Example: notebook outline showing `loadData`, `Trainer`, `Config`, and `HousingRow`.
  - Effort: low to medium.

- `document formatting` / `range formatting`
  - Example: format one cell or a selected block using TypeScript formatting rules.
  - Effort: medium.

### Very Low Priority

- `code actions` / `quick fixes`
- `rename`
- `references`
- `workspace symbols`
- `call hierarchy`
- `type hierarchy`
- `code lens`
- `selection ranges`
- `folding ranges`
- `linked editing`
- `refactor actions`
- `on-type formatting`

These are useful, but not currently central to the intended notebook-local TypeScript experience.

## Prioritization Principle

1. Prioritize notebook-local, cross-cell TypeScript intelligence.
2. Prefer read-only navigation and semantic understanding before edit-heavy tooling.
3. De-prioritize cross-notebook and workspace-wide features because a notebook is treated as a standalone unit most of the time.
4. Avoid semantic source rewriting unless diagnostic suppression proves insufficient.

## Near-Term Execution Order

1. Add dedicated notebook language ownership via `typescript-notebook`.
2. Add the diagnostic suppression framework and the first duplicate-declaration suppression rule.
3. Implement `hover` and `definition`.
4. Implement `implementation`.
5. Implement `type definition`.
6. Investigate `declaration`.
7. Investigate `semantic tokens`.

## Current Status

Completed:
- Dedicated notebook language ownership via `typescript-notebook`
- Syntax highlighting restored for `typescript-notebook`
- Virtual-file-backed provider ownership retained
- Virtual file names switched to stable short hashes
- Generated virtual files no longer auto-open in editor tabs during normal notebook use
- Notebook-open flow now cleans and rebuilds that notebook's virtual artifacts
- Virtual notebook `tsconfig.json` is the source of truth for ambient notebook types
- `typeRoots` directories are also added to generated `include` globs so loose `.d.ts` files like `globals.d.ts` are part of the notebook project
- Extendable diagnostic suppression framework
- Initial duplicate top-level declaration suppression rule
- Virtual-file top-level binding rewrite for same-type rebinding compatibility
- `hover`
- `definition`
- `implementation`
- `type definition`
- `completion`

Partially complete:
- `declaration`
  - The provider is registered and falls back to definition, but notebook editor `Go to Declaration` behavior is still not reliable enough to count as finished.

Blocked:
- `semantic tokens`
  - This does not fit the current execute-command forwarding architecture because there is no practical public execute-command path for built-in TypeScript semantic tokens.
  - A future implementation will likely need a custom semantic-token provider powered by the TypeScript compiler API over the generated virtual file.

Known limitations:
- Cross-type top-level rebinding is still unsupported.
  - Example: rebinding `a` from `NDArray` in one cell to `Tensor` in a later cell does not model notebook runtime semantics correctly.
  - Current behavior intentionally supports only same-type or otherwise type-compatible rebinding under the `var`-rewrite compromise.
- Inlay hints are not reliable in notebook cells yet.
  - Raw hints can be returned for the generated `.notebook-ts/*.ts` file when that file is explicitly opened, but that behavior is not stable through the notebook-cell flow.
- Verification notebooks are maintained in the sibling `affon/notebook-tests/` folder as local/manual test assets rather than extension-repo fixtures.

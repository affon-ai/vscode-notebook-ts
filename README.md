# TypeScript/JavaScript Notebook Support

VS Code extension that provides cross-cell TypeScript/JavaScript diagnostics in Jupyter notebooks by
concatenating all TypeScript/JavaScript cells into a virtual document analyzed by the TypeScript language server.

TypeScript notebook cells are adopted into the extension-owned `typescript-notebook` language id so the extension can provide notebook-specific language features while still analyzing a generated virtual `.ts` file.

## How It Works

1. **Virtual document build**
  - TypeScript notebook code cells are switched to `typescript-notebook`.
  - TypeScript/JavaScript code cells are concatenated into a single virtual `.ts` file.
  - The virtual file is written to `./.notebook-ts/` in the workspace.
  - A generated virtual `tsconfig.json` carries project options like `typeRoots` for notebook analysis.

2. **Line mapping**
   - The extension records a line range for each cell in the virtual document.
   - This mapping is used to translate diagnostics and language features back to cell positions.

3. **Language server interaction**
   - VS Code’s built‑in TypeScript extension (tsserver) analyzes the virtual file.
   - The extension forwards completion, hover, definition, implementation, type definition, document highlights, and signature help through `vscode.execute*` commands and maps results back to cells.
   - Inlay hints are produced through a local TypeScript language service over the generated virtual file.

4. **Incremental sync**
   - Cell edits update only the affected slice of the virtual file.
   - Background flush keeps diagnostics and the virtual file consistent without slowing typing.

## Build

```bash
npm install
npm run build
```

## Run in VS Code

- Open this repo in VS Code
- Run the extension via the VS Code Extension Host (F5)
- Open a Jupyter notebook with TypeScript cells
- For best results, use the Jupyter TypeScript kernel powered by the Affon TypeScript runtime in VS Code: https://github.com/affon-ai/affon

## Configuration

- `notebookTs.tsconfigPath`: Path to a `tsconfig.json` used to source `compilerOptions.typeRoots`. If set, it takes precedence.
- `notebookTs.typeRoots`: Directories containing `.d.ts` files to include when no `tsconfigPath` is set.

## Commands

- `Notebook TS: Dump Virtual Document` prints the virtual document and resolved configuration to the output channel.

## Notes

- Provides diagnostics, hover, definition, implementation, type definition, document highlights, completion (triggered on `.`), inlay hints, and signature help (triggered on `(` and `,`) mapped back to cells.
- `Go to Declaration` is still partial and not reliable enough to treat as a completed feature.
- Duplicate top-level declaration diagnostics are filtered through notebook-specific suppression rules during mapping.
- The extension writes generated analysis files under `./.notebook-ts/`, including a notebook-local `tsconfig.json`.
- Same-type top-level rebinding across cells is supported through a virtual-file-only rewrite of top-level `const`/`let` bindings. Cross-type rebinding is still unsupported.
- It does not use kernel runtime state; it is purely static analysis.

# TypeScript/JavaScript Notebook Support

VS Code extension that provides cross-cell TypeScript/JavaScript diagnostics in Jupyter notebooks by
concatenating all TypeScript/JavaScript cells into a virtual document analyzed by the TypeScript language server.

## How It Works

1. **Virtual document build**
   - All TypeScript/JavaScript code cells are concatenated into a single virtual `.ts` file.
   - The virtual file is written to `./.notebook-ts/` in the workspace.
   - `/// <reference ...>` lines are injected from `typeRoots` to load ambient typings.

2. **Line mapping**
   - The extension records a line range for each cell in the virtual document.
   - This mapping is used to translate diagnostics and language features back to cell positions.

3. **Language server interaction**
   - VS Code’s built‑in TypeScript extension (tsserver) analyzes the virtual file.
   - The extension forwards requests (completion, hover, definition, signature help) to tsserver using `vscode.execute*` commands and maps results back to cells.

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

- Provides diagnostics, hover, definition, document highlights, completion (triggered on `.`), and signature help (triggered on `(` and `,`) mapped back to cells.
- The extension writes a virtual TypeScript file under `./.notebook-ts/` in the workspace. If this folder is excluded by your `tsconfig` `include`, add it (e.g. `".notebook-ts/**/*.ts"`).
- Autocomplete and signature help rely on the virtual file being included in the workspace TS project.
- VS Code's built-in TypeScript diagnostics still run on each cell document independently, so some warnings (e.g. unused locals across cells) may appear even when the virtual doc is correct.
- It does not use kernel runtime state; it is purely static analysis.

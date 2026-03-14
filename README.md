# TypeScript Notebook Support

Minimal VS Code extension that provides cross-cell TypeScript diagnostics in Jupyter notebooks by
concatenating all TypeScript cells into a virtual document analyzed by the TypeScript language server.

## Build

```bash
npm install
npm run build
```

## Run in VS Code

- Open this repo in VS Code
- Run the extension via the VS Code Extension Host (F5)
- Open a Jupyter notebook with TypeScript cells
- For best results, use the [Jupter typescript kernel](https://github.com/affon-ai/affon) powered by [Affon TypeScript Runtime](https://github.com/affon-ai/affon) in VS Code.

## Configuration

- `notebookTs.tsconfigPath`: Path to a `tsconfig.json` used to source `compilerOptions.typeRoots`. If set, it takes precedence.
- `notebookTs.typeRoots`: Directories containing `.d.ts` files to include when no `tsconfigPath` is set.

## Commands

- `Notebook TS: Dump Virtual Document` prints the virtual document and resolved configuration to the output channel.

## Notes

- Provides diagnostics, hover, definition, document highlights, and basic completion mapped back to cells.
- It does not use kernel runtime state; it is purely static analysis.

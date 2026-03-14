# Affon TypeScript Notebook Support

Minimal VS Code extension that provides cross-cell TypeScript diagnostics in Jupyter notebooks by
concatenating all TypeScript cells into a virtual document analyzed by the TypeScript language server.

## Build

```bash
cd tools/vscode-notebook-ts
npm install
npm run build
```

## Run in VS Code

- Open this repo in VS Code
- Run the extension via the VS Code Extension Host (F5)
- Open a Jupyter notebook with TypeScript cells

## Notes

- This MVP only forwards diagnostics. Completion/hover can be added later.
- It does not use kernel runtime state; it is purely static analysis.

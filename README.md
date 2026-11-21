# fin-lsp

A Language Server Protocol server for the [Fin programming language](https://github.com/M1778/Fin).

One server serves every editor that speaks LSP: Neovim, Helix, Emacs (eglot/lsp-mode),
Zed, Sublime Text, and any VS Code client. It is a standalone Node program with **no
runtime dependencies** — the JSON-RPC framing, the document model, and the standard
library index are all in this repository.

## What it does

| Feature | Method | Notes |
| --- | --- | --- |
| Diagnostics | `textDocument/publishDiagnostics` | Real `finc` output, debounced, cancel-safe |
| Hover | `textDocument/hover` | Standard library and same-file declarations |
| Completion | `textDocument/completion` | 900+ real stdlib declarations plus the open buffer |
| Outline | `textDocument/documentSymbol` | `fun`, `struct`, `const`, `namespace`, `@define` |
| Formatting | `textDocument/formatting` | Via `finfmt`, idempotent |
| Definition | `textDocument/definition` | Import names and same-file declarations |
| Explain a code | `workspace/executeCommand` | `fin.explainDiagnostic` → `finc --explain` |
| Restart | `workspace/executeCommand` | `fin.restart` re-resolves tools and rebuilds the index |

## Requirements

- **Node 20 or newer.**
- **The Fin compiler** (`finc`), at least version 1.0.1. Diagnostics do nothing without it.
- **`finfmt`** for formatting. Everything else works without it.
- **The Fin standard library sources** (`lib/std/*.fin`) for hover, completion and
  import definition.

`finc` is not on `npm`. Build it from the Fin repository with `./build.sh`, which by
default puts it at `build/finc` and the formatter at `build/tools/fmt/finfmt`.

## Install

```sh
git clone https://github.com/M1778/fin-lsp
cd fin-lsp
npm install
npm run build
npm link          # optional: puts `fin-lsp` on PATH
```

Then check it is runnable:

```sh
node dist/src/cli.js --version      # fin-lsp 0.1.0
node dist/src/cli.js --help
```

No build step is needed by editors if you point them at `dist/src/cli.js` after building.
The published tarball already contains `dist/`, so `npm install fin-lsp` (or
`npx fin-lsp --stdio`) runs without a compiler toolchain.

Installing straight from Git also works, but git installs run `prepare`, so they build
locally and therefore need the dev dependencies:

```sh
npx --yes --package=github:M1778/fin-lsp fin-lsp --stdio
```

## Configuration

The server reads settings from `initializationOptions.fin` and from
`workspace/didChangeConfiguration`. The keys are the same in every editor.

| Setting | Default | Meaning |
| --- | --- | --- |
| `fin.compilerPath` | `""` | Absolute path to `finc`. Empty means search `PATH`, then `/home/M1778/Fin/build/finc`. |
| `fin.formatterPath` | `""` | Absolute path to `finfmt`. Empty means search `PATH`, then `/home/M1778/Fin/build/tools/fmt/finfmt`. |
| `fin.stdlibPath` | `""` | Directory of `*.fin` standard library sources. Empty means `<compiler dir>/../lib/std`, then `/home/M1778/Fin/lib/std`. |
| `fin.debounceMs` | `300` | Wait after the last keystroke before type-checking. `0` checks immediately. |
| `fin.timeoutMs` | `20000` | How long one `finc` or `finfmt` run may take before it is killed. |
| `fin.extraArgs` | `[]` | Extra arguments passed to `finc`, for example `["-I", "/path/to/lib"]`. |

A configured path that does not exist is **not** silently replaced by a `PATH` lookup:
the server reports that the compiler is missing so a typo cannot masquerade as a clean
file.

## Editor setup

### Neovim (0.10+, built-in LSP)

```lua
vim.lsp.config('fin_lsp', {
  cmd = { 'node', '/absolute/path/to/fin-lsp/dist/src/cli.js', '--stdio' },
  filetypes = { 'fin' },
  root_markers = { '.git' },
  init_options = {
    fin = {
      compilerPath = '/home/you/Fin/build/finc',
      stdlibPath = '/home/you/Fin/lib/std',
    },
  },
})
vim.lsp.enable('fin_lsp')
```

Neovim needs to know the filetype. If no Fin filetype plugin is installed:

```lua
vim.filetype.add({ extension = { fin = 'fin' } })
```

### Helix

`~/.config/helix/languages.toml`:

```toml
[language-server.fin-lsp]
command = "node"
args = ["/absolute/path/to/fin-lsp/dist/src/cli.js", "--stdio"]
config = { fin = { compilerPath = "/home/you/Fin/build/finc", stdlibPath = "/home/you/Fin/lib/std" } }

[[language]]
name = "fin"
scope = "source.fin"
file-types = ["fin"]
comment-token = "//"
language-servers = ["fin-lsp"]
indent = { tab-width = 4, unit = "    " }
```

### Emacs (eglot, Emacs 29+)

```elisp
(add-to-list 'eglot-server-programs
             '(fin-mode . ("node" "/absolute/path/to/fin-lsp/dist/src/cli.js" "--stdio")))
```

Settings can be set per project with `.dir-locals.el`:

```elisp
((fin-mode . ((eglot-workspace-configuration
               . (:fin (:compilerPath "/home/you/Fin/build/finc"
                       :stdlibPath "/home/you/Fin/lib/std"))))))
```

### VS Code

There is no published extension in this repository; a minimal client is two files.

`package.json`:

```json
{
  "name": "fin-lsp-client",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onLanguage:fin"],
  "main": "./extension.js",
  "contributes": {
    "languages": [{ "id": "fin", "extensions": [".fin"] }],
    "configuration": {
      "title": "Fin",
      "properties": {
        "fin.compilerPath": { "type": "string", "default": "" },
        "fin.stdlibPath": { "type": "string", "default": "" }
      }
    }
  },
  "dependencies": { "vscode-languageclient": "^9.0.0" }
}
```

`extension.js`:

```js
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const path = require('path');
let client;
async function activate(context) {
  const config = require('vscode').workspace.getConfiguration('fin');
  client = new LanguageClient(
    'fin-lsp',
    'Fin Language Server',
    {
      command: 'node',
      args: [path.join(__dirname, 'fin-lsp/dist/src/cli.js'), '--stdio'],
      transport: TransportKind.stdio,
    },
    {
      documentSelector: [{ scheme: 'file', language: 'fin' }],
      initializationOptions: {
        fin: {
          compilerPath: config.get('compilerPath'),
          stdlibPath: config.get('stdlibPath'),
        },
      },
      synchronize: { configurationSection: 'fin' },
    },
  );
  await client.start();
}
function deactivate() { return client?.stop(); }
module.exports = { activate, deactivate };
```

Put a built copy of this repository in `fin-lsp/` beside those files. For a real
installation, vendor `dist/` and add `.vscodeignore` entries for `src/` and `test/`.

### Anything else

Any LSP client works. Spawn `node <repo>/dist/src/cli.js --stdio` and speak LSP 3.17
over stdin/stdout.

## Commands

| Command | Arguments | Effect |
| --- | --- | --- |
| `fin.explainDiagnostic` | `["E0301"]` or `[{"code":"E0301"}]` | Runs `finc --explain <code>` and returns the text; also written to the client log. |
| `fin.restart` | none | Re-resolves `finc`/`finfmt`, rebuilds the stdlib index, re-checks every open file, and re-arms the missing-tool messages. |
| `fin.rebuildStdlibIndex` | none | Rebuilds the index without touching open files; returns the module count. |

`fin.rebuildStdlibIndex` and `fin.restart` are the documented way to pick up standard
library changes. The index is also rebuilt automatically when a watched file under
`fin.stdlibPath` changes.

## How diagnostics work

1. The buffer is written to a unique `.fin` file in the OS temp directory. The real file
   is never modified.
2. `finc` runs on that copy with its working directory set to the document's directory,
   plus `-I <document dir>` and `-I <stdlib>`, so relative imports resolve exactly as they
   do for the real file.
3. `--diagnostics=json --color=never` is parsed line by line. **`finc` 1.0.1 writes that
   JSON stream to stderr, not stdout**, so both streams are read and only well-formed
   objects with a `kind` are accepted.
4. Positions are converted: the compiler is 1-based with an exclusive `endColumn`; LSP is
   0-based with an exclusive end.
5. Runs are debounced (300 ms by default), the previous run is killed, and every result
   carries the document version and a generation number. A result older than the current
   buffer is discarded rather than published.

### Byte columns, not character columns

`finc` reports **1-based byte offsets within the line**. LSP positions are **UTF-16 code
units**. Those differ as soon as a line contains non-ASCII text:

```fin
fun main() <noret> { printf("😀é"); Unknown(); }
```

`Unknown` is byte 39 (column 40) and UTF-16 offset 36. The server converts every column
by walking the real document line, so the squiggle lands on the identifier and not two
characters later. A byte offset that lands inside a multi-byte character clamps to that
character's start. CRLF files are handled: the line terminator is not part of the line
text, and the compiler's byte offsets skip it too.

### Failure is visible

- **`finc` missing:** one `window/showMessage` (error) naming `fin.compilerPath`, plus a
  warning diagnostic on the document reading *"Not checked: the Fin compiler was not
  found."* The file is never reported as clean.
- **`finc` crashes** (non-zero exit and no JSON): one message with the first lines of
  stderr, plus an error diagnostic `fin-lsp/compiler-crashed` on line 0.
- **`finfmt` missing:** one warning message; formatting returns no edits.
- **The standard library is missing:** one warning; hover and completion return nothing.

## What is not supported

Being explicit is cheaper than a wrong answer.

- **Locals, fields, members, and generic arguments have no definition or hover from
  expression context.** `textDocument/definition` answers for import names, same-file
  top-level declarations, and standard library names; anything else returns `null`. Hover
  answers for top-level declarations and stdlib names only.
- **No find-references, rename, code actions, semantic tokens, signature help, or
  workspace symbols.** Diagnostics for files other than the one being checked are not
  re-homed onto their own documents; they are written to the client log instead.
- **No cross-file diagnostics for imported modules.** Imported files are indexed for
  symbols, not type-checked individually.
- **Method and nested declarations are not in the outline.** Only column-zero
  declarations appear, so a 350-line struct does not bury the module symbols.
- **Formatting is whole-document only**, and `finfmt` normalises CRLF to LF, as the
  tool itself does.
- **No syntax highlighting.** Use the maintained TextMate grammar at
  `Fin/editors/textmate/fin.tmLanguage.json`; that is the editor's job, not the server's.
- **Windows is supported by the code** (argv arrays, no shell, `finc.exe` resolution,
  `os.tmpdir()`) but this release was developed on Linux; see CI for the tested matrix.

## Development

```sh
npm test              # build, then unit + integration tests
npm run test:unit     # framing, document model, positions, index
npm run test:real     # integration tests that need the real finc/finfmt
```

The integration tests spawn `dist/src/cli.js`, speak LSP over stdio, and assert against a
real `.fin` file with a real error. They are the proof that the wire protocol works, not
just the helpers.

Layout:

| Path | Purpose |
| --- | --- |
| `src/framing.ts` | `Content-Length` framing, byte-accurate, incremental reader |
| `src/document.ts` | Incremental text buffer, UTF-16 positions, CRLF-aware lines |
| `src/positions.ts` | `finc` JSON → LSP diagnostics, byte→UTF-16 column conversion |
| `src/declarations.ts` | Comment/string-aware declaration scanner |
| `src/stdlib.ts` | `lib/std` index: signatures, doc comments, module headers |
| `src/imports.ts` | Import parsing and module resolution |
| `src/compiler.ts` | `finc`/`finfmt` invocation, staging, output classification |
| `src/process.ts` | argv-only spawning, tool resolution, timeouts, cancellation |
| `src/server.ts` | LSP methods, debounce, generation guards |
| `src/cli.ts` | stdio entry point |

## Reporting a bug

Open an issue at <https://github.com/M1778/fin-lsp/issues> with:

- `node dist/src/cli.js --version`, `finc --version`, your editor and client version;
- the smallest `.fin` file that reproduces it;
- the server's stderr (most clients have a "Language Server" output/log panel).

## Licence

MIT. See [LICENSE](LICENSE).

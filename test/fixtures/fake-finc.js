#!/usr/bin/env node
// =============================================================================
// Fin Programming Language
//
// Made with ❤️ for someone special.
//
// This project is genuinely built on love and dedication, a way to express your love can be done through Fin.
// Fin is a semi-object-orientated programming language that specialized in control, giving so much control to the user while asking for the bare minimum.
// Fin is the name of the Angel from BlackNightmare-Stories not yet published.
// “Love is the reason this project exists”
// -----------------------------------------------------------------------------
// Author: M1778
// Repository: https://github.com/M1778/fin-lsp
// Profile: https://github.com/M1778M/
// -----------------------------------------------------------------------------
// Copyright (C) 2027 M1778
//
// This file is part of fin-lsp, a project for the Fin Programming Language.
//
// Licensed under the MIT License. See LICENSE in the repository root.
//
// SPDX-License-Identifier: MIT
// =============================================================================

/**
 * A stand-in `finc` for CI machines that do not have the Fin compiler built.
 *
 * It is a real executable script that honours the argument contract the server
 * depends on: read the file argument, print a JSONL diagnostic stream, exit
 * non-zero when a diagnostic was emitted. Its behaviour is driven by markers in
 * the source, so a test can ask for a clean file, a diagnostic, a crash, or a
 * slow answer without needing the real compiler.
 *
 * Written as a Node script with a shebang: on Windows the CI job copies
 * `node.exe` to `finc.exe` and sets NODE_OPTIONS to preload this file, which is
 * why it must also work when `require`d rather than executed.
 */

const fs = require('fs');

function emit(record) {
  process.stderr.write(JSON.stringify(record) + '\n');
}

function main(argv) {
  const args = argv;
  if (args[0] === '--version') {
    process.stdout.write('finc 1.0.1 (contract 3) fake\n');
    return 0;
  }
  if (args[0] === '--explain') {
    const code = args[1];
    if (code === 'E0301') {
      process.stdout.write('E0301 (error): a name was used that nothing in scope declares\n');
      return 0;
    }
    process.stderr.write(`error: '${code}' is not a diagnostic code this finc raises\n`);
    return 2;
  }
  const file = args.find((argument) => !argument.startsWith('-'));
  if (!file) {
    process.stderr.write('fake finc: no input file\n');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    emit({ kind: 'diagnostic', severity: 'error', code: null, message: `could not read file: ${file}` });
    emit({ kind: 'summary', errors: 1, warnings: 0, exitCode: 2, status: 'failed' });
    return 2;
  }
  if (text.includes('CRASH')) {
    process.stderr.write('fake finc: internal compiler error\n');
    return 3;
  }
  if (text.includes('SLOW')) {
    // A slow answer that a newer edit must supersede.
    const end = Date.now() + 1200;
    while (Date.now() < end) {
      /* spin, deliberately blocking */
    }
    emit({ kind: 'diagnostic', severity: 'error', code: 'E9999', message: 'stale result', file, line: 1, column: 1, endLine: 1, endColumn: 2 });
    emit({ kind: 'summary', errors: 1, warnings: 0, exitCode: 1, status: 'failed' });
    return 1;
  }
  const marker = /DIAG (\d+):(\d+):(\d+):(\d+) (.*)/.exec(text);
  if (marker) {
    emit({
      kind: 'diagnostic',
      severity: 'error',
      code: 'E0201',
      message: marker[5],
      file,
      line: Number(marker[1]),
      column: Number(marker[2]),
      endLine: Number(marker[1]),
      endColumn: Number(marker[4]),
    });
    emit({ kind: 'summary', errors: 1, warnings: 0, exitCode: 1, status: 'failed' });
    return 1;
  }
  emit({ kind: 'summary', errors: 0, warnings: 0, exitCode: 0, status: 'ok' });
  return 0;
}

function installShim() {
  // Windows CI cannot spawn a `.js` file without a shell, so `node.exe` is
  // copied to `finc.exe` and this file is preloaded through NODE_OPTIONS. Only
  // the copy acts as the compiler; any other Node process loaded through the
  // same NODE_OPTIONS must keep running normally.
  if (!/finc(\.exe)?$/i.test(process.execPath || '')) return;
  // Spawned as `finc.exe <file> ...`, so argv[1] is the first real argument;
  // the script/module path is not part of argv in this mode.
  process.exit(main(process.argv.slice(1)));
}

module.exports = { installShim };
if (require.main === module) process.exit(main(process.argv.slice(2)));
// Preloaded as a module on Windows: act only when argv[0] is the finc copy.
if (require.main !== module) installShim();

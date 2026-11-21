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

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeCompiler {
  /** Absolute path to pass as `fin.compilerPath`. */
  command: string;
  /** Extra environment the server process must inherit. */
  env: Record<string, string>;
}

/**
 * Build a shell-less stand-in for `finc`.
 *
 * POSIX: a two-line `sh` wrapper around the Node script. Windows: `.js` is not a
 * spawnable image and `.cmd` needs a shell, which the server deliberately never
 * uses, so `node.exe` is copied to `finc.exe` and `NODE_OPTIONS` preloads the
 * script. The preload only acts when `argv[0]` is that copy, so the copied
 * binary behaves like a compiler and every other Node process is untouched.
 */
export function makeFakeCompiler(directory: string, script: string): FakeCompiler {
  if (process.platform === 'win32') {
    const executable = path.join(directory, 'finc.exe');
    fs.copyFileSync(process.execPath, executable);
    return {
      command: executable,
      env: { NODE_OPTIONS: `--require "${script.replace(/\\/g, '/')}"` },
    };
  }
  const launcher = path.join(directory, 'finc');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  fs.chmodSync(launcher, 0o755);
  return { command: launcher, env: {} };
}

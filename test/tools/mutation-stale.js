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
 * Mutation check for the stale-result guard.
 *
 * A test that passes whether or not the guard exists proves nothing. This
 * script patches the compiled guard to always allow publication, runs only the
 * stale-result test, and fails if the test still passes. It is not part of
 * `npm test` because it rewrites `dist/`; run it by hand after touching
 * `runCheck`.
 *
 *   npm run build && node test/tools/mutation-stale.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'dist', 'src', 'server.js');

const original = fs.readFileSync(SERVER, 'utf8');
const start = original.indexOf('if (controller.signal.aborted');
const end = original.indexOf('return;', original.indexOf('live.getText() !== checkedText'));
if (start < 0 || end < 0) {
  console.error('mutation-stale: could not find the stale-result guard in dist/src/server.js');
  process.exit(1);
}
const close = original.indexOf('}', end) + 1;
const mutated = original.slice(0, start) + 'if (false) { return; }' + original.slice(close);
if (mutated === original) {
  console.error('mutation-stale: patch produced no change');
  process.exit(1);
}
fs.writeFileSync(SERVER, mutated);
let failed = false;
const CAP = 45000;
try {
  const output = execFileSync(
    process.execPath,
    ['--test', '--test-name-pattern=slow result', path.join(ROOT, 'dist', 'test', 'failures.test.js')],
    { encoding: 'utf8', stdio: 'pipe', timeout: CAP },
  );
  // A passing run means the test did not detect the removed guard.
  failed = true;
  console.error('mutation-stale: FAIL — the stale-result test passed without the guard.');
  console.error(output.split('\n').filter((line) => /✔|✖|pass|fail/.test(line)).join('\n'));
} catch (error) {
  const timedOut = error.killed || error.signal === 'SIGTERM';
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (timedOut) {
    // Without the guard the stale publish lands, and the assertion failure is
    // what the test recorded; a hang means the assertion never even got to run.
    console.error(`mutation-stale: the test timed out after ${CAP} ms, which is not a clean detection.`);
    failed = true;
  } else if (!/✖|not ok|failed/.test(text)) {
    console.error('mutation-stale: the test failed for the wrong reason:');
    console.error(text.slice(0, 2000));
    failed = true;
  } else {
    console.log('mutation-stale: ok — removing the guard makes the test fail.');
  }
} finally {
  fs.writeFileSync(SERVER, original);
  // Rebuild so the working dist/ matches src/ again.
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'tsconfig.json')], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: CAP,
    });
  } catch {
    console.error('mutation-stale: warning — rebuild after mutation failed; run npm run build');
  }
}
process.exit(failed ? 1 : 0);

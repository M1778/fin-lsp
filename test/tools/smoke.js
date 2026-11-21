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
 * A one-shot smoke test with no test framework: spawn the built server, send
 * `initialize`, print the capabilities, and exit cleanly.
 *
 * CI runs this separately from the test suite because it proves the packaged
 * entry point (`dist/src/cli.js`) starts under `node`, not merely that the
 * modules import.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'dist', 'src', 'cli.js');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function parseFrames(buffer, onMessage) {
  const separator = Buffer.from('\r\n\r\n', 'ascii');
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf(separator);
    if (end < 0) return rest;
    const header = rest.subarray(0, end).toString('ascii');
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length)) throw new Error(`bad header: ${header}`);
    const start = end + separator.length;
    if (rest.length < start + length) return rest;
    onMessage(JSON.parse(rest.subarray(start, start + length).toString('utf8')));
    rest = rest.subarray(start + length);
  }
}

const child = spawn(process.execPath, [CLI, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
let pending = Buffer.alloc(0);
let capabilities = null;
const timer = setTimeout(() => {
  console.error('smoke: timed out waiting for initialize');
  child.kill('SIGKILL');
  process.exit(1);
}, 15000);

child.stdout.on('data', (chunk) => {
  pending = parseFrames(Buffer.concat([pending, chunk]), (message) => {
    if (message.id === 1 && message.result) {
      capabilities = message.result.capabilities;
      child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }));
    } else if (message.id === 2) {
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit', params: {} }));
    }
  });
});

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`smoke: server exited ${code}`);
    process.exit(1);
  }
  if (!capabilities || capabilities.textDocumentSync.change !== 2) {
    console.error('smoke: initialize did not announce incremental sync');
    process.exit(1);
  }
  console.log(
    `smoke: ok — incremental sync, ${Object.keys(capabilities).length} capabilities, exit ${code}`,
  );
});

child.stdin.write(
  frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } }),
);

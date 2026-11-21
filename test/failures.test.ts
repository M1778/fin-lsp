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
 * Failure-mode tests that need a compiler whose behaviour the test controls.
 *
 * A crashed compiler and a stale result cannot be produced reliably with the
 * real `finc` (it either works or it does not), so these use the fake compiler
 * in `test/fixtures/fake-finc.js`. The behaviour under test -- visible failure
 * and generation guards -- is the server's, not the compiler's, so a stand-in is
 * a fair subject. The real compiler is exercised in integration.test.ts.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { MessageReader, encodeMessage } from '../src/framing';
import { makeFakeCompiler } from './support/fake-compiler';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const FAKE_SCRIPT = path.join(__dirname, '..', '..', 'test', 'fixtures', 'fake-finc.js');
// Built once per test process; the stand-in is a launcher, not a copy of the
// server, so one directory is enough.
const FAKE = makeFakeCompiler(fs.mkdtempSync(path.join(os.tmpdir(), 'fin-lsp-fake-')), FAKE_SCRIPT);

class Harness {
  readonly child;
  readonly inbox: any[] = [];
  private reader: MessageReader;
  private waiters: Array<{ predicate: (message: any) => boolean; resolve: (message: any) => void; timer: NodeJS.Timeout }> = [];
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, [CLI, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...FAKE.env },
    });
    this.reader = new MessageReader((message) => {
      this.inbox.push(message);
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].predicate(message)) {
          const waiter = this.waiters.splice(i, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return;
        }
      }
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.reader.push(chunk));
    this.child.stderr.on('data', () => undefined);
  }

  write(message: unknown): void {
    this.child.stdin.write(encodeMessage(message));
  }

  async initialize(options: Record<string, unknown>): Promise<void> {
    await this.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      initializationOptions: { fin: options },
    });
    this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const response = this.waitFor((message) => message.id === id && message.method === undefined);
    this.write({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  waitFor(predicate: (message: any) => boolean, timeoutMs = 8000): Promise<any> {
    const found = this.inbox.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; last messages ${JSON.stringify(this.inbox.slice(-4))}`)), timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async stop(): Promise<void> {
    this.write({ jsonrpc: '2.0', method: 'exit', params: {} });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      this.child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fin-lsp-fail-'));
}

test('a crashing compiler is reported, not treated as a clean file', async () => {
  const directory = tempDir();
  const source = 'fun main() <noret> {\n    // CRASH\n}\n';
  const file = path.join(directory, 'crash.fin');
  fs.writeFileSync(file, source);
  const uri = 'file://' + file;
  const harness = new Harness();
  await harness.initialize({ compilerPath: FAKE.command });
  const message = harness.waitFor(
    (candidate) => candidate.method === 'window/showMessage' && /failed without a diagnostic report/.test(candidate.params.message),
  );
  const diagnostics = harness.waitFor(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.diagnostics.length > 0,
  );
  harness.write({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'fin', version: 1, text: source } },
  });
  assert.match((await message).params.message, /not checked/i);
  const published = (await diagnostics).params;
  assert.equal(published.diagnostics[0].code, 'fin-lsp/compiler-crashed');
  assert.equal(published.diagnostics[0].severity, 1);
  assert.match(published.diagnostics[0].message, /not checked/i);
  await harness.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a slow result cannot overwrite the answer for a newer edit', async () => {
  const directory = tempDir();
  // The first content asks the fake compiler to be slow; the revision is clean.
  const slow = 'fun main() <noret> {\n    // SLOW\n}\n';
  const clean = 'fun main() <noret> {\n}\n';
  const file = path.join(directory, 'stale.fin');
  fs.writeFileSync(file, slow);
  const uri = 'file://' + file;
  const harness = new Harness();
  await harness.initialize({ compilerPath: FAKE.command, debounceMs: 0 });
  harness.write({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'fin', version: 1, text: slow } },
  });
  // Replace the whole buffer while the first check is still running.
  harness.write({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: clean }],
    },
  });
  const cleanResult = harness.waitFor(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.version === 2 &&
      candidate.params.diagnostics.length === 0,
  );
  await cleanResult;
  // Give the slow first run time to finish and be discarded.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stale = harness.inbox.filter(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.diagnostics.some((diagnostic: any) => diagnostic.code === 'E9999'),
  );
  assert.equal(stale.length, 0, 'the superseded slow run must never be published');

  const published = harness.inbox.filter(
    (candidate) => candidate.method === 'textDocument/publishDiagnostics' && candidate.params.uri === uri,
  );
  // The slow run was answering version 1. If the generation guard fails, its
  // result is published with version 1 after version 2 already landed, and this
  // assertion catches it.
  const versions = published.map((candidate) => candidate.params.version);
  assert.deepEqual(versions, [2], 'only the newest version is published');
  assert.ok(
    !published.some((candidate) =>
      candidate.params.diagnostics.some((diagnostic: any) => diagnostic.code === 'E9999'),
    ),
    'the slow run\'s diagnostic never appears',
  );
  await harness.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a fake diagnostic converts exactly, proving the pipeline end to end', async () => {
  const directory = tempDir();
  // Reported 1-based, columns 5..9; the token `boom` is at 0-based 4..8.
  const source = 'fun main() <noret> {\n    let boom <int> = 1;\n}\n// DIAG 2:5:0:9 boom\n';
  const file = path.join(directory, 'exact.fin');
  fs.writeFileSync(file, source.replace('// DIAG 2:5:0:9 boom\n', ''));
  const uri = 'file://' + file;
  const harness = new Harness();
  await harness.initialize({ compilerPath: FAKE.command });
  const diagnostics = harness.waitFor(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.diagnostics.length > 0,
  );
  harness.write({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'fin', version: 1, text: source } },
  });
  const published = (await diagnostics).params;
  assert.deepEqual(published.diagnostics[0].range, {
    start: { line: 1, character: 4 },
    end: { line: 1, character: 8 },
  });
  assert.equal(published.diagnostics[0].code, 'E0201');
  assert.equal(published.diagnostics[0].message, 'boom');
  await harness.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('fin.restart recovers after the compiler path is corrected', async () => {
  const directory = tempDir();
  const source = 'fun main() <noret> { }\n';
  const file = path.join(directory, 'restart.fin');
  fs.writeFileSync(file, source);
  const uri = 'file://' + file;
  const harness = new Harness();
  await harness.initialize({ compilerPath: path.join(directory, 'missing-finc') });
  harness.write({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'fin', version: 1, text: source } },
  });
  const missing = harness.waitFor(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.diagnostics.some((diagnostic: any) => diagnostic.code === 'fin-lsp/compiler-missing'),
  );
  await missing;

  harness.write({
    jsonrpc: '2.0',
    method: 'workspace/didChangeConfiguration',
    params: { settings: { fin: { compilerPath: FAKE.command } } },
  });
  const cleaned = harness.waitFor(
    (candidate) =>
      candidate.method === 'textDocument/publishDiagnostics' &&
      candidate.params.uri === uri &&
      candidate.params.diagnostics.length === 0,
  );
  await harness.request('workspace/executeCommand', { command: 'fin.restart' });
  await cleaned;
  await harness.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

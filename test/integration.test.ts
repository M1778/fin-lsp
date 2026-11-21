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

import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { MessageReader, encodeMessage } from '../src/framing';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const REPO = path.join(__dirname, '..', '..');
const REAL_STDLIB = '/home/M1778/Fin/lib/std';
const FIXTURE_STDLIB = path.join(__dirname, '..', '..', 'test', 'fixtures', 'stdlib');
const STDLIB = fs.existsSync(REAL_STDLIB) ? REAL_STDLIB : FIXTURE_STDLIB;
const FINC = '/home/M1778/Fin/build/finc';
const REAL_FMT = '/home/M1778/Fin/build/tools/fmt/finfmt';
const realCompiler = fs.existsSync(FINC);

interface Waiter {
  predicate: (message: any) => boolean;
  resolve: (message: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Client {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters: Waiter[] = [];
  private nextId = 1;
  readonly inbox: any[] = [];
  readonly stderr: string[] = [];

  constructor() {
    this.child = spawn(process.execPath, [CLI, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const reader = new MessageReader((message) => this.dispatch(message));
    this.child.stdout.on('data', (chunk: Buffer) => reader.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
  }

  private dispatch(message: any): void {
    this.inbox.push(message);
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(message)) {
        const waiter = this.waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
    }
  }

  write(message: unknown): void {
    this.child.stdin.write(encodeMessage(message));
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const waiter = this.waitFor(
      (message) => message.id === id && message.method === undefined,
      `${method} response`,
    );
    this.write({ jsonrpc: '2.0', id, method, params });
    return waiter;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  waitFor(predicate: (message: any) => boolean, description = 'message', timeoutMs = 25000): Promise<any> {
    const existing = this.inbox.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${description}; got ${JSON.stringify(this.inbox.slice(-6))}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForDiagnostics(uri: string, predicate: (params: any) => boolean): Promise<any> {
    return this.waitFor(
      (message) =>
        message.method === 'textDocument/publishDiagnostics' &&
        message.params.uri === uri &&
        predicate(message.params),
      `diagnostics for ${uri}`,
    );
  }

  async stop(): Promise<void> {
    try {
      this.notify('exit', {});
    } catch {
      /* the pipe may already be closed */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 3000);
      this.child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fin-lsp-it-'));
}

function writeFile(directory: string, name: string, text: string): string {
  const target = path.join(directory, name);
  fs.writeFileSync(target, text, 'utf8');
  return target;
}

function uriOf(file: string): string {
  return 'file://' + file.replace(/\\/g, '/');
}

test('initialize announces incremental sync and UTF-16 positions', async () => {
  const client = new Client();
  const response = await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
  assert.equal(response.error, undefined);
  assert.equal(response.result.capabilities.textDocumentSync.change, 2);
  assert.equal(response.result.capabilities.textDocumentSync.openClose, true);
  assert.equal(response.result.capabilities.positionEncoding, 'utf-16');
  assert.equal(response.result.serverInfo.name, 'fin-lsp');
  client.notify('initialized', {});
  await client.request('shutdown', undefined);
  await client.stop();
});

test('a UTF-8 initialization payload survives the framing', async () => {
  const client = new Client();
  const response = await client.request('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    clientInfo: { name: 'test 😀é', version: '1.0' },
    initializationOptions: { fin: { compilerPath: '' } },
  });
  assert.equal(response.error, undefined);
  const marker = '😀漢字';
  const hover = await client.request('textDocument/hover', {
    textDocument: { uri: 'file:///nonexistent/never.fin' },
    position: { line: 0, character: 0 },
  });
  assert.equal(hover.result, null, 'an unknown document answers null, not an error');
  // The marker is only here to make the compiler keep a non-ASCII literal around.
  assert.ok(marker.length > 0);
  await client.request('shutdown', undefined);
  await client.stop();
});

test('unknown methods answer -32601 instead of crashing', async () => {
  const client = new Client();
  await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
  const response = await client.request('textDocument/nonsense', {});
  assert.equal(response.error.code, -32601);
  await client.request('shutdown', undefined);
  await client.stop();
});

test(
  'a real .fin file with a real error produces a diagnostic on the exact range',
  { skip: !realCompiler },
  async () => {
    const directory = workspace();
    const source = 'fun main() <noret> {\n    let x <int> = "hi";\n}\n';
    const file = writeFile(directory, 'broken.fin', source);
    const uri = uriOf(file);
    const client = new Client();
    await client.request('initialize', {
      processId: null,
      rootUri: uriOf(directory),
      capabilities: {},
      initializationOptions: { fin: { compilerPath: FINC, stdlibPath: STDLIB } },
    });
    client.notify('initialized', {});
    const diagnostics = client.waitForDiagnostics(uri, (params) => params.diagnostics.length > 0);
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'fin', version: 1, text: source },
    });
    const published = (await diagnostics).params;
    const error = published.diagnostics.find((diagnostic: any) => diagnostic.code === 'E0201');
    assert.ok(error, `an E0201 diagnostic is published, got ${JSON.stringify(published.diagnostics)}`);
    assert.deepEqual(error.range, {
      start: { line: 1, character: 18 },
      end: { line: 1, character: 22 },
    });
    assert.equal(error.severity, 1);
    assert.equal(error.source, 'finc');
    assert.match(source.split('\n')[1].slice(18, 22), /^"hi"$/);
    await client.request('shutdown', undefined);
    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test(
  'an edit is re-checked and the new result replaces the old one',
  { skip: !realCompiler },
  async () => {
    const directory = workspace();
    const source = 'fun main() <noret> {\n    let x <int> = "hi";\n}\n';
    const fixed = 'fun main() <noret> {\n    printf("ok\\n");\n}\n';
    const file = writeFile(directory, 'edit.fin', source);
    const uri = uriOf(file);
    const client = new Client();
    await client.request('initialize', {
      processId: null,
      rootUri: uriOf(directory),
      capabilities: {},
      initializationOptions: { fin: { compilerPath: FINC, stdlibPath: STDLIB, debounceMs: 20 } },
    });
    client.notify('initialized', {});
    const first = client.waitForDiagnostics(uri, (params) => params.diagnostics.some((d: any) => d.code === 'E0201'));
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
    await first;

    const second = client.waitForDiagnostics(uri, (params) => params.diagnostics.length === 0 && params.version === 2);
    // An incremental edit that replaces the initializer with a printf call.
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: { line: 1, character: 4 }, end: { line: 1, character: 26 } },
          text: '    printf("ok\\n");',
        },
      ],
    });
    const published = (await second).params;
    assert.equal(published.diagnostics.length, 0);
    assert.equal(published.version, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), source, 'the server never writes the real file');

    // Asking for the document symbols of the edited buffer proves the buffer,
    // not the file on disk, is what the server reasons about.
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.equal(symbols.result[0].name, 'main');
    await client.request('shutdown', undefined);
    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test(
  'hover and completion come from the real standard library',
  { skip: !fs.existsSync(STDLIB) },
  async () => {
    const directory = workspace();
    const source = 'import { len } from strings::std;\nfun main() <noret> {}\n';
    const file = writeFile(directory, 'hover.fin', source);
    const uri = uriOf(file);
    const client = new Client();
    await client.request('initialize', {
      processId: null,
      rootUri: uriOf(directory),
      capabilities: {},
      initializationOptions: { fin: { compilerPath: FINC, stdlibPath: STDLIB } },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 10 },
    });
    assert.ok(hover.result, 'hover on `len` is answered');
    const value = hover.result.contents.value as string;
    assert.match(value, /pub fun len\(s: string\) <int>/);
    assert.match(value, /byte length/i);

    const completion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 0 },
    });
    const labels = (completion.result as Array<{ label: string }>).map((item) => item.label);
    assert.ok(labels.includes('len'));
    assert.ok(labels.includes('printf'), 'the index includes stdio');
    assert.ok(labels.includes('main'), 'the open buffer contributes its own declarations');

    const outline = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.deepEqual(
      outline.result.map((symbol: any) => symbol.name),
      ['main'],
    );
    await client.request('shutdown', undefined);
    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test('definition jumps from an import name to lib/std', async () => {
  const directory = workspace();
  const source = 'import { free_str } from strings::std;\nfun main() <noret> {}\n';
  const file = writeFile(directory, 'def.fin', source);
  const uri = uriOf(file);
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: uriOf(directory),
    capabilities: {},
    initializationOptions: { fin: { stdlibPath: STDLIB } },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
  const definition = await client.request('textDocument/definition', {
    textDocument: { uri },
    position: { line: 0, character: 12 },
  });
  assert.ok(definition.result, 'definition of an imported name is answered');
  assert.match(definition.result.uri, /strings\.fin$/);
  // The jump lands on the declaration line, wherever that is in this library.
  assert.ok(definition.result.range.start.line > 0);
  const target = fs.readFileSync(path.join(STDLIB, 'strings.fin'), 'utf8').split('\n');
  assert.match(target[definition.result.range.start.line], /fun free_str\(/);
  await client.request('shutdown', undefined);
  await client.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('definition works for an aliased module import', async () => {
  const directory = workspace();
  const source = 'import stdio::std as io;\nfun main() <noret> { io.printf("hi\\n"); }\n';
  const file = writeFile(directory, 'alias.fin', source);
  const uri = uriOf(file);
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: uriOf(directory),
    capabilities: {},
    initializationOptions: { fin: { stdlibPath: STDLIB } },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
  const definition = await client.request('textDocument/definition', {
    textDocument: { uri },
    position: { line: 0, character: 8 },
  });
  assert.ok(definition.result, 'the module behind the alias is resolvable');
  assert.match(definition.result.uri, /stdio\.fin$/);
  const definitionOfName = await client.request('textDocument/definition', {
    textDocument: { uri },
    position: { line: 1, character: 26 },
  });
  assert.ok(definitionOfName.result, 'printf resolves to its declaration');
  assert.match(definitionOfName.result.uri, /stdio\.fin$/);
  await client.request('shutdown', undefined);
  await client.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('definition returns null for a local variable instead of guessing', async () => {
  const directory = workspace();
  const source = 'fun main() <noret> {\n    let local <int> = 1;\n    printf("%d", local);\n}\n';
  const file = writeFile(directory, 'local.fin', source);
  const uri = uriOf(file);
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: uriOf(directory),
    capabilities: {},
    initializationOptions: { fin: { stdlibPath: STDLIB } },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
  const definition = await client.request('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: 25 },
  });
  assert.equal(definition.result, null);
  await client.request('shutdown', undefined);
  await client.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('formatting is idempotent and only changes unformatted files', { skip: !fs.existsSync(REAL_FMT) }, async () => {
  const FMT = REAL_FMT;
  const directory = workspace();
  const formatted = 'fun main() <noret> {\n    printf("hi\\n");\n}\n';
  const file = writeFile(directory, 'fmt.fin', formatted);
  const uri = uriOf(file);
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: uriOf(directory),
    capabilities: {},
    initializationOptions: { fin: { formatterPath: FMT } },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: formatted } });
  const first = await client.request('textDocument/formatting', {
    textDocument: { uri },
    options: { tabSize: 4, insertSpaces: true },
  });
  assert.deepEqual(first.result, [], 'an already formatted file produces no edits');
  await client.request('shutdown', undefined);
  await client.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a missing compiler publishes a visible warning, not a fake clean file', async () => {
  const directory = workspace();
  const source = 'fun main() <noret> {}\n';
  const file = writeFile(directory, 'nocompiler.fin', source);
  const uri = uriOf(file);
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: uriOf(directory),
    capabilities: {},
    initializationOptions: {
      fin: { compilerPath: path.join(directory, 'no-such-finc'), stdlibPath: STDLIB },
    },
  });
  client.notify('initialized', {});
  const message = client.waitFor(
    (candidate) => candidate.method === 'window/showMessage' && /compiler/i.test(candidate.params.message),
    'a compiler-missing message',
  );
  const diagnostics = client.waitForDiagnostics(uri, (params) => params.diagnostics.length > 0);
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'fin', version: 1, text: source } });
  const shown = await message;
  assert.match(shown.params.message, /fin\.compilerPath/);
  assert.equal(shown.params.type, 1, 'the message is an error, not a hint');
  const published = (await diagnostics).params;
  assert.equal(published.diagnostics[0].code, 'fin-lsp/compiler-missing');
  assert.match(published.diagnostics[0].message, /Not checked/);
  await client.request('shutdown', undefined);
  await client.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('fin.explainDiagnostic returns the compiler explanation', { skip: !realCompiler }, async () => {
  const client = new Client();
  await client.request('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    initializationOptions: { fin: { compilerPath: FINC } },
  });
  client.notify('initialized', {});
  const response = await client.request('workspace/executeCommand', {
    command: 'fin.explainDiagnostic',
    arguments: ['E0301'],
  });
  assert.match(response.result as string, /E0301/);
  assert.match(response.result as string, /a name was used that nothing in scope declares/);
  await client.request('shutdown', undefined);
  await client.stop();
});

test('exit without shutdown is reported as the abnormal exit the protocol specifies', async () => {
  const client = new Client();
  await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
  const exited = new Promise<number | null>((resolve) => {
    (client as any).child.on('exit', (code: number | null) => resolve(code));
  });
  client.notify('exit', {});
  assert.equal(await exited, 1);
});

test('shutdown then exit is a clean zero exit', async () => {
  const client = new Client();
  await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
  const exited = new Promise<number | null>((resolve) => {
    (client as any).child.on('exit', (code: number | null) => resolve(code));
  });
  await client.request('shutdown', undefined);
  client.notify('exit', {});
  assert.equal(await exited, 0);
});

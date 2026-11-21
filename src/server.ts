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

import * as path from 'path';
import {
  CheckOutcome,
  CompilerSettings,
  checkDocument,
  explainDiagnostic,
  filePathFromUri,
  formatText,
  uriFromPath,
} from './compiler';
import { locallyBoundNames, scanDeclarations } from './declarations';
import { Document } from './document';
import { MessageReader, encodeMessage } from './framing';
import { ImportedSymbol, declarationLocation, importAt, resolveImports, scanImports, wordAt } from './imports';
import { compilerDiagnosticToLsp, compilerRangeToLsp } from './positions';
import {
  defaultCompilerPath,
  defaultFormatterPath,
  defaultStdlibPath,
  resolveTool,
  runTool,
} from './process';
import {
  StdlibIndex,
  buildStdlibIndex,
  declarationAt,
  documentation,
  toDocumentSymbols,
} from './stdlib';
import {
  CompletionItem,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  PublishDiagnosticsParams,
  Range,
  TextDocumentContentChangeEvent,
} from './types';

export interface FinSettings {
  compilerPath: string;
  formatterPath: string;
  stdlibPath: string;
  debounceMs: number;
  timeoutMs: number;
  extraArgs: string[];
}

const DEFAULTS: FinSettings = {
  compilerPath: '',
  formatterPath: '',
  stdlibPath: '',
  debounceMs: 300,
  timeoutMs: 20000,
  extraArgs: [],
};

interface PendingCheck {
  generation: number;
  timer: NodeJS.Timeout | null;
  controller: AbortController | null;
}

const MISSING_COMPILER_CODE = 'fin-lsp/compiler-missing';

/**
 * The server, minus the transport. `serve()` in cli.ts wires stdio to this.
 *
 * Two invariants drive most of the code:
 *   1. A result may only be published if no newer edit or check superseded it.
 *      Every scheduled check carries a generation number and every publish
 *      compares versions, so a slow `finc` run cannot overwrite a newer one.
 *   2. Nothing is silently clean. A missing or crashing compiler produces a
 *      visible diagnostic and a message, never an empty diagnostic list that
 *      looks like a passing check.
 */
export class FinLanguageServer {
  private documents = new Map<string, Document>();
  private pending = new Map<string, PendingCheck>();
  private settings: FinSettings = { ...DEFAULTS };
  private compiler: { path: string; source: string } | null = null;
  private formatter: { path: string; source: string } | null = null;
  private stdlib: StdlibIndex | null = null;
  private stdlibError: string | null = null;
  private declaredStdlibRoot = '';
  private missingCompilerReported = false;
  private missingFormatterReported = false;
  private shutdownRequested = false;
  private initialized = false;
  private lastFailureDetail = '';
  private readonly declarationCache = new Map<string, { mtimeMs: number; declarations: ReturnType<typeof scanDeclarations> }>();
  private readonly send: (message: unknown) => void;
  private readonly exit: (code: number) => void;

  constructor(send: (message: unknown) => void, exit: (code: number) => void) {
    this.send = send;
    this.exit = exit;
  }

  // ---------------------------------------------------------------- transport

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private respond(id: number | string | null, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private showMessage(type: number, message: string): void {
    this.notify('window/showMessage', { type, message });
  }

  private log(type: number, message: string): void {
    this.notify('window/logMessage', { type, message });
  }

  // ------------------------------------------------------------- lifecycle

  handleInitialize(id: number | string | null, params: unknown): void {
    if (this.initialized) {
      this.respondError(id, -32600, 'fin-lsp is already initialized');
      return;
    }
    const options = (params as { initializationOptions?: Record<string, unknown> } | undefined)?.initializationOptions;
    this.applySettings(this.unwrapSettings(options ?? {}));
    this.initialized = true;
    const capabilities = {
      positionEncoding: 'utf-16',
      textDocumentSync: {
        // Incremental, and Document.applyChanges really applies ranges.
        openClose: true,
        change: 2,
        save: { includeText: false },
      },
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.', ':'], resolveProvider: false },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      definitionProvider: true,
      executeCommandProvider: {
        commands: ['fin.explainDiagnostic', 'fin.restart', 'fin.rebuildStdlibIndex'],
      },
    };
    this.respond(id, {
      serverInfo: { name: 'fin-lsp', version: '0.1.0' },
      capabilities,
    });
    this.refreshTools();
    this.ensureStdlibIndex();
  }

  handleInitialized(): void {
    this.reportToolStatus();
  }

  handleShutdown(id: number | string | null): void {
    this.shutdownRequested = true;
    this.cancelAllChecks();
    this.respond(id, null);
  }

  handleExit(): void {
    this.cancelAllChecks();
    this.exit(this.shutdownRequested ? 0 : 1);
  }

  // -------------------------------------------------------------- dispatch

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'textDocument/didOpen': {
        const item = (params as { textDocument?: { uri: string; languageId: string; version: number; text: string } })
          ?.textDocument;
        if (!item) return;
        this.documents.set(item.uri, new Document(item.uri, item.languageId, item.version, item.text));
        this.scheduleCheck(item.uri, 0);
        return;
      }
      case 'textDocument/didChange': {
        const cast = params as {
          textDocument?: { uri: string; version: number };
          contentChanges?: TextDocumentContentChangeEvent[];
        };
        const uri = cast?.textDocument?.uri;
        const document = uri ? this.documents.get(uri) : undefined;
        if (!document || !cast.contentChanges) return;
        document.applyChanges(cast.contentChanges, cast.textDocument!.version);
        this.scheduleCheck(uri!, this.settings.debounceMs);
        return;
      }
      case 'textDocument/didClose': {
        const uri = (params as { textDocument?: { uri: string } })?.textDocument?.uri;
        if (!uri) return;
        this.cancelCheck(uri);
        this.documents.delete(uri);
        // Clear squiggles for a closed file: the diagnostics belonged to the buffer.
        this.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
        return;
      }
      case 'textDocument/didSave': {
        const uri = (params as { textDocument?: { uri: string } })?.textDocument?.uri;
        if (uri) this.scheduleCheck(uri, 0);
        return;
      }
      case 'workspace/didChangeConfiguration': {
        const raw = (params as { settings?: Record<string, unknown> })?.settings ?? {};
        this.applySettings(this.unwrapSettings(raw));
        this.refreshTools();
        this.ensureStdlibIndex(true);
        this.reportToolStatus();
        for (const uri of this.documents.keys()) this.scheduleCheck(uri, 0);
        return;
      }
      case 'workspace/didChangeWatchedFiles': {
        // A change under lib/std is a real event; rebuild instead of serving a
        // stale signature until the next restart.
        const changes = (params as { changes?: Array<{ uri: string; type: number }> })?.changes ?? [];
        if (changes.some((change) => this.isStdlibUri(change.uri))) this.ensureStdlibIndex(true);
        return;
      }
      case '$/cancelRequest':
        // Diagnostics are server-initiated; the generation counter is the cancel.
        return;
      case 'exit':
        this.handleExit();
        return;
      default:
        return;
    }
  }

  async handleRequest(id: number | string | null, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case 'initialize':
          this.handleInitialize(id, params);
          return;
        case 'textDocument/hover':
          this.respond(id, this.hover(params));
          return;
        case 'textDocument/completion':
          this.respond(id, this.completion(params));
          return;
        case 'textDocument/documentSymbol':
          this.respond(id, this.documentSymbols(params));
          return;
        case 'textDocument/definition':
          this.respond(id, this.definition(params));
          return;
        case 'textDocument/formatting':
          this.respond(id, await this.formatting(params));
          return;
        case 'workspace/executeCommand':
          this.respond(id, await this.executeCommand(params));
          return;
        case 'workspace/configuration':
          this.respond(id, this.respondConfiguration(params));
          return;
        case 'shutdown':
          this.handleShutdown(id);
          return;
        default:
          this.respondError(id, -32601, `method not supported: ${method}`);
          return;
      }
    } catch (error) {
      this.respondError(id, -32603, `${method} failed: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- settings

  private unwrapSettings(raw: Record<string, unknown>): Record<string, unknown> {
    const fin = raw.fin;
    return fin && typeof fin === 'object' ? (fin as Record<string, unknown>) : raw;
  }

  applySettings(raw: Record<string, unknown>): void {
    const readString = (value: unknown, fallback: string): string =>
      typeof value === 'string' ? value : fallback;
    const readNumber = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
    const nestedDiagnostics =
      raw.diagnostics && typeof raw.diagnostics === 'object'
        ? (raw.diagnostics as Record<string, unknown>)
        : {};
    const debounce = readNumber(
      raw.debounceMs ?? nestedDiagnostics.debounceMs,
      this.settings.debounceMs,
    );
    const extraArgsRaw = nestedDiagnostics.extraArgs ?? raw.extraArgs;
    const extraArgs = Array.isArray(extraArgsRaw)
      ? extraArgsRaw.filter((entry): entry is string => typeof entry === 'string')
      : this.settings.extraArgs;
    this.settings = {
      compilerPath: readString(raw.compilerPath, this.settings.compilerPath),
      formatterPath: readString(raw.formatterPath, this.settings.formatterPath),
      stdlibPath: readString(raw.stdlibPath, this.settings.stdlibPath),
      debounceMs: readNumber(debounce, DEFAULTS.debounceMs),
      timeoutMs: readNumber(raw.timeoutMs ?? nestedDiagnostics.timeoutMs, this.settings.timeoutMs),
      extraArgs,
    };
  }

  private compilerSettings(): CompilerSettings {
    return {
      compilerPath: this.compiler?.path,
      formatterPath: this.formatter?.path,
      stdlibPath: this.stdlibPath(),
      extraArgs: this.settings.extraArgs,
      timeoutMs: this.settings.timeoutMs,
    };
  }

  private stdlibPath(): string {
    if (this.settings.stdlibPath.trim() !== '') {
      return this.settings.stdlibPath.trim().replace(/^~(?=$|[\\/])/, process.env.HOME ?? '');
    }
    // A configured compiler wins over the compiled-in default: the library ships
    // next to the binary as `../lib/std`.
    if (this.compiler) return path.resolve(path.dirname(this.compiler.path), '..', 'lib', 'std');
    return defaultStdlibPath();
  }

  refreshTools(): void {
    const compiler = resolveTool(this.settings.compilerPath, 'finc', defaultCompilerPath());
    this.compiler = compiler ? { path: compiler.path, source: compiler.source } : null;
    const formatter = resolveTool(this.settings.formatterPath, 'finfmt', defaultFormatterPath());
    this.formatter = formatter ? { path: formatter.path, source: formatter.source } : null;
  }

  private reportToolStatus(type = 3): void {    if (!this.compiler) {
      this.reportMissingCompiler();
      return;
    }
    if (!this.settings.compilerPath && this.compiler.source === 'default') {
      this.log(
        type,
        `fin-lsp uses ${this.compiler.path}. Set fin.compilerPath if that is not the compiler you want.`,
      );
    }
    if (!this.formatter) this.reportMissingFormatter();
  }

  private reportMissingCompiler(): void {
    if (this.missingCompilerReported) return;
    this.missingCompilerReported = true;
    this.showMessage(
      1,
      'Fin compiler not found. Diagnostics are disabled until it is available: ' +
        'set `fin.compilerPath` to the finc executable, or add finc to PATH. ' +
        'Expected default: ' +
        defaultCompilerPath(),
    );
  }

  private reportMissingFormatter(): void {
    if (this.missingFormatterReported) return;
    this.missingFormatterReported = true;
    this.showMessage(
      2,
      'Fin formatter not found, so Formatting will do nothing: set `fin.formatterPath` to the finfmt executable. ' +
        'Expected default: ' +
        defaultFormatterPath(),
    );
  }

  private respondConfiguration(params: unknown): unknown[] {
    const items = (params as { items?: Array<{ section?: string }> })?.items ?? [];
    return items.map((item) => {
      const section = (item.section ?? '').replace(/^fin\./, '');
      switch (section) {
        case 'compilerPath':
          return this.settings.compilerPath;
        case 'formatterPath':
          return this.settings.formatterPath;
        case 'stdlibPath':
          return this.settings.stdlibPath;
        case 'debounceMs':
          return this.settings.debounceMs;
        case 'timeoutMs':
          return this.settings.timeoutMs;
        default:
          return null;
      }
    });
  }

  // ---------------------------------------------------------------- stdlib

  private isStdlibUri(uri: string): boolean {
    const file = filePathFromUri(uri);
    if (!file) return false;
    const root = this.stdlibPath().replace(/\\/g, '/');
    return file.replace(/\\/g, '/').startsWith(root);
  }

  ensureStdlibIndex(force = false): void {
    const root = this.stdlibPath();
    if (!force && this.stdlib && this.declaredStdlibRoot === root) return;
    try {
      this.stdlib = buildStdlibIndex(root);
      this.declaredStdlibRoot = root;
      this.stdlibError = null;
      this.notify('window/logMessage', {
        type: 3,
        message: `fin-lsp indexed ${this.stdlib.modules.size} standard-library modules from ${root}.`,
      });
    } catch (error) {
      this.stdlib = null;
      this.stdlibError = (error as Error).message;
      this.declaredStdlibRoot = root;
      this.showMessage(
        2,
        `Fin standard library not found at ${root}. Hover and completion will be empty: set fin.stdlibPath.`,
      );
    }
    this.declarationCache.clear();
  }

  private declarationsFor(file: string) {
    const cached = this.declarationCache.get(file);
    const fs = require('fs') as typeof import('fs');
    try {
      const stat = fs.statSync(file);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.declarations;
      const declarations = scanDeclarations(fs.readFileSync(file, 'utf8'));
      this.declarationCache.set(file, { mtimeMs: stat.mtimeMs, declarations });
      return declarations;
    } catch {
      return [];
    }
  }

  private documentFor(uri: string): { document: Document; text: string } | null {
    const document = this.documents.get(uri);
    if (document) return { document, text: document.getText() };
    const file = filePathFromUri(uri);
    if (!file) return null;
    try {
      const fs = require('fs') as typeof import('fs');
      return { document: new Document(uri, 'fin', 0, fs.readFileSync(file, 'utf8')), text: fs.readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  private importedSymbols(uri: string, lines: string[]): ImportedSymbol[] {
    const file = filePathFromUri(uri);
    const directory = file ? path.dirname(file) : null;
    const imports = resolveImports(scanImports(lines), directory, this.stdlibPath(), (candidate) =>
      this.declarationsFor(candidate),
    );
    const symbols: ImportedSymbol[] = [];
    for (const resolved of imports) {
      if (!resolved.file) continue;
      for (const [name, declaration] of resolved.symbols) {
        symbols.push({ name, module: resolved.module, file: resolved.file, declaration });
      }
    }
    return symbols;
  }

  // ----------------------------------------------------------- diagnostics

  private cancelCheck(uri: string): void {
    const state = this.pending.get(uri);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.controller?.abort();
    this.pending.delete(uri);
  }

  private cancelAllChecks(): void {
    for (const uri of Array.from(this.pending.keys())) this.cancelCheck(uri);
  }

  private scheduleCheck(uri: string, delayMs: number): void {
    const previous = this.pending.get(uri);
    const generation = (previous?.generation ?? 0) + 1;
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.controller?.abort();
    const state: PendingCheck = { generation, timer: null, controller: null };
    this.pending.set(uri, state);
    if (delayMs <= 0) {
      void this.runCheck(uri, state);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runCheck(uri, state);
    }, delayMs);
    state.timer.unref?.();
  }

  private async runCheck(uri: string, state: PendingCheck): Promise<void> {
    const document = this.documents.get(uri);
    if (!document) return;
    if (!this.compiler) {
      this.reportMissingCompiler();
      this.publishMissingCompiler(uri, document);
      return;
    }
    // Pin the version this run is answering. The buffer keeps mutating while
    // `finc` runs, so comparing it to itself later would always pass.
    const checkedVersion = document.version;
    const checkedText = document.getText();
    const controller = new AbortController();
    state.controller = controller;
    const check = await checkDocument({
      document,
      settings: this.compilerSettings(),
      compilerPath: this.compiler.path,
      stagingDirectory: this.stagingDirectory(),
      includePaths: this.includePathsFor(uri),
      signal: controller.signal,
    });
    // A newer edit exists: this answer is historical and must not land.
    const current = this.pending.get(uri);
    const live = this.documents.get(uri);
    if (
      controller.signal.aborted ||
      current !== state ||
      live === undefined ||
      live.version !== checkedVersion ||
      live.getText() !== checkedText
    ) {
      return;
    }
    this.pending.delete(uri);
    this.handleCheckOutcome(uri, live, check, checkedVersion);
  }

  private handleCheckOutcome(uri: string, document: Document, outcome: CheckOutcome, version: number): void {
    if (outcome.status === 'missing') {
      this.lastFailureDetail = outcome.message;
      this.reportMissingCompiler();
      this.publishMissingCompiler(uri, document, version);
      if (outcome.detail) this.log(1, `finc could not start: ${outcome.detail}`);
      return;
    }
    if (outcome.status === 'crashed') {
      // The compiler exists but did not produce a report. Say so once per new
      // stderr, and show a diagnostic so the file is visibly unchecked.
      const detail = outcome.stderr.trim().split('\n').slice(0, 6).join('\n');
      if (this.lastFailureDetail !== detail) {
        this.lastFailureDetail = detail;
        this.showMessage(
          1,
          `finc failed without a diagnostic report (exit ${outcome.exitCode ?? 'none'}). ` +
            `The file was not checked.${detail ? ' stderr: ' + detail : ''}`,
        );
      }
      this.publish(
        uri,
        document,
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: DiagnosticSeverity.Error,
            source: 'fin-lsp',
            code: 'fin-lsp/compiler-crashed',
            message: `finc failed without reporting diagnostics, so this file was not checked. ${outcome.message}`,
          },
        ],
        version,
      );
      return;
    }

    const diagnostics: Diagnostic[] = [];
    for (const diagnostic of outcome.diagnostics) {
      if ((diagnostic as unknown as { foreign?: boolean }).foreign) {
        const where = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}` : 'a module';
        this.log(3, `${where}: ${diagnostic.message}`);
        continue;
      }
      diagnostics.push(compilerDiagnosticToLsp(document, diagnostic));
    }
    this.publish(uri, document, diagnostics, version);
  }

  private publishMissingCompiler(uri: string, document: Document, version = document.version): void {
    this.publish(
      uri,
      document,
      [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          severity: DiagnosticSeverity.Warning,
          source: 'fin-lsp',
          code: MISSING_COMPILER_CODE,
          message:
            'Not checked: the Fin compiler was not found. Set `fin.compilerPath` to the finc executable, or add finc to PATH. ' +
            'This file has not been type-checked and is not known to be clean.',
        },
      ],
      version,
    );
  }

  private publish(uri: string, document: Document, diagnostics: Diagnostic[], version: number): void {
    const params: PublishDiagnosticsParams = { uri, version, diagnostics };
    this.notify('textDocument/publishDiagnostics', params);
  }

  private includePathsFor(uri: string): string[] {
    const file = filePathFromUri(uri);
    const result: string[] = [];
    if (file) result.push(path.dirname(file));
    const stdlib = this.stdlibPath();
    if (stdlib && !result.includes(stdlib)) result.push(stdlib);
    return result;
  }

  private stagingDirectory(): string {
    const os = require('os') as typeof import('os');
    const fs = require('fs') as typeof import('fs');
    const directory = path.join(os.tmpdir(), `fin-lsp-stage-${process.pid}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  // ---------------------------------------------------------------- features

  private hover(params: unknown): Hover | null {
    const cast = params as { textDocument?: { uri: string }; position?: Position };
    const uri = cast?.textDocument?.uri;
    const position = cast?.position;
    if (!uri || !position) return null;
    const source = this.documentFor(uri);
    if (!source) return null;
    const lines = source.text.split('\n');
    const word = wordAt(lines, position);
    if (!word) return null;

    const localDeclaration = declarationAt(scanDeclarations(source.text), position.line);
    if (localDeclaration) {
      return {
        contents: {
          kind: 'markdown',
          value:
            '```fin\n' +
            localDeclaration.signature +
            '\n```\n\n' +
            (localDeclaration.doc || '*No comment above this declaration.*'),
        },
        range: word.range,
      };
    }

    const local = locallyBoundNames(source.text);
    const stdlib = this.stdlib ?? (this.ensureStdlibIndex(), this.stdlib);
    if (stdlib && !local.has(word.word)) {
      const entries = stdlib.symbols.get(word.word);
      if (entries && entries.length > 0) {
        const entry = entries[0];
        const others = entries
          .slice(1)
          .map((candidate) => `- \`${candidate.module.name}::std\``)
          .join('\n');
        const body = documentation(entry.module, entry.declaration) + (others ? `\n\nAlso declared in:\n${others}` : '');
        return { contents: { kind: 'markdown', value: body }, range: word.range };
      }
    }

    const imported = this.importedSymbols(uri, lines).find((symbol) => symbol.name === word.word);
    if (imported?.declaration) {
      return {
        contents: {
          kind: 'markdown',
          value:
            '```fin\n' +
            imported.declaration.signature +
            '\n```\n\n' +
            (imported.declaration.doc || '*No comment above this declaration.*'),
        },
        range: word.range,
      };
    }
    return null;
  }

  private completion(params: unknown): CompletionItem[] {
    const cast = params as { textDocument?: { uri: string }; position?: Position };
    const uri = cast?.textDocument?.uri;
    if (!uri) return [];
    const document = this.documents.get(uri);
    const text = document ? document.getText() : '';
    const items: CompletionItem[] = [];
    const bound = locallyBoundNames(text);
    if (!this.stdlib) this.ensureStdlibIndex();
    if (this.stdlib) {
      // A local `len` shadows the library one, so offering the library's
      // signature as the first choice would be a lie about what the code means.
      items.push(...this.stdlib.completions.filter((item) => !bound.has(item.label)));
    }
    const seen = new Set(items.map((item) => item.label));
    for (const declaration of scanDeclarations(text)) {
      if (seen.has(declaration.name)) continue;
      seen.add(declaration.name);
      items.push({
        label: declaration.name,
        kind: declaration.kind === 'struct' ? 22 : declaration.kind === 'const' ? 21 : 3,
        detail: declaration.signature,
        documentation: { kind: 'markdown', value: declaration.doc || declaration.signature },
        sortText: '0' + declaration.name,
      });
    }
    return items;
  }

  private documentSymbols(params: unknown): DocumentSymbol[] {
    const uri = (params as { textDocument?: { uri: string } })?.textDocument?.uri;
    if (!uri) return [];
    const source = this.documentFor(uri);
    if (!source) return [];
    return toDocumentSymbols(scanDeclarations(source.text));
  }

  private definition(params: unknown): Location | null {
    const cast = params as { textDocument?: { uri: string }; position?: Position };
    const uri = cast?.textDocument?.uri;
    const position = cast?.position;
    if (!uri || !position) return null;
    const source = this.documentFor(uri);
    if (!source) return null;
    const lines = source.text.split('\n');
    const file = filePathFromUri(uri);
    const directory = file ? path.dirname(file) : null;
    const imports = resolveImports(scanImports(lines), directory, this.stdlibPath(), (candidate) =>
      this.declarationsFor(candidate),
    );

    const target = importAt(
      imports.map((resolved) => resolved.statement),
      lines,
      position,
    );
    if (target) {
      const resolved = imports.find((candidate) => candidate.statement === target.statement);
      if (!resolved?.file) return null;
      if (target.kind === 'name' && target.name) {
        const declaration = resolved.symbols.get(target.name);
        return declaration ? declarationLocation(resolved.file, declaration) : null;
      }
      // A whole-module import, an aliased module, or a quoted path: the module
      // itself is the declaration, so jump to its first line.
      return {
        uri: uriFromPath(resolved.file),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      };
    }

    const word = wordAt(lines, position);
    if (!word) return null;

    // A name declared in this very file: jumping there is exact, so it is safe.
    const local = scanDeclarations(source.text).filter(
      (declaration) => declaration.name === word.word && declaration.kind !== 'namespace',
    );
    if (local.length > 0) {
      return {
        uri,
        range: {
          start: { line: local[0].startLine, character: local[0].startCharacter },
          end: { line: local[0].startLine, character: local[0].startCharacter + local[0].name.length },
        },
      };
    }

    const stdlib = this.stdlib ?? (this.ensureStdlibIndex(), this.stdlib);
    const locallyBound = locallyBoundNames(source.text).has(word.word);
    const stdlibEntry = locallyBound ? undefined : stdlib?.symbols.get(word.word)?.[0];
    if (stdlibEntry) {
      return {
        uri: uriFromPath(stdlibEntry.module.path),
        range: {
          start: { line: stdlibEntry.declaration.startLine, character: stdlibEntry.declaration.startCharacter },
          end: {
            line: stdlibEntry.declaration.startLine,
            character: stdlibEntry.declaration.startCharacter + stdlibEntry.declaration.name.length,
          },
        },
      };
    }

    const imported = this.importedSymbols(uri, lines).find((symbol) => symbol.name === word.word);
    if (imported?.declaration) return declarationLocation(imported.file, imported.declaration);

    // Everything else -- locals, members, generic arguments -- is deliberately
    // unimplemented. A null answer is honest; a guessed location is not.
    return null;
  }

  private async formatting(params: unknown): Promise<Array<{ range: Range; newText: string }> | []> {
    const cast = params as {
      textDocument?: { uri: string };
      options?: { tabSize?: number; insertSpaces?: boolean };
    };
    const uri = cast?.textDocument?.uri;
    if (!uri) return [];
    const document = this.documents.get(uri);
    if (!document) return [];
    if (!this.formatter) {
      this.reportMissingFormatter();
      return [];
    }
    const file = filePathFromUri(uri);
    const outcome = await formatText(
      document.getText(),
      file,
      this.formatter.path,
      this.settings.timeoutMs,
    );
    if (outcome.status === 'missing') {
      this.reportMissingFormatter();
      return [];
    }
    if (outcome.status === 'refused') {
      this.showMessage(1, `finfmt refused to format this file: ${outcome.message ?? ''}`);
      return [];
    }
    if (outcome.status === 'crashed') {
      this.showMessage(1, `finfmt failed: ${outcome.message ?? 'unknown error'}`);
      return [];
    }
    if (outcome.status !== 'ok' || outcome.text === undefined) return [];
    const text = document.getText();
    const lines = text.split('\n');
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1].length },
        },
        newText: outcome.text,
      },
    ];
  }

  private async executeCommand(params: unknown): Promise<unknown> {
    const cast = params as { command?: string; arguments?: unknown[] };
    const command = cast?.command ?? '';
    const args = cast?.arguments ?? [];
    switch (command) {
      case 'fin.explainDiagnostic': {
        const code = this.extractCode(args);
        if (!code) {
          this.showMessage(2, 'fin.explainDiagnostic needs a diagnostic code, for example E0301.');
          return null;
        }
        if (!this.compiler) {
          this.reportMissingCompiler();
          return null;
        }
        const outcome = await explainDiagnostic(this.compiler.path, code, this.settings.timeoutMs);
        if (outcome.status === 'missing') {
          this.reportMissingCompiler();
          return null;
        }
        if (outcome.status === 'unknown') {
          this.showMessage(2, `finc does not know the diagnostic code ${code}.`);
          return null;
        }
        if (outcome.status === 'crashed') {
          this.showMessage(1, `finc --explain ${code} failed.`);
          return null;
        }
        await this.showInOutput(`finc --explain ${code}`, outcome.text);
        return outcome.text;
      }
      case 'fin.restart': {
        this.refreshTools();
        this.missingCompilerReported = false;
        this.missingFormatterReported = false;
        this.lastFailureDetail = '';
        this.ensureStdlibIndex(true);
        this.reportToolStatus();
        for (const uri of this.documents.keys()) this.scheduleCheck(uri, 0);
        this.log(3, 'fin-lsp restarted: tool paths re-resolved, index rebuilt, open files re-checked.');
        return null;
      }
      case 'fin.rebuildStdlibIndex': {
        this.ensureStdlibIndex(true);
        return this.stdlib ? this.stdlib.modules.size : 0;
      }
      default:
        this.showMessage(2, `Unknown Fin command: ${command}`);
        return null;
    }
  }

  private extractCode(args: unknown[]): string | null {
    const first = args[0];
    if (typeof first === 'string') return first.trim() || null;
    if (first && typeof first === 'object') {
      const candidate = (first as { code?: unknown }).code;
      if (typeof candidate === 'string') return candidate.trim() || null;
    }
    return null;
  }

  private async showInOutput(title: string, body: string): Promise<void> {
    // window/showDocument opens a real document; logMessage keeps the text in
    // the client's log panel where a user can read it without a file being
    // created. Both are best effort: a client may ignore either.
    this.log(3, `${title}\n\n${body}`);
  }

  /** Release temp resources; called from the CLI's exit path. */
  dispose(): void {
    this.cancelAllChecks();
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    try {
      fs.rmSync(path.join(os.tmpdir(), `fin-lsp-stage-${process.pid}`), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}


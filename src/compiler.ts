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

import * as fs from 'fs';
import * as path from 'path';
import { Document } from './document';
import {
  CompilerDiagnostic,
  CompilerSummary,
  diagnosticBelongsTo,
  parseCompilerOutput,
} from './positions';
import { ToolResult, runTool } from './process';

export interface CompilerSettings {
  compilerPath?: string;
  formatterPath?: string;
  stdlibPath?: string;
  extraArgs: string[];
  timeoutMs: number;
}

export type CheckOutcome =
  | {
      status: 'ok';
      diagnostics: CompilerDiagnostic[];
      summary: CompilerSummary | null;
      stderr: string;
      stagedPath: string;
    }
  | {
      status: 'missing';
      message: string;
      stderr: string;
      /** Set when the compiler exists but is not runnable, e.g. a bad shebang. */
      detail?: string;
    }
  | {
      status: 'crashed';
      message: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    };

export interface CheckRequest {
  document: Document;
  settings: CompilerSettings;
  compilerPath: string;
  /** Where to put the staged copy; owned by the caller so it can be cleaned. */
  stagingDirectory: string;
  /** Extra include paths, normally the document's own directory. */
  includePaths: string[];
  signal?: AbortSignal;
}

function documentPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  const raw = uri.slice('file://'.length);
  // file:///c%3A/Users/...  ->  c:/Users/...
  // file://server/share/x.fin ->  //server/share/x.fin
  // file:///home/u/x.fin   ->  /home/u/x.fin
  const decoded = decodeURIComponent(raw);
  if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1);
  if (/^[A-Za-z]:/.test(decoded)) return decoded;
  if (!decoded.startsWith('/')) return '//' + decoded;
  return decoded;
}

export function filePathFromUri(uri: string): string | null {
  try {
    return documentPath(uri);
  } catch {
    return null;
  }
}

export function uriFromPath(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  // `C:/x/y.fin` -> `file:///C:/x/y.fin`; `//server/share/x` -> `file://server/share/x`;
  // a POSIX path keeps its leading slash, giving `file:///home/...`.
  if (/^[A-Za-z]:/.test(normalized)) {
    // `C:\Users\m\x.fin` normalises to `C:/Users/m/x.fin`; collapsing the
    // repeated separators is what makes the two spellings one URI.
    return 'file:///' + encodeURI(normalized.replace(/\/{2,}/g, '/'));
  }
  if (normalized.startsWith('//')) return 'file:' + encodeURI(normalized);
  const absolute = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'file://' + encodeURI(absolute).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * Stage the buffer next to a temporary directory and run the compiler on it.
 *
 * Why stage at all: `finc` type-checks a path. An unsaved buffer has no path
 * that contains the user's edits, so the server writes the buffer out and
 * checks that. The staged file is compiled with its working directory set to
 * the document's directory so that relative imports resolve exactly as they do
 * for the real file, and the document's directory is also passed with `-I`.
 *
 * The staged name keeps the `.fin` suffix and a unique stem, so two documents
 * with the same base name never collide in one run.
 */
export async function checkDocument(request: CheckRequest): Promise<CheckOutcome> {
  const { document, settings, compilerPath } = request;
  const directory = request.stagingDirectory;
  const base = path.basename(filePathFromUri(document.uri) ?? document.fileName);
  const stem = `.finlsp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${base}`;
  const staged = path.join(directory, stem.endsWith('.fin') ? stem : `${stem}.fin`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(staged, document.getText(), 'utf8');
  } catch (error) {
    return {
      status: 'crashed',
      message: `fin-lsp could not stage the buffer for checking: ${(error as Error).message}`,
      stderr: '',
      exitCode: null,
      signal: null,
    };
  }

  const args = [staged, '--diagnostics=json', '--color=never', ...settings.extraArgs];
  for (const include of request.includePaths) args.push('-I', include);
  const workingDirectory = filePathFromUri(document.uri);
  const cwd = workingDirectory ? path.dirname(workingDirectory) : directory;

  const result: ToolResult = await runTool({
    command: compilerPath,
    args,
    cwd: fs.existsSync(cwd) ? cwd : directory,
    timeoutMs: settings.timeoutMs,
    signal: request.signal,
  });

  try {
    fs.rmSync(staged, { force: true });
  } catch {
    /* a leftover temp file is not worth failing a check over */
  }

  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') {
      return { status: 'missing', message: missingCompilerMessage(compilerPath), stderr: '' };
    }
    return {
      status: 'missing',
      message: missingCompilerMessage(compilerPath),
      stderr: '',
      detail: result.spawnError.message,
    };
  }
  if (result.aborted) {
    return {
      status: 'crashed',
      message: 'the check was cancelled',
      stderr: '',
      exitCode: null,
      signal: null,
    };
  }
  if (result.timedOut) {
    return {
      status: 'crashed',
      message: `finc did not finish within ${settings.timeoutMs} ms; the check was abandoned.`,
      stderr: result.stderr,
      exitCode: null,
      signal: 'SIGKILL',
    };
  }

  const parsed = parseCompilerOutput(result.stdout, result.stderr);  const compiledPath = staged;
  const relevant = parsed.diagnostics.filter((diagnostic) => diagnosticBelongsTo(diagnostic, compiledPath));
  // Diagnostics for imported modules are not re-homed onto this document, but a
  // silent drop would make a broken module look clean, so they are returned too.
  const foreign = parsed.diagnostics.filter((diagnostic) => !diagnosticBelongsTo(diagnostic, compiledPath));

  if (parsed.summary === null && relevant.length === 0 && foreign.length === 0) {
    return {
      status: 'crashed',
      message:
        'finc produced no JSON diagnostics and no summary. The compiler crashed or printed something unexpected.',
      stderr: parsed.noise.length > 0 ? parsed.noise.join('\n') : result.stderr || result.stdout,
      exitCode: result.code,
      signal: result.signal,
    };
  }
  return {
    status: 'ok',
    diagnostics: [...relevant, ...foreign.map((diagnostic) => ({ ...diagnostic, foreign: true }) as never)],
    summary: parsed.summary,
    stderr: parsed.noise.join('\n'),
    stagedPath: staged,
  };
}

function missingCompilerMessage(compilerPath: string): string {
  return (
    `Fin compiler not found at "${compilerPath}". ` +
    'Set `fin.compilerPath` to the finc executable (or add finc to PATH) — diagnostics are not being checked until then.'
  );
}

export interface FormatOutcome {
  status: 'ok' | 'unchanged' | 'refused' | 'missing' | 'crashed';
  text?: string;
  message?: string;
  stderr: string;
}

/**
 * Format with `finfmt`.
 *
 * `finfmt` rewrites in place, so the buffer is written to a scratch file inside
 * the document's directory and read back. The scratch file lives in the same
 * directory so that no path in a diagnostic points somewhere surprising, and it
 * is always removed.
 */
export async function formatText(
  text: string,
  documentPath: string | null,
  formatterPath: string | null,
  timeoutMs: number,
): Promise<FormatOutcome> {
  if (!formatterPath) {
    return {
      status: 'missing',
      stderr: '',
      message:
        'finfmt not found. Set `fin.formatterPath` to the finfmt executable, or build it with `./build.sh` in the Fin repository.',
    };
  }
  const directory = documentPath ? path.dirname(documentPath) : process.cwd();
  const base = documentPath ? path.basename(documentPath) : 'buffer.fin';
  const scratch = path.join(directory, `.finlsp-fmt-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${base}`);
  try {
    fs.writeFileSync(scratch, text, 'utf8');
  } catch (error) {
    return { status: 'crashed', stderr: '', message: `fin-lsp could not write a scratch file: ${(error as Error).message}` };
  }
  const result = await runTool({ command: formatterPath, args: [scratch], cwd: directory, timeoutMs });
  let formatted: string | null = null;
  try {
    formatted = fs.readFileSync(scratch, 'utf8');
  } catch {
    formatted = null;
  }
  try {
    fs.rmSync(scratch, { force: true });
  } catch {
    /* best effort */
  }
  if (result.spawnError) {
    return {
      status: 'missing',
      stderr: '',
      message:
        'finfmt not found. Set `fin.formatterPath` to the finfmt executable, or build it with `./build.sh` in the Fin repository.',
    };
  }
  if (result.timedOut) {
    return { status: 'crashed', stderr: result.stderr, message: `finfmt timed out after ${timeoutMs} ms.` };
  }
  if (result.code !== 0 || formatted === null) {
    return {
      status: 'refused',
      stderr: result.stderr,
      message: (result.stderr || result.stdout).trim() || 'finfmt refused to format this file.',
    };
  }
  if (formatted === text) return { status: 'unchanged', text: formatted, stderr: '' };
  return { status: 'ok', text: formatted, stderr: '' };
}

export interface ExplainOutcome {
  status: 'ok' | 'missing' | 'unknown' | 'crashed';
  text: string;
  stderr: string;
}

export async function explainDiagnostic(
  compilerPath: string | null,
  code: string,
  timeoutMs: number,
): Promise<ExplainOutcome> {
  if (!compilerPath) {
    return { status: 'missing', text: '', stderr: '' };
  }
  const result = await runTool({ command: compilerPath, args: ['--explain', code], timeoutMs });
  if (result.spawnError) return { status: 'missing', text: '', stderr: '' };
  if (result.timedOut) return { status: 'crashed', text: '', stderr: 'finc --explain timed out.' };
  if (result.code !== 0) {
    return { status: 'unknown', text: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  return { status: 'ok', text: result.stdout.trim(), stderr: result.stderr.trim() };
}

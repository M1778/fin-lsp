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

import { LineSource } from './document';
import { Diagnostic, DiagnosticSeverity, Range } from './types';

/**
 * What `finc --diagnostics=json` prints, one JSON object per line.
 *
 * Two things about this contract drive the whole conversion:
 *   * `line` and `column` are 1-based, and `endColumn` is exclusive.
 *   * columns are BYTE offsets in the line, not characters and not UTF-16
 *     code units. Verified against finc 1.0.1: for
 *     `printf("😀é"); Unknown();` the compiler reports `Unknown` at column 40,
 *     which is byte offset 39; the same token is UTF-16 offset 36.
 */
export interface CompilerDiagnostic {
  kind: 'diagnostic';
  severity?: string;
  code?: string | null;
  message: string;
  file?: string | null;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  help?: string | null;
  attribution?: string | null;
}

export interface CompilerSummary {
  kind: 'summary';
  errors?: number;
  warnings?: number;
  exitCode?: number;
  status?: string;
}

export interface ParsedCompilerOutput {
  diagnostics: CompilerDiagnostic[];
  summary: CompilerSummary | null;
  /** Lines on stdout that were not the documented JSON stream. */
  noise: string[];
}

/**
 * Collect the JSON diagnostic stream from the streams finc actually used.
 *
 * finc 1.0.1 writes the `--diagnostics=json` stream to **stderr**, not stdout:
 * stdout is empty for both a clean file and a failing one. That contradicts the
 * documented contract, so both streams are scanned rather than trusting either
 * one. Only well-formed JSON objects with a `kind` are accepted, so human prose
 * that happens to sit next to the stream is ignored instead of being mistaken
 * for a diagnostic.
 */
export function parseCompilerOutput(stdout: string, stderr = ''): ParsedCompilerOutput {
  const diagnostics: CompilerDiagnostic[] = [];
  const noise: string[] = [];
  let summary: CompilerSummary | null = null;
  for (const raw of (stdout + '\n' + stderr).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      noise.push(raw);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      noise.push(raw);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'diagnostic' && typeof record.message === 'string') {
      diagnostics.push(record as unknown as CompilerDiagnostic);
    } else if (record.kind === 'summary') {
      summary = record as unknown as CompilerSummary;
    } else if (typeof record.message === 'string') {
      // A diagnostic without a kind is still a diagnostic; finc has always set it,
      // but dropping a problem because a field is missing is the failure mode this
      // server exists to avoid.
      diagnostics.push({ ...(record as unknown as CompilerDiagnostic), kind: 'diagnostic' });
    } else {
      noise.push(raw);
    }
  }
  return { diagnostics, summary, noise };
}

/**
 * The UTF-16 code-unit index for a byte offset inside one line.
 *
 * A byte offset that lands inside a multi-byte character clamps to that
 * character's start: half a glyph is not a position an editor can show.
 */
export function byteOffsetToUtf16Column(line: string, byteOffset: number): number {
  if (!Number.isFinite(byteOffset) || byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > byteOffset) return index;
    bytes += width;
    index += character.length;
    if (bytes === byteOffset) return index;
  }
  return line.length;
}

function boundedLine(source: LineSource, line: number): number {
  if (!Number.isFinite(line)) return 0;
  return Math.max(0, Math.min(Math.trunc(line), source.lineCount - 1));
}

export function compilerRangeToLsp(source: LineSource, diagnostic: CompilerDiagnostic): Range {
  const reportedLine = diagnostic.line ?? 0;
  const reportedEndLine = diagnostic.endLine ?? reportedLine;
  // Both 0 and 1 mean "no position" in practice: `line: 0` is what finc prints for
  // a file-level problem such as a module that could not be found.
  if (reportedLine <= 0 && reportedEndLine <= 0) {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  }
  const startLine = boundedLine(source, reportedLine - 1);
  const endLine = Math.max(startLine, boundedLine(source, reportedEndLine - 1));
  const startText = source.lineText(startLine);
  const endText = source.lineText(endLine);
  // 1-based exclusive byte end -> 0-based byte offset.
  const startByte = Math.max(0, (diagnostic.column ?? 1) - 1);
  const endByte = Math.max(startByte, (diagnostic.endColumn ?? diagnostic.column ?? 1) - 1);
  const start: Range['start'] = { line: startLine, character: byteOffsetToUtf16Column(startText, startByte) };
  let end: Range['end'] = { line: endLine, character: byteOffsetToUtf16Column(endText, endByte) };
  if (end.line === start.line && end.character < start.character) end = { ...start };
  return { start, end };
}

const SEVERITIES: Record<string, number> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  note: DiagnosticSeverity.Information,
  info: DiagnosticSeverity.Information,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function severityToLsp(severity: string | undefined): number {
  return SEVERITIES[(severity ?? '').toLowerCase()] ?? DiagnosticSeverity.Information;
}

export function compilerDiagnosticToLsp(source: LineSource, diagnostic: CompilerDiagnostic): Diagnostic {
  const result: Diagnostic = {
    range: compilerRangeToLsp(source, diagnostic),
    severity: severityToLsp(diagnostic.severity),
    source: 'finc',
    message: diagnostic.message + (diagnostic.help ? `\n\n${diagnostic.help}` : ''),
    data: {
      code: diagnostic.code ?? null,
      file: diagnostic.file ?? null,
      severity: diagnostic.severity ?? null,
      attribution: diagnostic.attribution ?? null,
      help: diagnostic.help ?? null,
    },
  };
  if (diagnostic.code) result.code = diagnostic.code;
  return result;
}

/**
 * Does this diagnostic belong to the file we compiled?
 *
 * finc prints the path it was given, and may also report a module-level problem
 * with `file: null`. Diagnostics for imported modules are deliberately not
 * re-homed onto this document -- a wrong squiggle is worse than none -- but the
 * caller logs them so they are not invisible.
 */
export function diagnosticBelongsTo(diagnostic: CompilerDiagnostic, compiledPath: string): boolean {
  if (!diagnostic.file) return true;
  const normal = (value: string): string => value.replace(/\\/g, '/');
  const wanted = normal(compiledPath);
  const got = normal(diagnostic.file);
  if (got === wanted) return true;
  const wantedBase = wanted.split('/').pop();
  const gotBase = got.split('/').pop();
  return wantedBase !== undefined && wantedBase === gotBase;
}

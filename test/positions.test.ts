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
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { Document } from '../src/document';
import {
  byteOffsetToUtf16Column,
  compilerDiagnosticToLsp,
  compilerRangeToLsp,
  parseCompilerOutput,
} from '../src/positions';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

/**
 * The captured files are real `finc 1.0.1` output, not hand-written. If the
 * compiler's contract changes, these tests fail instead of quietly converting
 * the wrong numbers.
 */
test('a real ASCII report converts to the exact LSP range', () => {
  const parsed = parseCompilerOutput('', fixture('finc-ascii.jsonl'));
  assert.equal(parsed.summary?.errors, 1);
  const error = parsed.diagnostics.find((diagnostic) => diagnostic.code === 'E0201');
  assert.ok(error, 'the E0201 diagnostic must survive parsing');
  const document = new Document('file:///x/ascii.fin', 'fin', 1, fixture('ascii.fin'));
  const converted = compilerDiagnosticToLsp(document, error!);
  // finc reports 1-based line 2, columns 19..23 (exclusive). The quoted string
  // `"hi"` occupies 0-based line 1, characters 18..22.
  assert.deepEqual(converted.range, {
    start: { line: 1, character: 18 },
    end: { line: 1, character: 22 },
  });
  assert.equal(converted.severity, 1);
  assert.equal(converted.code, 'E0201');
  assert.equal(converted.source, 'finc');
  assert.match(document.getText().split('\n')[1].slice(18, 22), /^"hi"$/);
});

test('the converted range still points at "hi" for a CRLF document', () => {
  const parsed = parseCompilerOutput('', fixture('finc-crlf.jsonl'));
  const error = parsed.diagnostics.find((diagnostic) => diagnostic.code === 'E0201')!;
  const document = new Document('file:///x/crlf.fin', 'fin', 1, fixture('crlf.fin'));
  const converted = compilerDiagnosticToLsp(document, error);
  assert.deepEqual(converted.range.start, { line: 1, character: 18 });
  assert.deepEqual(converted.range.end, { line: 1, character: 22 });
  assert.match(document.lineText(1).slice(18, 22), /^"hi"$/);
});

test('a real report with emoji converts byte columns to UTF-16 columns', () => {
  const parsed = parseCompilerOutput('', fixture('finc-unicode.jsonl'));
  const error = parsed.diagnostics.find((diagnostic) => diagnostic.code === 'E0201')!;
  // finc said column 46; the bytes before that point include a 4-byte emoji and
  // a 2-byte é, so the UTF-16 column is smaller.
  assert.equal(error.column, 46);
  const document = new Document('file:///x/unicode.fin', 'fin', 1, fixture('unicode.fin'));
  const converted = compilerDiagnosticToLsp(document, error);
  const line = document.lineText(1);
  assert.equal(line.slice(converted.range.start.character, converted.range.end.character), '"hi"');
  assert.deepEqual(converted.range, {
    start: { line: 1, character: 42 },
    end: { line: 1, character: 46 },
  });
});

test('byte columns and character columns differ once the line has non-ASCII text', () => {
  const line = '    let s <string> = "😀é"; let x <int> = "hi";';
  const byteIndex = Buffer.byteLength(line.slice(0, line.indexOf('"hi"')), 'utf8');
  const characterIndex = line.indexOf('"hi"');
  assert.ok(byteIndex > characterIndex, 'this line is chosen because the two units differ');
  assert.equal(byteOffsetToUtf16Column(line, byteIndex), characterIndex);
});

test('a byte offset inside a multi-byte character clamps to that character', () => {
  assert.equal(byteOffsetToUtf16Column('a😀b', 2), 1);
  assert.equal(byteOffsetToUtf16Column('a😀b', 5), 3);
});

test('byteOffsets past the end clamp to the line length', () => {
  assert.equal(byteOffsetToUtf16Column('abc', 99), 3);
  assert.equal(byteOffsetToUtf16Column('', 3), 0);
  assert.equal(byteOffsetToUtf16Column('abc', -1), 0);
});

test('a zero line is reported at the top of the file, not at a negative position', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'fun main() <noret> { }\n');
  const range = compilerRangeToLsp(document, {
    kind: 'diagnostic',
    message: 'module not found: nosuch',
    line: 0,
    column: 0,
    endLine: 0,
    endColumn: 0,
  });
  assert.deepEqual(range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
});

test('a position beyond the last line clamps to the document end', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'one\n');
  const range = compilerRangeToLsp(document, {
    kind: 'diagnostic',
    message: 'x',
    line: 99,
    column: 4,
    endLine: 99,
    endColumn: 5,
  });
  assert.equal(range.start.line, 1);
  assert.equal(range.end.line, 1);
});

test('an empty range at endColumn === column is preserved', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'fun main() <noret> {\n');
  const range = compilerRangeToLsp(document, {
    kind: 'diagnostic',
    message: "expected ';'",
    line: 2,
    column: 1,
    endLine: 2,
    endColumn: 1,
  });
  assert.deepEqual(range, { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } });
});

test('a multi-line diagnostic keeps its end line', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'aaa\nbbb\nccc\n');
  const range = compilerRangeToLsp(document, {
    kind: 'diagnostic',
    message: 'x',
    line: 1,
    column: 2,
    endLine: 3,
    endColumn: 3,
  });
  assert.deepEqual(range, { start: { line: 0, character: 1 }, end: { line: 2, character: 2 } });
});

test('severity words map to LSP numbers and an unknown word is not an error', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'a\n');
  const make = (severity: string | undefined) =>
    compilerDiagnosticToLsp(document, { kind: 'diagnostic', message: 'm', severity }).severity;
  assert.equal(make('error'), 1);
  assert.equal(make('warning'), 2);
  assert.equal(make('note'), 3);
  assert.equal(make('hint'), 4);
  assert.equal(make('something-new'), 3);
});

test('help text is appended to the message so it is never lost', () => {
  const document = new Document('file:///x/a.fin', 'fin', 1, 'a\n');
  const converted = compilerDiagnosticToLsp(document, {
    kind: 'diagnostic',
    message: 'module not found: x',
    help: 'searched: /lib/std, .',
  });
  assert.match(converted.message, /module not found: x/);
  assert.match(converted.message, /searched: \/lib\/std, \./);
});

test('the JSON stream is found on stderr, where finc 1.0.1 actually writes it', () => {
  const parsed = parseCompilerOutput('', fixture('finc-ascii.jsonl'));
  assert.equal(parsed.summary?.status, 'failed');
  assert.equal(parsed.diagnostics.length, 2);
});

test('human prose beside the stream is noise, not a diagnostic', () => {
  const parsed = parseCompilerOutput('', 'error: something\n{"kind":"summary","errors":0}\n');
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.summary?.errors, 0);
  assert.equal(parsed.noise.length, 0, 'non-JSON lines are skipped silently, not counted twice');
});

test('a truncated summary line is not mistaken for a clean run', () => {
  const parsed = parseCompilerOutput('', '{"kind":"summary","errors":1');
  assert.equal(parsed.summary, null);
  assert.equal(parsed.diagnostics.length, 0);
});

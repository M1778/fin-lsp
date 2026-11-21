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
import test from 'node:test';
import { Document } from '../src/document';

const URI = 'file:///tmp/fin-lsp-test/sample.fin';

test('lines are indexed for LF and CRLF alike', () => {
  const lf = new Document(URI, 'fin', 1, 'a\nb\nc');
  assert.equal(lf.lineCount, 3);
  assert.deepEqual([lf.lineText(0), lf.lineText(1), lf.lineText(2)], ['a', 'b', 'c']);

  const crlf = new Document(URI, 'fin', 1, 'a\r\nb\r\nc');
  assert.equal(crlf.lineCount, 3);
  assert.deepEqual([crlf.lineText(0), crlf.lineText(1), crlf.lineText(2)], ['a', 'b', 'c']);
});

test('a trailing newline creates a final empty line, as editors expect', () => {
  const document = new Document(URI, 'fin', 1, 'a\n');
  assert.equal(document.lineCount, 2);
  assert.equal(document.lineText(1), '');
  assert.deepEqual(document.positionAt(2), { line: 1, character: 0 });
});

test('a CRLF terminator is not part of the line text', () => {
  const document = new Document(URI, 'fin', 1, 'abc\r\ndef');
  assert.equal(document.lineText(0), 'abc');
  assert.equal(document.offsetAt({ line: 1, character: 0 }), 5);
});

test('incremental edits match a full replacement', () => {
  const original = 'fun main() <noret> {\n    let x <int> = 1;\n}\n';
  const document = new Document(URI, 'fin', 1, original);
  // Replace `1` with `2` on line 1.
  const start = original.indexOf('1;');
  document.applyChanges(
    [
      {
        range: document.rangeOf(start, start + 1),
        text: '2',
      },
    ],
    2,
  );
  assert.equal(document.getText(), original.replace('= 1;', '= 2;'));
  assert.equal(document.version, 2);
});

test('an edit spanning lines is applied at the right offsets', () => {
  const document = new Document(URI, 'fin', 1, 'one\ntwo\nthree');
  document.applyChanges(
    [
      {
        range: { start: { line: 0, character: 2 }, end: { line: 1, character: 1 } },
        text: 'X',
      },
    ],
    2,
  );
  assert.equal(document.getText(), 'onXwo\nthree');
});

test('a change without a range replaces the whole document', () => {
  const document = new Document(URI, 'fin', 1, 'old content');
  document.applyChanges([{ text: 'new content' }], 9);
  assert.equal(document.getText(), 'new content');
  assert.equal(document.version, 9);
});

test('out-of-range positions clamp instead of throwing', () => {
  const document = new Document(URI, 'fin', 1, 'ab\ncd');
  assert.deepEqual(document.clamp({ line: 99, character: 99 }), { line: 1, character: 2 });
  assert.deepEqual(document.clamp({ line: -3, character: -3 }), { line: 0, character: 0 });
  assert.equal(document.offsetAt({ line: 99, character: 99 }), 5);
});

test('positions count UTF-16 code units, so an emoji is two', () => {
  const document = new Document(URI, 'fin', 1, 'a😀b');
  assert.deepEqual(document.positionAt(1), { line: 0, character: 1 });
  assert.deepEqual(document.positionAt(3), { line: 0, character: 3 });
  assert.deepEqual(document.positionAt(4), { line: 0, character: 4 });
  assert.equal(document.offsetAt({ line: 0, character: 3 }), 3);
});

test('an edit after a multi-byte character lands on the right text', () => {
  const document = new Document(URI, 'fin', 1, 'let s <string> = "😀"; let y <int> = 1;');
  const y = document.getText().indexOf('y');
  document.applyChanges([{ range: document.rangeOf(y, y + 1), text: 'z' }], 2);
  assert.ok(document.getText().includes('let z <int>'));
});

test('a lone carriage return is kept as ordinary text', () => {
  const document = new Document(URI, 'fin', 1, 'a\rb\nc');
  assert.equal(document.lineCount, 2);
  assert.equal(document.lineText(0), 'a\rb');
});

test('the file name is recovered from a URI, including spaces and encoded characters', () => {
  assert.equal(new Document('file:///tmp/a%20b/my%20file.fin', 'fin', 1, '').fileName, 'my file.fin');
  assert.equal(new Document('file:///c%3A/Users/m/x.fin', 'fin', 1, '').fileName, 'x.fin');
});

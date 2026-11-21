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
import { importAt, scanImports, wordAt } from '../src/imports';

test('a selected import records each name and its range', () => {
  const [statement] = scanImports(['import { len, free_str } from strings::std;']);
  assert.equal(statement.module, 'strings');
  assert.deepEqual(
    statement.names.map((entry) => entry.name),
    ['len', 'free_str'],
  );
  assert.deepEqual(statement.names[0], { name: 'len', line: 0, start: 9, end: 12 });
  assert.deepEqual(statement.names[1], { name: 'free_str', line: 0, start: 14, end: 22 });
});

test('an aliased module import keeps its module, which the alias would otherwise hide', () => {
  const [statement] = scanImports(['import stdio::std as io;']);
  assert.equal(statement.module, 'stdio');
  assert.equal(statement.alias, 'io');
  assert.deepEqual(statement.moduleRange, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 12 },
  });
});

test('a bare module import is understood', () => {
  const [statement] = scanImports(['import networking;']);
  assert.equal(statement.module, 'networking');
  assert.equal(statement.names.length, 0);
});

test('a quoted path import records the path and its range', () => {
  const [statement] = scanImports(['import "../lib/x.fin";']);
  assert.equal(statement.path, '../lib/x.fin');
  assert.deepEqual(statement.pathRange, {
    start: { line: 0, character: 8 },
    end: { line: 0, character: 20 },
  });
});

test('a selected import from a quoted path keeps both', () => {
  const [statement] = scanImports(['import { Vector3 } from "tests/samples/structs.fin";']);
  assert.equal(statement.path, 'tests/samples/structs.fin');
  assert.equal(statement.module, null);
  assert.equal(statement.names[0].name, 'Vector3');
});

test('a trailing comment does not become part of the statement', () => {
  const [statement] = scanImports(['import { A, B } from x::std; // trailing comment']);
  assert.equal(statement.module, 'x');
  assert.deepEqual(
    statement.names.map((entry) => entry.name),
    ['A', 'B'],
  );
});

test('a wrapped import statement records line numbers per name', () => {
  const [statement] = scanImports(['import {', '  alpha,', '  beta', '} from mod::std;']);
  assert.equal(statement.module, 'mod');
  assert.deepEqual(
    statement.names.map((entry) => ({ name: entry.name, line: entry.line, start: entry.start })),
    [
      { name: 'alpha', line: 1, start: 2 },
      { name: 'beta', line: 2, start: 2 },
    ],
  );
  assert.deepEqual(statement.moduleRange, {
    start: { line: 3, character: 7 },
    end: { line: 3, character: 10 },
  });
});

test('an import is located under the cursor for each of its pieces', () => {
  const lines = ['import { len } from strings::std;'];
  const imports = scanImports(lines);
  assert.equal(importAt(imports, lines, { line: 0, character: 10 })?.kind, 'name');
  assert.equal(importAt(imports, lines, { line: 0, character: 10 })?.name, 'len');
  assert.equal(importAt(imports, lines, { line: 0, character: 20 })?.kind, 'module');
  assert.equal(importAt(imports, lines, { line: 0, character: 0 }), null);
  assert.equal(importAt(imports, lines, { line: 1, character: 0 }), null);
});

test('a path import is located under the cursor as a path', () => {
  const lines = ['import "../lib/x.fin";'];
  const imports = scanImports(lines);
  assert.equal(importAt(imports, lines, { line: 0, character: 10 })?.kind, 'path');
});

test('wordAt finds an identifier and includes a trailing bang', () => {
  const lines = ['    format!(x);'];
  const word = wordAt(lines, { line: 0, character: 6 });
  assert.equal(word?.word, 'format!');
  assert.deepEqual(word?.range, {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 11 },
  });
});

test('wordAt returns null where there is no identifier', () => {
  assert.equal(wordAt(['  +  '], { line: 0, character: 3 }), null);
  assert.equal(wordAt([], { line: 4, character: 0 }), null);
});

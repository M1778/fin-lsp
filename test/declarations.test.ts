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
import { codify, scanDeclarations } from '../src/declarations';
import { buildStdlibIndex, documentation, headerComment, toDocumentSymbols } from '../src/stdlib';

const REAL_STDLIB = '/home/M1778/Fin/lib/std';
const FIXTURE_STDLIB = path.join(__dirname, '..', '..', 'test', 'fixtures', 'stdlib');
// Tests that assert real library text use the shipped library; CI, which has no
// Fin build, uses the verbatim excerpt in test/fixtures/stdlib so the same code
// paths still run on every platform.
const hasRealStdlib = fs.existsSync(REAL_STDLIB);
const STDLIB = hasRealStdlib ? REAL_STDLIB : FIXTURE_STDLIB;

test('codify blanks comments and literal contents without moving offsets', () => {
  const source = 'let s <string> = "a // not a comment"; // real comment\n';
  const [line] = codify(source);
  assert.equal(line.length, source.split('\n')[0].length);
  assert.ok(!line.includes('not a comment'));
  assert.ok(!line.includes('real comment'));
  assert.ok(line.startsWith('let s <string> = "'));
});

test('codify handles block comments and nesting', () => {
  const source = 'a /* one /* nested */ still */ b\nc';
  const [first, second] = codify(source);
  assert.equal(first.length, 'a /* one /* nested */ still */ b'.length);
  assert.ok(!first.includes('still'));
  assert.equal(second, 'c');
});

test('declarations are found with signatures, docs and bodies', () => {
  const source = [
    '// A function that adds.',
    '// It is documented over two lines.',
    '#[export]',
    'pub fun add(a: int, b: int) <int> {',
    '    return a + b;',
    '}',
    '',
    'pub struct Point {',
    '    x <int>,',
    '}',
    '',
    'pub const LIMIT <int> = 10;',
  ].join('\n');
  const declarations = scanDeclarations(source);
  assert.deepEqual(
    declarations.map((declaration) => declaration.name),
    ['add', 'Point', 'LIMIT'],
  );
  const add = declarations[0];
  assert.equal(add.kind, 'function');
  assert.equal(add.signature, 'pub fun add(a: int, b: int) <int>');
  assert.equal(add.doc, 'A function that adds.\nIt is documented over two lines.');
  assert.equal(add.startLine, 3);
  assert.equal(add.endLine, 5);
  assert.equal(add.startCharacter, 8);
  assert.equal(declarations[1].kind, 'struct');
  assert.equal(declarations[2].kind, 'const');
});

test('a nullable return and a nullable function are both seen', () => {
  const declarations = scanDeclarations('pub fun? read_line() <string> { return null; }\n');
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].name, 'read_line');
  assert.equal(declarations[0].signature, 'pub fun? read_line() <string>');
});

test('a declaration inside a comment or string is not a declaration', () => {
  const source = [
    '// pub fun fake() <noret> {}',
    'let s <string> = "pub fun also_fake() <noret> {}";',
    'pub fun real() <noret> {}',
  ].join('\n');
  assert.deepEqual(
    scanDeclarations(source).map((declaration) => declaration.name),
    ['real'],
  );
});

test('@define is recognized and named', () => {
  const declarations = scanDeclarations('@define printf(fmt: string, ...) <noret>;\n');
  assert.equal(declarations[0].kind, 'define');
  assert.equal(declarations[0].name, 'printf');
  assert.equal(declarations[0].signature, '@define printf(fmt: string, ...) <noret>');
});

test('namespaces get an end that covers their body', () => {
  const source = ['namespace std {', '', 'pub fun a() <noret> { }', '', 'pub fun b() <noret> { }', '}'].join('\n');
  const declarations = scanDeclarations(source);
  const namespace = declarations[0];
  assert.equal(namespace.kind, 'namespace');
  assert.equal(namespace.startLine, 0);
  assert.equal(namespace.endLine, 5);
  assert.equal(namespace.container, null);
  assert.equal(declarations[1].container, 'std');
});

test('document symbols point their selection range at the name', () => {
  const declarations = scanDeclarations('pub fun hello() <noret> { }\n');
  const symbols = toDocumentSymbols(declarations);
  assert.equal(symbols[0].name, 'hello');
  assert.deepEqual(symbols[0].selectionRange.start, { line: 0, character: 8 });
  assert.deepEqual(symbols[0].selectionRange.end, { line: 0, character: 13 });
});

test('a module header skips the license banner and quotes the description', () => {
  const text = fs.readFileSync(path.join(STDLIB, 'strings.fin'), 'utf8');
  const header = headerComment(text);
  assert.match(header, /^Strings: length, comparison/);
  assert.ok(!header.includes('GNU General Public License'), 'the 33-line licence banner is not documentation');
});

test('the standard library index finds documented declarations', () => {
  const index = buildStdlibIndex(STDLIB);
  assert.ok(index.modules.size >= 3, `indexed ${index.modules.size} modules`);
  const len = index.symbols.get('len');
  assert.ok(len && len.length > 0, 'strings::std declares len');
  const strings = len!.find((entry) => entry.module.name === 'strings');
  assert.ok(strings, 'len comes from strings');
  assert.equal(strings!.declaration.signature, 'pub fun len(s: string) <int>');
  assert.match(strings!.declaration.doc, /byte length/i);
  const hover = documentation(strings!.module, strings!.declaration);
  assert.match(hover, /pub fun len\(s: string\) <int>/);
  // The location line names the file and the declaration's real line.
  assert.match(hover, /lib\/std\/strings\.fin:\d+/);
  const declaredAt = Number(/strings\.fin:(\d+)/.exec(hover)![1]);
  const source = fs.readFileSync(path.join(STDLIB, 'strings.fin'), 'utf8').split('\n');
  assert.match(source[declaredAt - 1], /fun len\(/);
  if (hasRealStdlib) assert.match(hover, /What `strings` provides/);
});

test('the index records the structures the outline promises', () => {
  const index = buildStdlibIndex(STDLIB);
  const collection = index.modules.get('collection');
  assert.ok(collection);
  const struct = collection!.declarations.find((declaration) => declaration.name === 'Collection');
  assert.ok(struct);
  assert.equal(struct!.kind, 'struct');
  assert.match(struct!.signature, /pub struct Collection<T>/);
  const stdio = index.modules.get('stdio');
  assert.ok(stdio!.declarations.some((declaration) => declaration.kind === 'define' && declaration.name === 'printf'));
  assert.ok(stdio!.declarations.some((declaration) => declaration.name === 'Printable' && declaration.kind === 'interface'));
});

test('completion items carry the real signature as detail', () => {
  const index = buildStdlibIndex(STDLIB);
  const item = index.completions.find((candidate) => candidate.label === 'free_str');
  assert.ok(item);
  assert.equal(item!.detail, 'pub fun free_str(s: string) <noret>');
  assert.match((item!.documentation as { value: string }).value, /Frees a string this module returned/);
});

test('a missing standard library fails loudly instead of indexing nothing', () => {
  assert.throws(() => buildStdlibIndex('/definitely/not/a/real/path'), /cannot read the Fin standard library/);
});

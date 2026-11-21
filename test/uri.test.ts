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
import { filePathFromUri, uriFromPath } from '../src/compiler';

test('a POSIX path with spaces round-trips through a file URI', () => {
  const path = '/tmp/a b/my file.fin';
  const uri = uriFromPath(path);
  assert.equal(uri, 'file:///tmp/a%20b/my%20file.fin');
  assert.equal(filePathFromUri(uri), path);
});

test('non-ASCII path segments are percent-encoded and decoded', () => {
  const path = '/home/u/ünïcode/f.fin';
  const uri = uriFromPath(path);
  assert.equal(uri, 'file:///home/u/%C3%BCn%C3%AFcode/f.fin');
  assert.equal(filePathFromUri(uri), path);
});

test('a Windows drive path keeps its colon and does not gain a leading slash', () => {
  const uri = uriFromPath('C:/Users/m/x.fin');
  assert.equal(uri, 'file:///C:/Users/m/x.fin');
  assert.equal(filePathFromUri(uri), 'C:/Users/m/x.fin');
});

test('a Windows path with backslashes becomes the same URI as one with slashes', () => {
  assert.equal(uriFromPath('C:\\Users\\m\\x.fin'), uriFromPath('C:/Users/m/x.fin'));
  assert.equal(filePathFromUri(uriFromPath('C:\\Users\\m\\x.fin')), 'C:/Users/m/x.fin');
});

test('a UNC share keeps its double leading slash in both directions', () => {
  const uri = uriFromPath('//server/share/x.fin');
  assert.equal(uri, 'file://server/share/x.fin');
  assert.equal(filePathFromUri(uri), '//server/share/x.fin');
});

test('a hash in a path is escaped so it is not read as a URI fragment', () => {
  const uri = uriFromPath('/path/with#hash.fin');
  assert.equal(uri, 'file:///path/with%23hash.fin');
  assert.equal(filePathFromUri(uri), '/path/with#hash.fin');
});

test('a non-file scheme is not treated as a path', () => {
  assert.equal(filePathFromUri('untitled:Untitled-1'), null);
  assert.equal(filePathFromUri('https://example.com/x.fin'), null);
});

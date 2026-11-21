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
import { FramingError, MessageReader, encodeMessage } from '../src/framing';

function collect(): { messages: unknown[]; reader: MessageReader } {
  const messages: unknown[] = [];
  return { messages, reader: new MessageReader((message) => messages.push(message)) };
}

test('Content-Length counts UTF-8 bytes, not JavaScript characters', () => {
  const message = { jsonrpc: '2.0', id: 1, result: { text: '😀é' } };
  const encoded = encodeMessage(message);
  const header = encoded.subarray(0, encoded.indexOf('\r\n\r\n')).toString('ascii');
  const body = encoded.subarray(encoded.indexOf('\r\n\r\n') + 4);
  const declared = Number(/Content-Length: (\d+)/.exec(header)?.[1]);
  assert.equal(declared, Buffer.byteLength(JSON.stringify(message), 'utf8'));
  assert.ok(declared > JSON.stringify(message).length, 'a UTF-8 payload is longer in bytes than in UTF-16 units');
  assert.equal(body.toString('utf8'), JSON.stringify(message));
});

test('a UTF-8 payload survives a full round trip', () => {
  const { messages, reader } = collect();
  const payload = { jsonrpc: '2.0', id: 'x', method: 'textDocument/hover', params: { mark: '😀漢字é' } };
  reader.push(encodeMessage(payload));
  assert.deepEqual(messages, [payload]);
});

test('a message split across chunks is reassembled', () => {
  const { messages, reader } = collect();
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, result: null });
  for (const byte of encoded) reader.push(Buffer.from([byte]));
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: null }]);
});

test('two messages in one chunk are both delivered', () => {
  const { messages, reader } = collect();
  reader.push(Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })]));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});

test('a body whose bytes are only half present waits instead of failing', () => {
  const { messages, reader } = collect();
  const encoded = encodeMessage({ id: 1, result: '😀' });
  reader.push(encoded.subarray(0, encoded.length - 1));
  assert.equal(messages.length, 0);
  reader.push(encoded.subarray(encoded.length - 1));
  assert.deepEqual(messages, [{ id: 1, result: '😀' }]);
});

test('LF-only header separators are accepted', () => {
  const { messages, reader } = collect();
  const body = JSON.stringify({ id: 7 });
  reader.push(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\n\n${body}`, 'utf8'));
  assert.deepEqual(messages, [{ id: 7 }]);
});

test('a missing Content-Length is a framing error, not a silent drop', () => {
  const { reader } = collect();
  assert.throws(() => reader.push(Buffer.from('Content-Type: application/json\r\n\r\n{}')), FramingError);
});

test('an oversized Content-Length is rejected before buffering the body', () => {
  const { reader } = collect();
  assert.throws(
    () => reader.push(Buffer.from('Content-Length: 999999999\r\n\r\n{')),
    /exceeds the/,
  );
});

test('a non-numeric Content-Length is a framing error', () => {
  const { reader } = collect();
  assert.throws(() => reader.push(Buffer.from('Content-Length: abc\r\n\r\n{}')), FramingError);
});

test('invalid JSON is reported, never half-dispatched', () => {
  const { messages, reader } = collect();
  assert.throws(() => reader.push(Buffer.from('Content-Length: 4\r\n\r\n{bad', 'utf8')), FramingError);
  assert.equal(messages.length, 0);
});

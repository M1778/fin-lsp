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

/**
 * JSON-RPC 2.0 over LSP base protocol framing.
 *
 * `Content-Length` counts the UTF-8 bytes of the body, not JavaScript string
 * units. A single emoji in a hover request makes those two numbers differ by
 * one, so the encoder and the decoder both work in Buffers and never in
 * `.length` of the JavaScript string.
 */

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

export class FramingError extends Error {}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function headerEnd(buffer: Buffer): { index: number; length: number } | null {
  const crlf = buffer.indexOf(HEADER_SEPARATOR);
  const lf = buffer.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseHeaders(raw: string): number {
  let contentLength: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new FramingError(`malformed header line: ${JSON.stringify(line)}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'content-length') {
      if (!/^\d+$/.test(value)) throw new FramingError(`bad Content-Length: ${JSON.stringify(value)}`);
      contentLength = Number(value);
    }
  }
  if (contentLength === null) throw new FramingError('message has no Content-Length header');
  return contentLength;
}

export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly maxBodyBytes = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = headerEnd(this.buffer);
      if (end === null) {
        if (this.buffer.length > 64 * 1024) throw new FramingError('header block exceeds 64 KiB');
        return;
      }
      const headerText = this.buffer.subarray(0, end.index).toString('ascii');
      const contentLength = parseHeaders(headerText);
      if (contentLength > this.maxBodyBytes) {
        throw new FramingError(`Content-Length ${contentLength} exceeds the ${this.maxBodyBytes} byte limit`);
      }
      const bodyStart = end.index + end.length;
      if (this.buffer.length < bodyStart + contentLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(body.toString('utf8')) as JsonRpcMessage;
      } catch (error) {
        throw new FramingError(`body is not valid JSON: ${(error as Error).message}`);
      }
      this.onMessage(parsed);
    }
  }
}

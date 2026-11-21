#!/usr/bin/env node
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
 * stdio entry point.
 *
 * The LSP base protocol owns stdout. Nothing else may write to it, so every
 * log line goes to stderr and every protocol message goes through
 * `encodeMessage`. A stray `console.log` would desynchronize the framing and
 * hang the editor, which is why there is none.
 */

import { MessageReader, encodeMessage, JsonRpcMessage } from './framing';
import { FinLanguageServer } from './server';

export const VERSION = '0.1.0';

function parseArgs(argv: string[]): { stdio: boolean; help: boolean; version: boolean } {
  const result = { stdio: true, help: false, version: false };
  for (const arg of argv) {
    if (arg === '--stdio') result.stdio = true;
    else if (arg === '--version' || arg === '-v') result.version = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
  }
  return result;
}

function usage(): string {
  return [
    'fin-lsp — Language Server Protocol server for the Fin programming language',
    '',
    'Usage: fin-lsp [--stdio]',
    '',
    'Options:',
    '  --stdio      Speak LSP over stdin/stdout (the default and only transport)',
    '  --version    Print the version and exit',
    '  --help       Print this message and exit',
    '',
    'Settings are read from initializationOptions.fin or from the client\'s',
    'workspace/didChangeConfiguration notification. See README.md.',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`fin-lsp ${VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  // A client that dies mid-write must not take the server down with an EPIPE.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    process.stderr.write(`fin-lsp: stdout error: ${error.message}\n`);
  });

  let server: FinLanguageServer;
  const send = (message: unknown): void => {
    try {
      process.stdout.write(encodeMessage(message));
    } catch (error) {
      process.stderr.write(`fin-lsp: could not send a message: ${(error as Error).message}\n`);
    }
  };
  const exit = (code: number): void => {
    server.dispose();
    process.exit(code);
  };
  server = new FinLanguageServer(send, exit);

  const reader = new MessageReader((message: JsonRpcMessage) => {
    dispatch(message);
  });

  function dispatch(message: JsonRpcMessage): void {
    if (message.method === undefined) {
      // A response to a server-initiated request; this server sends none, so
      // there is nothing to correlate.
      return;
    }
    if (message.id === undefined) {
      server.handleNotification(message.method, message.params);
      return;
    }
    void server.handleRequest(message.id, message.method, message.params).catch((error: Error) => {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `unhandled server error: ${error.message}` },
      });
    });
  }

  process.stdin.on('data', (chunk: Buffer) => {
    try {
      reader.push(chunk);
    } catch (error) {
      process.stderr.write(`fin-lsp: framing error: ${(error as Error).message}\n`);
      // The stream cannot be recovered: a half-read frame would desynchronize
      // every later message, so say so and stop rather than answering garbage.
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    // stdin closing is how a well-behaved client says goodbye; without an exit
    // notification the specification treats it as abnormal (1).
    process.exit(1);
  });
  process.on('SIGTERM', () => exit(0));
  process.on('SIGINT', () => exit(0));
}

if (require.main === module) {
  main();
}

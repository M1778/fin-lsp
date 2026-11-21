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

import { Position, Range, TextDocumentContentChangeEvent } from './types';

export interface LineSource {
  readonly lineCount: number;
  lineText(line: number): string;
}

/**
 * An in-memory Fin source file with incremental updates.
 *
 * Line starts are UTF-16 offsets, because that is the unit LSP positions use.
 * `lineText` drops the line terminator (`\n` or `\r\n`), so a position never
 * points at a newline character. Everything else is preserved verbatim,
 * including a lone `\r` in the middle of a line, which is just text to LSP.
 */
export class Document implements LineSource {
  private text: string;
  private starts: number[] | null = null;

  constructor(
    readonly uri: string,
    readonly languageId: string,
    private documentVersion: number,
    text: string,
  ) {
    this.text = text;
  }

  get version(): number {
    return this.documentVersion;
  }

  getText(): string {
    return this.text;
  }

  /** Number of lines; a trailing terminator creates one final empty line. */
  get lineCount(): number {
    this.ensureStarts();
    return this.starts!.length;
  }

  private ensureStarts(): void {
    if (this.starts !== null) return;
    const starts = [0];
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }

  lineText(line: number): string {
    this.ensureStarts();
    if (line < 0) return '';
    if (line >= this.starts!.length) return '';
    const start = this.starts![line];
    let end = line + 1 < this.starts!.length ? this.starts![line + 1] - 1 : this.text.length;
    if (end > start && this.text.charCodeAt(end - 1) === 13) end--;
    return this.text.slice(start, end);
  }

  /** Clamp a position into the document, as the LSP specification requires. */
  clamp(position: Position): Position {
    const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
    const character = Math.max(0, Math.min(position.character, this.lineText(line).length));
    return { line, character };
  }

  offsetAt(position: Position): number {
    this.ensureStarts();
    const { line, character } = this.clamp(position);
    return this.starts![line] + character;
  }

  positionAt(offset: number): Position {
    this.ensureStarts();
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.starts!.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts![mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - this.starts![low] };
  }

  rangeOf(startOffset: number, endOffset: number): Range {
    const a = this.positionAt(startOffset);
    const b = this.positionAt(endOffset);
    return { start: a, end: b };
  }

  /**
   * Apply LSP incremental changes. A change without a range replaces the whole
   * document; a change with a range replaces exactly that slice. Ranges are
   * clamped per specification, so a client that is one edit behind cannot
   * corrupt the buffer.
   */
  applyChanges(changes: TextDocumentContentChangeEvent[], version: number): void {
    for (const change of changes) {
      if (!change.range) {
        this.text = change.text;
      } else {
        const start = this.offsetAt(change.range.start);
        const end = this.offsetAt(change.range.end);
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        this.text = this.text.slice(0, from) + change.text + this.text.slice(to);
      }
      this.starts = null;
    }
    this.documentVersion = version;
  }

  /** A stable key for stale-result checks and staging file names. */
  get fileName(): string {
    const path = this.uri.replace(/^file:\/\//, '');
    try {
      return decodeURIComponent(path).replace(/\\/g, '/').split('/').pop() || 'input.fin';
    } catch {
      return path.split('/').pop() || 'input.fin';
    }
  }
}

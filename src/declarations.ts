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

import { SymbolKind } from './types';

export type DeclarationKind = 'function' | 'struct' | 'const' | 'namespace' | 'define' | 'enum' | 'interface';

export interface Declaration {
  name: string;
  kind: DeclarationKind;
  /** The declaration text with the body removed and whitespace collapsed. */
  signature: string;
  /** The contiguous `//` block above the declaration, attributes skipped. */
  doc: string;
  startLine: number;
  startCharacter: number;
  /** Last line of the declaration body (the `}` line for a namespace). */
  endLine: number;
  endCharacter: number;
  /** Name of the enclosing namespace, when there is one. */
  container: string | null;
}

const KIND_TO_SYMBOL: Record<DeclarationKind, number> = {
  function: SymbolKind.Function,
  struct: SymbolKind.Struct,
  const: SymbolKind.Constant,
  namespace: SymbolKind.Namespace,
  define: SymbolKind.Function,
  enum: SymbolKind.Enum,
  interface: SymbolKind.Struct,
};

export function symbolKindFor(kind: DeclarationKind): number {
  return KIND_TO_SYMBOL[kind];
}

/**
 * Blank out comments and the inside of string and character literals, keeping
 * every other character in place.
 *
 * Offsets stay valid, so a match found here points at real source. Blanking the
 * literal bodies matters: a `//` inside a string must not start a comment, and a
 * line inside a doc block that mentions `struct Foo` must not become a symbol.
 * Block comments nest, as the compiler's lexer does (lexer.l, BLOCK_COMMENT).
 */
export function codify(text: string): string[] {
  const lines = text.split('\n');
  const result: string[] = [];
  let inBlockComment = 0;
  let inString = false;
  for (const line of lines) {
    const characters: string[] = [];
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlockComment > 0) {
        if (ch === '/' && next === '*') {
          inBlockComment++;
          characters.push('  ');
          i++;
        } else if (ch === '*' && next === '/') {
          inBlockComment--;
          characters.push('  ');
          i++;
        } else {
          characters.push(' ');
        }
        continue;
      }
      if (inString) {
        characters.push(' ');
        if (ch === '\\') {
          characters.push(' ');
          i++;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        characters.push(ch);
        continue;
      }
      if (ch === '/' && next === '/') {
        // A comment ends the line, so pad the rest to keep later lines aligned
        // only when offsets matter; here the line is simply shorter, and callers
        // must never use a codified line's length as a source offset past `//`.
        characters.push(...Array.from(line.slice(i)).map(() => ' '));
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = 1;
        characters.push('  ');
        i++;
        continue;
      }
      characters.push(ch);
    }
    result.push(characters.join(''));
  }
  return result;
}

const DECLARATION_START =
  /^(\s*)(?:(pub|priv)\s+)?(fun\?|fun|struct|const|enum|interface|namespace)\s+([A-Za-z_][A-Za-z0-9_]*)|^(\s*)@define\s+([A-Za-z_][A-Za-z0-9_]*)/;

type Matched = { kind: DeclarationKind; name: string; indent: number };

function matchDeclaration(code: string): Matched | null {
  const match = DECLARATION_START.exec(code);
  if (!match) return null;
  const indent = match[1]?.length ?? match[5]?.length ?? 0;
  if (match[6]) return { kind: 'define', name: match[6], indent };
  const keyword = match[3];
  const name = match[4];
  if (!keyword || !name) return null;
  switch (keyword) {
    case 'fun':
    case 'fun?':
      return { kind: 'function', name, indent };
    case 'struct':
      return { kind: 'struct', name, indent };
    case 'const':
      return { kind: 'const', name, indent };
    case 'enum':
      return { kind: 'enum', name, indent };
    case 'interface':
      return { kind: 'interface', name, indent };
    case 'namespace':
      return { kind: 'namespace', name, indent };
    default:
      return null;
  }
}

/** Docs live above the attributes, so skip `#[...]`, `#c_*` and `@...` lines. */
function isAttributeLine(trimmed: string): boolean {
  return trimmed.startsWith('#[') || trimmed.startsWith('@') || /^#(c_|endif|else|ifdef)/.test(trimmed);
}

function docFor(lines: string[], declarationLine: number): string {
  let index = declarationLine - 1;
  while (index >= 0 && isAttributeLine(lines[index].trim())) index--;
  const collected: string[] = [];
  while (index >= 0) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('//')) break;
    collected.unshift(trimmed.slice(2).replace(/^\s?/, ''));
    index--;
  }
  return collected.join('\n').trim();
}

function signatureFor(code: string[], startLine: number, startCharacter: number): string {
  const pieces: string[] = [];
  for (let line = startLine; line < code.length && line < startLine + 16; line++) {
    const slice = line === startLine ? code[line].slice(startCharacter) : code[line];
    const stop = firstBodyToken(slice);
    if (stop < 0) {
      pieces.push(slice.trim());
      continue;
    }
    pieces.push(slice.slice(0, stop).trim());
    break;
  }
  return pieces
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s;{]+$/, '')
    .trim();
}

/** Index of the `{` or `;` that ends a declaration header, outside any brackets. */
function firstBodyToken(slice: string): number {
  let round = 0;
  let square = 0;
  let angle = 0;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === ';' && round <= 0 && square <= 0 && angle <= 0) return i;
    else if (ch === '{' && round <= 0 && square <= 0 && angle <= 0) return i;
  }
  return -1;
}

/**
 * The line that ends a declaration.
 *
 * A `;` ends a declaration on its own line. A `{` opens a body, and the
 * matching `}` -- counted on codified source, so braces in strings and comments
 * are ignored -- ends it. A namespace body nests, which falls out of the same
 * counter.
 */
function bodyEnd(code: string[], startLine: number, startCharacter: number): { line: number; character: number } {
  let depth = 0;
  let opened = false;
  for (let line = startLine; line < code.length; line++) {
    const text = line === startLine ? code[line].slice(startCharacter) : code[line];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ';' && depth === 0 && !opened) return { line, character: text.length };
      if (ch === '{') {
        opened = true;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (opened && depth === 0) return { line, character: text.length };
      }
    }
  }
  const last = Math.max(startLine, code.length - 1);
  return { line: last, character: code[last]?.length ?? 0 };
}

/**
 * All declarations in one file, in source order, with namespace containment and
 * an end line that covers the body.
 *
 * Only column-zero declarations are reported. A method indented inside a struct
 * is real, but it is not a module symbol and it is not what the outline of a
 * 49-module library should be built from.
 */
export function scanDeclarations(text: string): Declaration[] {
  const code = codify(text);
  const lines = text.split('\n');
  const declarations: Declaration[] = [];

  for (let index = 0; index < code.length; index++) {
    const matched = matchDeclaration(code[index]);
    if (!matched || matched.indent !== 0) continue;
    const nameIndex = code[index].indexOf(matched.name, matched.indent);
    const signature = signatureFor(code, index, 0);
    const end = bodyEnd(code, index, 0);
    let container: string | null = null;
    for (const candidate of declarations) {
      if (candidate.kind !== 'namespace') continue;
      if (index > candidate.startLine && index <= candidate.endLine) container = candidate.name;
    }
    declarations.push({
      name: matched.name,
      kind: matched.kind,
      signature,
      doc: docFor(lines, index),
      startLine: index,
      startCharacter: Math.max(0, nameIndex),
      endLine: end.line,
      endCharacter: end.character,
      container,
    });
  }
  return declarations;
}

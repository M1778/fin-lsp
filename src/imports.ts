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

import * as fs from 'fs';
import * as path from 'path';
import { uriFromPath } from './compiler';
import { Declaration } from './declarations';
import { Location, Position, Range } from './types';

/**
 * A declaration the document brought into scope with `import`.
 *
 * Fin has four spellings that matter here:
 *   import { a, b } from module::std;
 *   import { a } from "relative/path.fin";
 *   import module::std as alias;
 *   import "file.fin";
 */
export interface ImportedSymbol {
  name: string;
  /** Module name, without `.fin`; `null` for a path import. */
  module: string | null;
  /** Absolute path of the declaring file. */
  file: string;
  /** Declaration inside that file, if it could be found. */
  declaration: Declaration | null;
}

export interface ImportStatement {
  /** The module name for `module::std`, or the alias/whole-module name. */
  module: string | null;
  alias: string | null;
  names: Array<{ name: string; line: number; start: number; end: number }>;
  /** Range of the module token in the statement. */
  moduleRange: Range | null;
  /** For `import "path.fin"` the quoted path and its range. */
  path: string | null;
  pathRange: Range | null;
  startLine: number;
}

export interface ResolvedImport {
  statement: ImportStatement;
  /** Absolute file the module resolved to, or null. */
  file: string | null;
  module: string | null;
  symbols: Map<string, Declaration>;
}

const IMPORT_START = /^\s*import\b/;

/**
 * Find the import on a line and the token under a cursor column.
 *
 * The scanner is deliberately conservative: it understands the four shipped
 * spellings and returns null for anything it does not fully parse. A wrong
 * completion or a wrong jump is worse than none.
 */
export function scanImports(lines: string[]): ImportStatement[] {
  const statements: ImportStatement[] = [];
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    if (!IMPORT_START.test(text)) continue;
    const statement: ImportStatement = {
      module: null,
      alias: null,
      names: [],
      moduleRange: null,
      path: null,
      pathRange: null,
      startLine: line,
    };
    // A single statement may wrap; collect until `;` or `}` closes it.
    let combined = text;
    for (let extra = line + 1; extra < lines.length && !/[;}]\s*$/.test(combined); extra++) {
      combined += '\n' + lines[extra];
      line = extra;
    }
    const aliasMatch = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(combined);
    if (aliasMatch && aliasMatch.index !== undefined) statement.alias = aliasMatch[1];

    const pathMatch = /import\s+(?:[^"]*?from\s+)?"([^"]+)"/.exec(combined);
    if (pathMatch) {
      statement.path = pathMatch[1];
      const offset = pathMatch.index + pathMatch[0].lastIndexOf('"' + pathMatch[1]);
      const before = combined.slice(0, offset);
      const startLine = statement.startLine + (before.match(/\n/g)?.length ?? 0);
      const lineStart = before.lastIndexOf('\n') + 1;
      statement.pathRange = {
        start: { line: startLine, character: offset - lineStart + 1 },
        end: { line: startLine, character: offset - lineStart + 1 + pathMatch[1].length },
      };
    }

    const namedMatch = /\{([^}]*)\}/.exec(combined);
    if (namedMatch) {
      const blockStart = namedMatch.index + 1;
      const entries = namedMatch[1].split(',');
      let cursor = 0;
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (trimmed === '') {
          cursor += entry.length + 1;
          continue;
        }
        const localIndex = entry.indexOf(trimmed);
        const absolute = blockStart + cursor + localIndex;
        const before = combined.slice(0, absolute);
        const startLine = statement.startLine + (before.match(/\n/g)?.length ?? 0);
        const lineStart = before.lastIndexOf('\n') + 1;
        const name = trimmed.split(/\s/)[0];
        statement.names.push({
          name,
          line: startLine,
          start: absolute - lineStart,
          end: absolute - lineStart + name.length,
        });
        cursor += entry.length + 1;
      }
    }

    // `from module::std`, `import module::std`, `import module::std as alias`,
    // and `import * from module::std`. The `as` clause must be consumed here or
    // an aliased import matches no alternative at all.
    const moduleMatch =
      /from\s+([A-Za-z_][A-Za-z0-9_:]*)|import\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*(?:;|$)/.exec(
        combined,
      );
    if (moduleMatch && !statement.path) {
      const raw = moduleMatch[1] ?? moduleMatch[2];
      const absolute = moduleMatch.index + moduleMatch[0].indexOf(raw);
      const before = combined.slice(0, absolute);
      const startLine = statement.startLine + (before.match(/\n/g)?.length ?? 0);
      const lineStart = before.lastIndexOf('\n') + 1;
      statement.module = raw.split('::')[0];
      statement.moduleRange = {
        start: { line: startLine, character: absolute - lineStart },
        end: { line: startLine, character: absolute - lineStart + raw.split('::')[0].length },
      };
    }
    statements.push(statement);
  }
  return statements;
}

function resolveModuleFile(
  module: string,
  documentDirectory: string | null,
  stdlibRoot: string,
): string | null {
  const candidates: string[] = [];
  if (documentDirectory) {
    candidates.push(path.join(documentDirectory, `${module}.fin`));
    candidates.push(path.join(documentDirectory, module, 'index.fin'));
  }
  candidates.push(path.join(stdlibRoot, `${module}.fin`));
  candidates.push(path.join(stdlibRoot, module, 'index.fin'));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function resolvePathImport(
  relative: string,
  documentDirectory: string | null,
  stdlibRoot: string,
): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(relative)) candidates.push(relative);
  else if (documentDirectory) {
    candidates.push(path.join(documentDirectory, relative));
    candidates.push(path.join(documentDirectory, relative + '.fin'));
  }
  if (!path.isAbsolute(relative)) {
    candidates.push(path.join(stdlibRoot, relative));
    candidates.push(path.join(stdlibRoot, relative + '.fin'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveImports(
  imports: ImportStatement[],
  documentDirectory: string | null,
  stdlibRoot: string,
  scan: (file: string) => Declaration[],
): ResolvedImport[] {
  const resolved: ResolvedImport[] = [];
  for (const statement of imports) {
    let file: string | null = null;
    let module: string | null = null;
    if (statement.path) {
      file = resolvePathImport(statement.path, documentDirectory, stdlibRoot);
      module = path.basename(statement.path).replace(/\.fin$/, '');
    } else if (statement.module) {
      module = statement.module;
      file = resolveModuleFile(statement.module, documentDirectory, stdlibRoot);
    }
    const symbols = new Map<string, Declaration>();
    if (file) {
      let declarations: Declaration[] = [];
      try {
        declarations = scan(file);
      } catch {
        declarations = [];
      }
      for (const declaration of declarations) symbols.set(declaration.name, declaration);
    }
    resolved.push({ statement, file, module, symbols });
  }
  return resolved;
}

export function declarationLocation(file: string, declaration: Declaration): Location {
  return {
    uri: uriFromPath(file),
    range: {
      start: { line: declaration.startLine, character: declaration.startCharacter },
      end: { line: declaration.startLine, character: declaration.startCharacter + declaration.name.length },
    },
  };
}

/**
 * The identifier under the cursor, as a name plus the range it occupies.
 *
 * Fin identifiers include letters, digits, `_` and `!` (builtin names such as
 * `format!`), so `!` is only absorbed when it directly follows the name.
 */
export function wordAt(
  lines: string[],
  position: Position,
): { word: string; range: Range; prefix: string } | null {
  const line = lines[position.line];
  if (line === undefined) return null;
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let start = position.character;
  let end = position.character;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  if (end < line.length && line[end] === '!' && end > start) end++;
  if (start === end) return null;
  return {
    word: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
    prefix: line.slice(start, end),
  };
}

/**
 * The import statement a cursor position belongs to.
 *
 * Only the import statement itself answers a definition request. A use of an
 * imported name goes through the ordinary symbol path, which is not implemented
 * for arbitrary expressions -- and returning null there is correct, because a
 * guessed jump is worse than no jump.
 */
export function importAt(
  imports: ImportStatement[],
  lines: string[],
  position: Position,
): { statement: ImportStatement; kind: 'path' | 'module' | 'name'; name?: string } | null {
  for (const statement of imports) {
    const inRange = (range: Range | null): boolean =>
      range !== null && isInside(range, position);
    if (inRange(statement.pathRange)) return { statement, kind: 'path' };
    if (inRange(statement.moduleRange)) return { statement, kind: 'module' };
    for (const named of statement.names) {
      if (named.line === position.line && position.character >= named.start && position.character <= named.end) {
        return { statement, kind: 'name', name: named.name };
      }
    }
  }
  return null;
}

export function isInside(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

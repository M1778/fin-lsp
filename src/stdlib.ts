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
import { Declaration, scanDeclarations, symbolKindFor } from './declarations';
import { CompletionItem, DocumentSymbol, MarkupContent } from './types';

export interface ModuleIndex {
  /** Module name without the `.fin` extension, e.g. `strings` for `strings.fin`. */
  name: string;
  path: string;
  /** The file's leading `//` banner: what this module provides, in its own words. */
  header: string;
  declarations: Declaration[];
}

export interface StdlibIndex {
  root: string;
  builtAt: number;
  modules: Map<string, ModuleIndex>;
  /** Every exported declaration, keyed by name. Later modules do not win blindly. */
  symbols: Map<string, Array<{ module: ModuleIndex; declaration: Declaration }>>;
  /** Declarations whose name is used without a module prefix (namespaced `pub`). */
  completions: CompletionItem[];
}

const COMPLETION_KIND: Record<string, number> = {
  function: 3,
  struct: 22,
  const: 21,
  enum: 13,
  interface: 8,
};

/**
 * The module's own description: the comment block after the license banner.
 *
 * Every module starts with the same 33-line legal banner, so quoting it would
 * put the same useless text in every hover. The block that follows is the one
 * that states what the module provides and what it does not.
 */
export function headerComment(text: string): string {
  const lines = text.split('\n');
  let banners = 0;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\/\/ =+$/.test(lines[i].trim())) {
      banners++;
      if (banners === 2) {
        start = i + 1;
        break;
      }
    }
  }
  const collected: string[] = [];
  let started = false;
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) {
      started = true;
      collected.push(trimmed.slice(2).replace(/^\s?/, ''));
      continue;
    }
    if (trimmed === '' && started) {
      // A blank line continues the block only if prose resumes right after it.
      const next = lines[i + 1]?.trim() ?? '';
      if (next.startsWith('//') && !/^\/\/ =+$/.test(next)) {
        collected.push('');
        continue;
      }
      break;
    }
    if (trimmed === '') continue;
    break;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return collected.join('\n').trim();
}

export function buildStdlibIndex(root: string): StdlibIndex {
  const modules = new Map<string, ModuleIndex>();
  const symbols = new Map<string, Array<{ module: ModuleIndex; declaration: Declaration }>>();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    throw new Error(`cannot read the Fin standard library at ${root}: ${(error as Error).message}`);
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.fin')) continue;
    const full = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const module: ModuleIndex = {
      name: entry.slice(0, -4),
      path: full,
      header: headerComment(text),
      declarations: scanDeclarations(text),
    };
    modules.set(module.name, module);
    for (const declaration of module.declarations) {
      if (declaration.kind === 'namespace') continue;
      const bucket = symbols.get(declaration.name);
      if (bucket) bucket.push({ module, declaration });
      else symbols.set(declaration.name, [{ module, declaration }]);
    }
  }
  const completions: CompletionItem[] = [];
  for (const [name, entriesForName] of symbols) {
    const first = entriesForName[0];
    completions.push({
      label: name,
      kind: COMPLETION_KIND[first.declaration.kind] ?? 1,
      detail: first.declaration.signature,
      documentation: { kind: 'markdown', value: documentation(first.module, first.declaration) } as MarkupContent,
      sortText: `${first.declaration.kind === 'function' ? '1' : '0'}${name}`,
    });
  }
  completions.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
  return { root, builtAt: Date.now(), modules, symbols, completions };
}

export function documentation(module: ModuleIndex, declaration: Declaration): string {
  const parts: string[] = [];
  parts.push('```fin\n' + declaration.signature + '\n```');
  const qualified = `\`${module.name}::std\`${declaration.container ? ` (namespace \`${declaration.container}\`)` : ''}`;
  parts.push(`Declared in ${qualified} — \`lib/std/${module.name}.fin:${declaration.startLine + 1}\``);
  if (declaration.doc) parts.push(declaration.doc);
  const header = module.header.split('\n').slice(0, 40).join('\n').trim();
  if (header) parts.push(`---\n*What \`${module.name}\` provides, from its own header:*\n\n${header}`);
  return parts.join('\n\n');
}

export function toDocumentSymbols(declarations: Declaration[]): DocumentSymbol[] {
  return declarations.map((declaration) => ({
    name: declaration.name,
    detail: declaration.signature,
    kind: symbolKindFor(declaration.kind),
    range: {
      start: { line: declaration.startLine, character: 0 },
      end: { line: declaration.endLine, character: declaration.endCharacter },
    },
    selectionRange: {
      start: { line: declaration.startLine, character: declaration.startCharacter },
      end: {
        line: declaration.startLine,
        character: declaration.startCharacter + declaration.name.length,
      },
    },
  }));
}

/** Find the declaration a line/label sits on, so hover and definition agree. */
export function declarationAt(declarations: Declaration[], line: number): Declaration | null {
  for (const declaration of declarations) {
    if (line === declaration.startLine) return declaration;
  }
  return null;
}


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

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ToolSpec {
  command: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  /** Aborting kills the child; a superseded diagnostic run must not linger. */
  signal?: AbortSignal;
  /** Environment additions; the rest of the environment is inherited. */
  env?: Record<string, string>;
}

export interface ToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start at all (ENOENT and friends). */
  spawnError?: NodeJS.ErrnoException;
  timedOut: boolean;
  /** Set when the caller's AbortSignal killed the run. */
  aborted: boolean;
}

/**
 * Run a tool with an argv array, never a shell.
 *
 * `shell: true` would split a path containing a space into two arguments and
 * would make a document name an injection vector. There is no code path here
 * that builds a command string.
 */
export function runTool(spec: ToolSpec): Promise<ToolResult> {
  if (spec.signal?.aborted) {
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const finish = (result: Omit<ToolResult, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve({
        ...result,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        shell: false,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: error as NodeJS.ErrnoException,
        timedOut: false,
        aborted: false,
      });
      return;
    }
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: null, signal: null, timedOut: false, aborted: true });
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) =>
      finish({ code: null, signal: null, spawnError: error, timedOut: false, aborted: false }),
    );
    child.on('close', (code, signal) =>
      finish({ code, signal, timedOut: false, aborted: spec.signal?.aborted ?? false }),
    );
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({ code: null, signal: null, timedOut: true, aborted: false });
      }, spec.timeoutMs);
    }
    if (spec.stdin !== undefined) {
      child.stdin?.on('error', () => {
        /* the child may exit before reading; that is not a server fault */
      });
      child.stdin?.end(spec.stdin);
    }
  });
}

export function executableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchPath(name: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name.endsWith(extension) ? name : name + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Where a tool comes from, in the documented order:
 * configured path, then PATH, then the default build location.
 */
export function resolveTool(
  configured: string | undefined,
  base: string,
  defaultPath: string,
): { path: string; source: 'setting' | 'path' | 'default' } | null {
  if (configured && configured.trim() !== '') {
    const expanded = configured.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (isExecutableFile(expanded)) return { path: expanded, source: 'setting' };
    // A configured path that does not exist is a configuration error the user
    // must see, not something to paper over by searching PATH behind their back.
    return null;
  }
  const onPath = searchPath(executableName(base));
  if (onPath) return { path: onPath, source: 'path' };
  if (defaultPath && isExecutableFile(defaultPath)) return { path: defaultPath, source: 'default' };
  return null;
}

export function defaultFinRoot(): string {
  return '/home/M1778/Fin';
}

export function defaultCompilerPath(): string {
  return path.join(defaultFinRoot(), 'build', executableName('finc'));
}

export function defaultFormatterPath(): string {
  return path.join(defaultFinRoot(), 'build', 'tools', 'fmt', executableName('finfmt'));
}

export function defaultStdlibPath(): string {
  return path.join(defaultFinRoot(), 'lib', 'std');
}

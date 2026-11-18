// Small file helpers for the command-line tools.
// Personal data and caches live in .eval_cache/, which is git-ignored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const cacheDir = '.eval_cache';

export function readJson(path: string): any | undefined {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
}

import { createHash } from 'node:crypto';
import { readOptional } from './indexer';
import { safePath } from './paths';

export interface CacheEntry { files: string[]; hashes: Record<string, string | null>; namingNotice?: string }
export interface RunCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}
export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function snapshot(root: string, paths: string[]): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const relative of new Set(paths)) {
    const content = await readOptional(await safePath(root, relative));
    hashes[relative] = content === null ? null : fingerprint(content);
  }
  return hashes;
}

export async function cacheMatches(root: string, entry: CacheEntry): Promise<boolean> {
  try {
    if (!entry.files.length || entry.files.some(file => !entry.hashes[file])) return false;
    const current = await snapshot(root, Object.keys(entry.hashes));
    return Object.keys(current).every(file => current[file] === entry.hashes[file]);
  } catch { return false; }
}

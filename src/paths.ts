import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export function resolveInside(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\') || relative.includes(':')) {
    throw new Error(`Expected a workspace-relative path with forward slashes: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path must stay inside the workspace: ${relative}`);
  }
  return resolved;
}

// Reject symlinks/junctions even when their lexical path appears to be inside the repo.
export async function safePath(root: string, relative: string): Promise<string> {
  const target = resolveInside(root, relative);
  const canonicalRoot = await realpath(root);
  let current = path.resolve(root);
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relative}`);
      const real = await realpath(current);
      const rel = path.relative(canonicalRoot, real);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path escapes the workspace: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

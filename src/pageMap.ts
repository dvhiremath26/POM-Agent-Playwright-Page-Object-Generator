import { writeFile } from 'node:fs/promises';
import { Project } from 'ts-morph';
import { readOptional } from './indexer';
import { safePath } from './paths';
import { GeneratedFile } from './types';

export async function loadPageMap(root: string): Promise<Record<string, string>> {
  const file = await safePath(root, 'pageMap.json');
  const content = await readOptional(file);
  if (content === null) { await writeFile(file, '{}\n', { flag: 'wx' }); return {}; }
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error('pageMap.json must map route strings to page class names.');
  }
  return value as Record<string, string>;
}

export async function savePageMap(root: string, map: Record<string, string>): Promise<void> {
  await writeFile(await safePath(root, 'pageMap.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
}

export async function extractPageMappings(root: string, files: GeneratedFile[]): Promise<Record<string, string>> {
  const project = new Project({ useInMemoryFileSystem: true });
  const result: Record<string, string> = {};
  for (const file of files.filter(item => item.path.endsWith('.page.ts'))) {
    const content = await readOptional(await safePath(root, file.path));
    if (!content) continue;
    const source = project.createSourceFile(`/${file.path}`, content);
    const name = source.getClasses()[0]?.getName();
    const folder = file.path.split('/').at(-2);
    if (name && folder) result[`/${folder}`] = name;
  }
  return result;
}

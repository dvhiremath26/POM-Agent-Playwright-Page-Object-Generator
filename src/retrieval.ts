import { ContextFile, RepoContext } from './types';

function terms(text: string): Set<string> {
  const common = new Set(['page', 'await', 'test', 'expect', 'const', 'get', 'role', 'text', 'click', 'fill', 'async', 'import', 'from', 'class', 'export', 'string', 'readonly', 'constructor', 'locator', 'this', 'promise', 'void']);
  return new Set((text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter(word => !common.has(word)));
}

/** Lexical retrieval is entirely local. Send full relevant files, never sliced class bodies. */
export function selectRelevantContext(source: string, ctx: RepoContext, maxChars = 16_000, maxFiles = 6): RepoContext {
  if ((ctx.conventions?.length ?? 0) > maxChars) throw new Error('Conventions exceed the local retrieval character budget. Shorten them or pass a larger budget.');
  const query = terms(source);
  const mappedNames = Object.entries(ctx.pageMap ?? {}).filter(([route]) => source.includes(route)).map(([, name]) => name);
  const score = (file: ContextFile): number => {
    let value = 0;
    for (const word of terms(file.relativePath)) if (query.has(word)) value += 10;
    for (const word of terms(file.content)) if (query.has(word)) value++;
    if (mappedNames.some(name => file.content.includes(`class ${name}`))) value += 100;
    if (/class\s+BasePage\b|\bdataProviderTest\b/.test(file.content)) value += 25;
    if (file.relativePath === 'tsconfig.json') value += 100;
    return value;
  };
  const ranked = [...ctx.existingPages, ...(ctx.supportingFiles ?? [])]
    .map(file => ({ file, score: score(file) }))
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));
  const selected = new Set<string>();
  let size = ctx.conventions?.length ?? 0;
  for (const item of ranked) {
    if (item.score <= 0 || selected.size >= maxFiles || size + item.file.content.length > maxChars) continue;
    selected.add(item.file.relativePath); size += item.file.content.length;
  }
  return {
    ...ctx,
    existingPages: ctx.existingPages.filter(file => selected.has(file.relativePath)),
    supportingFiles: ctx.supportingFiles?.filter(file => selected.has(file.relativePath)),
    pageInventory: ctx.existingPages.map(file => file.relativePath),
    omittedContext: ranked.length - selected.size,
  };
}

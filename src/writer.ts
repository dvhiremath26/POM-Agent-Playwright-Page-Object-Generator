import { mkdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { IndentationText, Node, Project, SourceFile, SyntaxKind } from 'ts-morph';
import { safePath, resolveInside } from './paths';
import { defaultDirectories, GeneratedFile, OutputDirectories } from './types';
import { readOptional } from './indexer';

export class FileTransaction {
  private changes = new Map<string, { before: string | null; after: string }>();
  async apply(file: string, before: string | null, after: string): Promise<void> {
    if (await readOptional(file) !== before) throw new Error(`File changed during generation: ${file}`);
    await mkdir(path.dirname(file), { recursive: true });
    this.changes.set(file, { before, after });
    await writeFile(file, after, { encoding: 'utf8', flag: before === null ? 'wx' : 'w' });
  }
  async rollback(): Promise<void> {
    const conflicts: string[] = [];
    for (const [file, { before, after }] of [...this.changes].reverse()) {
      const current = await readOptional(file);
      if (current === before) continue;
      if (current !== after) { conflicts.push(file); continue; }
      if (before === null) await unlink(file);
      else await writeFile(file, before, 'utf8');
    }
    this.changes.clear();
    if (conflicts.length) throw new Error(`Rollback preserved files changed externally; review: ${conflicts.join(', ')}`);
  }
}

function spaceLocatorFields(source: SourceFile): string {
  const text = source.getFullText();
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const insertions: number[] = [];
  for (const declaration of source.getClasses()) {
    const members = declaration.getMembers();
    members.forEach((member, index) => {
      if (!index || !Node.isPropertyDeclaration(member) || !['Locator', 'FrameLocator'].includes(member.getTypeNode()?.getText() ?? '')) return;
      const start = member.getLeadingCommentRanges()[0]?.getPos() ?? member.getStart();
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      if (!/^[ \t]*$/.test(text.slice(lineStart, start)) || lineStart <= members[index - 1].getEnd()) return;
      const gap = text.slice(members[index - 1].getEnd(), lineStart);
      if (!/\n[ \t]*\r?\n$/.test(gap)) insertions.push(lineStart);
    });
  }
  return insertions.sort((a, b) => b - a).reduce((result, position) => result.slice(0, position) + newline + result.slice(position), text);
}

function mergeMembers(original: string, fragment: string, file: string): string {
  const project = new Project({ useInMemoryFileSystem: true, manipulationSettings: { indentationText: IndentationText.TwoSpaces } });
  const source = project.createSourceFile('/target.ts', original);
  const scratch = project.createSourceFile('/scratch.ts', `class Fragment {\n${fragment}\n}`);
  if (project.getProgram().compilerObject.getSyntacticDiagnostics(scratch.compilerNode).length || scratch.getStatements().length !== 1) {
    throw new Error(`Invalid class member fragment: ${file}`);
  }
  const target = source.getClasses()[0];
  const incoming = scratch.getClasses()[0];
  if (!target || !incoming) throw new Error(`Merge requires an existing class: ${file}`);
  const additions = new Set<string>();
  const existingNames = new Set(target.getMembers().filter(member =>
    Node.isPropertyDeclaration(member) || Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member),
  ).map(member => member.getName()));
  // Constructor parameter properties are class fields too.
  for (const parameter of target.getConstructors()[0]?.getParameters() ?? []) {
    if (parameter.isParameterProperty()) existingNames.add(parameter.getName());
  }
  for (const member of incoming.getMembers()) {
    if (Node.isConstructorDeclaration(member)) continue;
    if (!(Node.isPropertyDeclaration(member) || Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member))) {
      throw new Error(`Unsupported merge member in ${file}`);
    }
    const name = member.getName();
    if (existingNames.has(name)) continue;
    if (additions.has(name)) throw new Error(`Duplicate new member ${name} in ${file}`);
    additions.add(name);
    for (const added of target.addMembers([member.getFullText().trim()])) {
      added.formatText({ indentSize: 2, tabSize: 2 });
    }
  }
  const constructors = incoming.getConstructors();
  if (constructors.length > 1) throw new Error(`Only one supplemental constructor is supported: ${file}`);
  const supplemental = constructors[0];
  if (supplemental) {
    const constructor = target.getConstructors()[0];
    if (!constructor) throw new Error(`Cannot append locator initialization without an existing constructor: ${file}`);
    for (const parameter of supplemental.getParameters()) {
      const match = constructor.getParameters().find(p => p.getName() === parameter.getName());
      if (!match || match.getTypeNode()?.getText() !== parameter.getTypeNode()?.getText()) {
        throw new Error(`Supplemental constructor must reuse existing parameters: ${file}`);
      }
      // A legacy generated locator constructor accepted page without retaining it.
      // Promote the existing parameter so new this.page field initializers can use it.
      if (parameter.isParameterProperty() && !match.isParameterProperty()) {
        if (existingNames.has(parameter.getName())) throw new Error(`Cannot promote a constructor parameter that conflicts with an existing member: ${file}`);
        match.setScope(parameter.getScope());
        match.setIsReadonly(parameter.isReadonly());
      }
    }
    const assigned = new Set<string>();
    for (const statement of supplemental.getStatements()) {
      const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
      if (!expression || !Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        throw new Error(`Supplemental constructor may only initialize new properties: ${file}`);
      }
      const left = expression.getLeft();
      if (!Node.isPropertyAccessExpression(left) || left.getExpression().getKind() !== SyntaxKind.ThisKeyword) {
        throw new Error(`Expected this.property assignment: ${file}`);
      }
      const name = left.getName();
      if (additions.has(name) && !assigned.has(name)) { constructor.addStatements(statement.getText()); assigned.add(name); }
    }
  }
  if (!additions.size) return file.endsWith('.locators.ts') ? spaceLocatorFields(source) : original;
  // The fragment protocol has no import section. Add only well-known Playwright bindings.
  const used = new Set(scratch.getDescendantsOfKind(SyntaxKind.Identifier).map(node => node.getText()));
  const bound = new Set(source.getImportDeclarations().flatMap(declaration => [
    ...declaration.getNamedImports().map(item => item.getAliasNode()?.getText() ?? item.getName()),
    declaration.getDefaultImport()?.getText(), declaration.getNamespaceImport()?.getText(),
  ]));
  for (const name of ['Page', 'Locator', 'FrameLocator', 'expect']) {
    if (used.has(name) && !bound.has(name)) source.addImportDeclaration({ moduleSpecifier: '@playwright/test', namedImports: [name], isTypeOnly: name !== 'expect' });
  }
  return file.endsWith('.locators.ts') ? spaceLocatorFields(source) : source.getFullText();
}

function appendToTest(original: string, fragment: string, file: string): string {
  const marker = /\/\/ POM Agent continuation [a-f0-9]+/.exec(fragment)?.[0];
  if (!marker) throw new Error(`Invalid continuation fragment: ${file}`);
  if (original.includes(marker)) return original;
  const project = new Project({ useInMemoryFileSystem: true, manipulationSettings: { indentationText: IndentationText.TwoSpaces } });
  const source = project.createSourceFile('/target.spec.ts', original);
  const scratch = project.createSourceFile('/fragment.ts', fragment);
  const callback = source.getDescendantsOfKind(SyntaxKind.CallExpression).find(call => call.getExpression().getText() === 'test')?.getArguments()[1];
  if (!callback || !Node.isArrowFunction(callback) || !Node.isBlock(callback.getBody())) throw new Error(`Continuation target must contain one plain Playwright test: ${file}`);
  const targetBody = callback.getBody().asKindOrThrow(SyntaxKind.Block);
  const fragmentCallback = scratch.getStatements().find(Node.isExpressionStatement)?.getExpression();
  if (!fragmentCallback || !Node.isArrowFunction(fragmentCallback) || !Node.isBlock(fragmentCallback.getBody())) throw new Error(`Invalid continuation body: ${file}`);
  const fragmentBody = fragmentCallback.getBody().asKindOrThrow(SyntaxKind.Block);
  const bound = new Set(source.getImportDeclarations().flatMap(declaration => declaration.getNamedImports().map(item => item.getName())));
  for (const declaration of scratch.getImportDeclarations()) {
    const names = declaration.getNamedImports().filter(item => !bound.has(item.getName())).map(item => item.getName());
    if (names.length) source.addImportDeclaration({ moduleSpecifier: declaration.getModuleSpecifierValue(), namedImports: names });
  }
  targetBody.addStatements(fragmentBody.getStatements().map(statement => statement.getFullText()));
  return source.getFullText();
}

export async function writeGeneratedFiles(root: string, files: GeneratedFile[], transaction = new FileTransaction(), directories: OutputDirectories = defaultDirectories): Promise<string[]> {
  const allowed = Object.values(directories).map(dir => resolveInside(root, dir));
  const staged: { file: string; before: string | null; after: string }[] = [];
  const seen = new Set<string>();
  for (const generated of files) {
    const file = await safePath(root, generated.path);
    const key = file.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate output path: ${generated.path}`);
    seen.add(key);
    if (!allowed.some(dir => { const relative = path.relative(dir, file); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }) || !/\.(?:ts|json)$/.test(file)) {
      throw new Error(`Output must be a .ts/.json file under the configured output directories: ${generated.path}`);
    }
    const before = await readOptional(file);
    let after: string;
    if (generated.mode === 'create') {
      if (before !== null && before !== generated.content) throw new Error(`Refusing to overwrite existing file; use merge or a new path: ${generated.path}`);
      after = generated.content;
      if (file.endsWith('.json')) JSON.parse(after);
    } else if (generated.mode === 'append-test') {
      if (before === null || !file.endsWith('.spec.ts')) throw new Error(`Continuation requires an existing .spec.ts file: ${generated.path}`);
      after = appendToTest(before, generated.content, generated.path);
    } else {
      if (before === null || !file.endsWith('.ts')) throw new Error(`Merge requires an existing TypeScript file: ${generated.path}`);
      after = mergeMembers(before, generated.content, generated.path);
    }
    if (before !== after) staged.push({ file, before, after });
  }
  try { for (const item of staged) await transaction.apply(item.file, item.before, item.after); }
  catch (error) { await transaction.rollback(); throw error; }
  return staged.map(item => item.file);
}

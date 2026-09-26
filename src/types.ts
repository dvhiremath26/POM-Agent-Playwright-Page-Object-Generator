export interface ContextFile { relativePath: string; content: string }
export interface OutputDirectories { pagesDir: string; testsDir: string; testDataDir: string }
export interface RepoContext {
  /** Validated Copilot naming and logical-screen metadata; executable code comes from local rules. */
  namingPlan?: import('./testSteps').TestStepHints;
  existingPages: ContextFile[];
  conventions: string | null;
  testSteps?: string;
  supportingFiles?: ContextFile[];
  pageMap?: Record<string, string>;
  directories?: OutputDirectories;
  pageInventory?: string[];
  omittedContext?: number;
}
export interface GeneratedFile { path: string; mode: 'create' | 'merge'; content: string }
export interface GenerationResult { files: GeneratedFile[]; summary: string }
export const defaultDirectories: OutputDirectories = {
  pagesDir: 'pages', testsDir: 'tests', testDataDir: 'test-data',
};

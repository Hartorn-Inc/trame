export function hexToRgb(hex: string): [number, number, number];
export function relativeLuminance(rgb: [number, number, number]): number;
export function contrastRatio(hexA: string, hexB: string): number;
export function auditSourceContent(relPath: string, content: string): string[];
export function runAudit(repoRoot?: string): string[];
export const WOFF2_HEADER_BYTES: number;
export const WOFF2_MIN_FILE_BYTES: number;
export function validateWoff2Buffer(relPath: string, buf: Buffer): string[];

export const CANONICAL_SECTIONS: string[];
export const CANONICAL_SECTION_TITLES: string[];
export const CONTRAST_MATRIX: Array<{
  id: string;
  fg: string;
  bg: string;
  min: number;
}>;
export function walkFiles(dir: string, exts: string[]): string[];
export function parseYamlSubset(yamlText: string): Record<string, unknown>;
export function parseDesignMdFrontmatter(content: string): Record<string, unknown>;
export function extractCanonicalHeadings(content: string): string[];
export function validateCanonicalHeadings(headings: string[]): string[];
export function validateDesignJson(parsed: unknown): string[];

export function hexToRgb(hex: string): [number, number, number];
export function relativeLuminance(rgb: [number, number, number]): number;
export function contrastRatio(hexA: string, hexB: string): number;
export function auditSourceContent(relPath: string, content: string): string[];
export function runAudit(repoRoot?: string): string[];

export const CANONICAL_SECTIONS: string[];
export const CANONICAL_SECTION_TITLES: string[];
export function parseYamlSubset(yamlText: string): Record<string, unknown>;
export function parseDesignMdFrontmatter(content: string): Record<string, unknown>;
export function extractCanonicalHeadings(content: string): string[];
export function validateCanonicalHeadings(headings: string[]): string[];
export function validateDesignJson(parsed: unknown): string[];

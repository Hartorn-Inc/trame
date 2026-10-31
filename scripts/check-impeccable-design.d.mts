export function hexToRgb(hex: string): [number, number, number];
export function relativeLuminance(rgb: [number, number, number]): number;
export function contrastRatio(hexA: string, hexB: string): number;
export function auditSourceContent(relPath: string, content: string): string[];
export function runAudit(repoRoot?: string): string[];

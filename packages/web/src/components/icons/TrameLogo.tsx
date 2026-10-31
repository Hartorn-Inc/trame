/**
 * ============================================================================
 * TRAME CARTOGRAPHIC BRAND MARK (TrameLogo.tsx)
 * ============================================================================
 *
 * Implements the 3 sober cartographic `T` glyph variants specified in ATLAS v1.1:
 *   1. `route-intersection` (Default): Precision survey crossbar + plumb stem
 *      intersecting a waypoint node.
 *   2. `waypoint-grid`: Isometric survey frame enclosing a structural `T` meridian.
 *   3. `monolith-path`: Architectural split-lintel `T` with a central meridian axis.
 *
 * INVARIANTS:
 *   - Legible from `16x16px` favicon up to `256x256px` brand mark.
 *   - Clamps size to [16, 256] with default 24.
 *   - Zero decorative compass starbursts, d20 clichés, or raster gradients.
 *   - Supports `monochrome` (`currentColor`) and `duotone` (`var(--atlas-text)`
 *     + `var(--atlas-action)`).
 * ============================================================================
 */

import type { ComponentChildren } from "preact";

export type TrameLogoVariant = "route-intersection" | "waypoint-grid" | "monolith-path";
export type TrameLogoColorMode = "monochrome" | "duotone";

export interface TrameLogoProps {
  variant?: TrameLogoVariant;
  mode?: TrameLogoColorMode;
  duotone?: boolean;
  size?: number;
  title?: string;
  className?: string;
  class?: string;
  "data-testid"?: string;
  testId?: string;
}

export const TRAME_LOGO_VARIANTS: readonly TrameLogoVariant[] = [
  "route-intersection",
  "waypoint-grid",
  "monolith-path",
] as const;

function resolveIsDuotone(options: { duotone?: boolean; mode?: TrameLogoColorMode }): boolean {
  if (options.duotone !== undefined) {
    return options.duotone;
  }
  return options.mode !== "monochrome";
}

function clampLogoSize(size?: number): number {
  if (typeof size !== "number" || Number.isNaN(size)) {
    return 24;
  }
  return Math.min(256, Math.max(16, size));
}

/**
 * Pure SVG markup generator for static asset export and SSR/headless testing.
 */
export function renderTrameLogoSvg(options: TrameLogoProps = {}): string {
  const variant = options.variant ?? "route-intersection";
  const isDuotone = resolveIsDuotone(options);
  const size = clampLogoSize(options.size);
  const primaryStroke = isDuotone ? "var(--atlas-text)" : "currentColor";
  const accentStroke = isDuotone ? "var(--atlas-action)" : "currentColor";
  const titleAttr = options.title ? ` aria-label="${options.title}" role="img"` : ` aria-hidden="true"`;

  if (variant === "waypoint-grid") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr} data-testid="trame-logo-waypoint-grid"><rect x="3" y="3" width="18" height="18" rx="4" stroke="${primaryStroke}" stroke-width="1.75"/><path d="M7 8h10M12 8v10" stroke="${primaryStroke}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="8" r="2" fill="${accentStroke}"/></svg>`;
  }

  if (variant === "monolith-path") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr} data-testid="trame-logo-monolith-path"><path d="M4 6h16M4 10h6M14 10h6M12 6v14" stroke="${primaryStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="10.25" y="4.25" width="3.5" height="3.5" rx="1" fill="${accentStroke}"/></svg>`;
  }

  // Default: route-intersection
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr} data-testid="trame-logo-route-intersection"><path d="M4 6.5h16M12 6.5V20" stroke="${primaryStroke}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 13h3M14.5 13h3" stroke="${accentStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="12" cy="13" r="2.25" fill="${accentStroke}"/></svg>`;
}

export function TrameLogo(props: TrameLogoProps) {
  const variant = props.variant ?? "route-intersection";
  const isDuotone = resolveIsDuotone(props);
  const size = clampLogoSize(props.size);
  const primaryStroke = isDuotone ? "var(--atlas-text)" : "currentColor";
  const accentStroke = isDuotone ? "var(--atlas-action)" : "currentColor";

  let children: ComponentChildren[];
  if (variant === "waypoint-grid") {
    children = [
      <rect key="frame" x={3} y={3} width={18} height={18} rx={4} stroke={primaryStroke} strokeWidth={1.75} stroke-width={1.75} />,
      <path key="meridian" d="M7 8h10M12 8v10" stroke={primaryStroke} strokeWidth={2} stroke-width={2} strokeLinecap="round" stroke-linecap="round" />,
      <circle key="node" cx={12} cy={8} r={2} fill={accentStroke} />,
    ];
  } else if (variant === "monolith-path") {
    children = [
      <path
        key="lintel"
        d="M4 6h16M4 10h6M14 10h6M12 6v14"
        stroke={primaryStroke}
        strokeWidth={2}
        stroke-width={2}
        strokeLinecap="round"
        stroke-linecap="round"
        strokeLinejoin="round"
        stroke-linejoin="round"
      />,
      <rect key="marker" x={10.25} y={4.25} width={3.5} height={3.5} rx={1} fill={accentStroke} />,
    ];
  } else {
    // Default: route-intersection
    children = [
      <path
        key="crossbar"
        d="M4 6.5h16M12 6.5V20"
        stroke={primaryStroke}
        strokeWidth={2.25}
        stroke-width={2.25}
        strokeLinecap="round"
        stroke-linecap="round"
        strokeLinejoin="round"
        stroke-linejoin="round"
      />,
      <path
        key="waypoint-arms"
        d="M6.5 13h3M14.5 13h3"
        stroke={accentStroke}
        strokeWidth={1.75}
        stroke-width={1.75}
        strokeLinecap="round"
        stroke-linecap="round"
      />,
      <circle key="waypoint-node" cx={12} cy={13} r={2.25} fill={accentStroke} />,
    ];
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      class={props.className ?? props.class}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : "true"}
      role={props.title ? "img" : undefined}
      data-testid={props["data-testid"] ?? props.testId ?? `trame-logo-${variant}`}
    >
      {children}
    </svg>
  );
}

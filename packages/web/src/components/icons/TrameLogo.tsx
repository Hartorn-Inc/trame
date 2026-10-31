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
 *   - Zero decorative compass starbursts, d20 clichés, or raster gradients.
 *   - Supports `monochrome` (`currentColor`) and `duotone` (`var(--atlas-text)`
 *     + `var(--atlas-action)`).
 * ============================================================================
 */

export type TrameLogoVariant = "route-intersection" | "waypoint-grid" | "monolith-path";
export type TrameLogoColorMode = "monochrome" | "duotone";

export interface TrameLogoProps {
  variant?: TrameLogoVariant;
  mode?: TrameLogoColorMode;
  size?: number;
  title?: string;
  className?: string;
}

export const TRAME_LOGO_VARIANTS: readonly TrameLogoVariant[] = [
  "route-intersection",
  "waypoint-grid",
  "monolith-path",
] as const;

/**
 * Pure SVG markup generator for static asset export and SSR/headless testing.
 */
export function renderTrameLogoSvg(options: TrameLogoProps = {}): string {
  const variant = options.variant ?? "route-intersection";
  const mode = options.mode ?? "duotone";
  const size = options.size ?? 24;
  const primaryStroke = mode === "monochrome" ? "currentColor" : "var(--atlas-text)";
  const accentStroke = mode === "monochrome" ? "currentColor" : "var(--atlas-action)";
  const titleAttr = options.title ? ` aria-label="${options.title}" role="img"` : ` aria-hidden="true"`;

  if (variant === "waypoint-grid") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr}><rect x="3" y="3" width="18" height="18" rx="4" stroke="${primaryStroke}" stroke-width="1.75"/><path d="M7 8h10M12 8v10" stroke="${primaryStroke}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="8" r="2" fill="${accentStroke}"/></svg>`;
  }

  if (variant === "monolith-path") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr}><path d="M4 6h16M4 10h6M14 10h6M12 6v14" stroke="${primaryStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="10.25" y="4.25" width="3.5" height="3.5" rx="1" fill="${accentStroke}"/></svg>`;
  }

  // Default: route-intersection
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${titleAttr}><path d="M4 6.5h16M12 6.5V20" stroke="${primaryStroke}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 13h3M14.5 13h3" stroke="${accentStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="12" cy="13" r="2.25" fill="${accentStroke}"/></svg>`;
}

export function TrameLogo(props: TrameLogoProps) {
  const variant = props.variant ?? "route-intersection";
  const mode = props.mode ?? "duotone";
  const size = props.size ?? 24;
  const primaryStroke = mode === "monochrome" ? "currentColor" : "var(--atlas-text)";
  const accentStroke = mode === "monochrome" ? "currentColor" : "var(--atlas-action)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      class={props.className}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : "true"}
      role={props.title ? ("img" as unknown as undefined) : undefined}
      data-testid={`trame-logo-${variant}`}
    >
      {variant === "waypoint-grid" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="4" stroke={primaryStroke} stroke-width="1.75" />
          <path d="M7 8h10M12 8v10" stroke={primaryStroke} stroke-width="2" stroke-linecap="round" />
          <circle cx="12" cy="8" r="2" fill={accentStroke} />
        </>
      ) : variant === "monolith-path" ? (
        <>
          <path
            d="M4 6h16M4 10h6M14 10h6M12 6v14"
            stroke={primaryStroke}
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect x="10.25" y="4.25" width="3.5" height="3.5" rx="1" fill={accentStroke} />
        </>
      ) : (
        <>
          <path
            d="M4 6.5h16M12 6.5V20"
            stroke={primaryStroke}
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M6.5 13h3M14.5 13h3"
            stroke={accentStroke}
            stroke-width="1.75"
            stroke-linecap="round"
          />
          <circle cx="12" cy="13" r="2.25" fill={accentStroke} />
        </>
      )}
    </svg>
  );
}

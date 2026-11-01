/**
 * ============================================================================
 * TRAME CARTOGRAPHIC EMPTY STATES (AtlasEmptyStates.tsx)
 * ============================================================================
 *
 * 4 lightweight inline SVG empty-state illustrations using topographic
 * contours, grid hairlines, and survey waypoint markers:
 *   - `EmptyCampaignsSvg` (`CampaignLobby` empty state)
 *   - `EmptyMapAtlasSvg` (`CampaignWorkspace` unconfigured map state)
 *   - `EmptyJournalSvg` (`PartyJournal` / `NotesMarkdownPane` empty state)
 *   - `EmptyActorsSvg` (`Actors` roster empty state)
 *
 * INVARIANTS (DESIGN.md):
 *   1. ZERO `<text>` elements baked inside SVG (ensuring clean i18n in `en`/`fr`).
 *   2. Theme-adaptive via CSS custom properties (`var(--atlas-border)`,
 *      `var(--atlas-text-muted)`, `var(--atlas-action)`).
 *   3. Accessible status container pattern: container wrapper provides
 *      `role="status"` with external localized heading and body elements.
 * ============================================================================
 */

import type { ComponentChildren } from "preact";

export type EmptyStateKind = "campaigns" | "map-atlas" | "journal" | "actors";

export const EMPTY_STATE_KINDS: readonly EmptyStateKind[] = [
  "campaigns",
  "map-atlas",
  "journal",
  "actors",
] as const;

export interface EmptyStateSvgProps {
  width?: number;
  height?: number;
  class?: string;
  className?: string;
  testId?: string;
  "data-testid"?: string;
}

export interface AtlasEmptyStateProps {
  kind: EmptyStateKind;
  heading: ComponentChildren;
  body?: ComponentChildren;
  action?: ComponentChildren;
  width?: number;
  height?: number;
  illustrationWidth?: number;
  illustrationHeight?: number;
  class?: string;
  className?: string;
  testId?: string;
  "data-testid"?: string;
}

export function renderEmptyStateSvg(kind: EmptyStateKind, width = 160, height = 100): string {
  const borderStroke = "var(--atlas-border)";
  const mutedStroke = "var(--atlas-text-muted)";
  const actionStroke = "var(--atlas-action)";

  if (kind === "map-atlas") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="map-atlas"><rect x="12" y="12" width="136" height="76" rx="6" stroke="${borderStroke}" stroke-width="1.5"/><path d="M12 37h136M12 63h136M56 12v76M104 12v76" stroke="${borderStroke}" stroke-width="1" stroke-dasharray="3 3"/><path d="M32 68c16-24 38-28 56-12s28 12 40-16" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="88" cy="56" r="4" fill="${actionStroke}"/></svg>`;
  }

  if (kind === "journal") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="journal"><rect x="36" y="14" width="88" height="72" rx="6" stroke="${borderStroke}" stroke-width="1.5"/><path d="M52 34h56M52 48h44M52 62h32" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="104" cy="62" r="4" fill="${actionStroke}"/></svg>`;
  }

  if (kind === "actors") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="actors"><circle cx="56" cy="50" r="20" stroke="${borderStroke}" stroke-width="1.5" stroke-dasharray="4 4"/><circle cx="104" cy="50" r="20" stroke="${mutedStroke}" stroke-width="1.75"/><circle cx="104" cy="44" r="6" stroke="${mutedStroke}" stroke-width="1.75"/><path d="M92 62c3-5 21-5 24 0" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="120" cy="34" r="3.5" fill="${actionStroke}"/></svg>`;
  }

  // Default: campaigns
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="campaigns"><rect x="16" y="16" width="128" height="68" rx="8" stroke="${borderStroke}" stroke-width="1.5"/><path d="M34 64L66 36l28 20 32-24" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="66" cy="36" r="3.5" fill="${mutedStroke}"/><circle cx="94" cy="56" r="3.5" fill="${mutedStroke}"/><circle cx="126" cy="32" r="4.5" fill="${actionStroke}"/></svg>`;
}

export function renderEmptyStateHtml(options: {
  kind: EmptyStateKind;
  heading: string;
  body?: string;
  illustrationWidth?: number;
  illustrationHeight?: number;
}): string {
  const svg = renderEmptyStateSvg(
    options.kind,
    options.illustrationWidth ?? 160,
    options.illustrationHeight ?? 100,
  );
  const bodyHtml = options.body ? `<p class="ds-empty-state-body">${options.body}</p>` : "";
  return `<div role="status" aria-live="polite" class="ds-empty-state" data-empty-state="${options.kind}"><div class="ds-empty-state-illustration" aria-hidden="true">${svg}</div><div class="ds-empty-state-content"><h3 class="ds-empty-state-heading">${options.heading}</h3>${bodyHtml}</div></div>`;
}

export function EmptyCampaignsSvg(props: EmptyStateSvgProps) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className}
      data-testid={props.testId ?? "empty-state-campaigns"}
    >
      <rect
        x="16"
        y="16"
        width="128"
        height="68"
        rx="8"
        stroke="var(--atlas-border)"
        strokeWidth={1.5}
        stroke-width="1.5"
      />
      <path
        d="M34 64L66 36l28 20 32-24"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
        strokeLinecap="round"
        stroke-linecap="round"
        strokeLinejoin="round"
        stroke-linejoin="round"
      />
      <circle cx="66" cy="36" r="3.5" fill="var(--atlas-text-muted)" />
      <circle cx="94" cy="56" r="3.5" fill="var(--atlas-text-muted)" />
      <circle cx="126" cy="32" r="4.5" fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyMapAtlasSvg(props: EmptyStateSvgProps) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className}
      data-testid={props.testId ?? "empty-state-map-atlas"}
    >
      <rect
        x="12"
        y="12"
        width="136"
        height="76"
        rx="6"
        stroke="var(--atlas-border)"
        strokeWidth={1.5}
        stroke-width="1.5"
      />
      <path
        d="M12 37h136M12 63h136M56 12v76M104 12v76"
        stroke="var(--atlas-border)"
        strokeWidth={1}
        stroke-width="1"
        strokeDasharray="3 3"
        stroke-dasharray="3 3"
      />
      <path
        d="M32 68c16-24 38-28 56-12s28 12 40-16"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
        strokeLinecap="round"
        stroke-linecap="round"
      />
      <circle cx="88" cy="56" r="4" fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyJournalSvg(props: EmptyStateSvgProps) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className}
      data-testid={props.testId ?? "empty-state-journal"}
    >
      <rect
        x="36"
        y="14"
        width="88"
        height="72"
        rx="6"
        stroke="var(--atlas-border)"
        strokeWidth={1.5}
        stroke-width="1.5"
      />
      <path
        d="M52 34h56M52 48h44M52 62h32"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
        strokeLinecap="round"
        stroke-linecap="round"
      />
      <circle cx="104" cy="62" r="4" fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyActorsSvg(props: EmptyStateSvgProps) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className}
      data-testid={props.testId ?? "empty-state-actors"}
    >
      <circle
        cx="56"
        cy="50"
        r="20"
        stroke="var(--atlas-border)"
        strokeWidth={1.5}
        stroke-width="1.5"
        strokeDasharray="4 4"
        stroke-dasharray="4 4"
      />
      <circle
        cx="104"
        cy="50"
        r="20"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
      />
      <circle
        cx="104"
        cy="44"
        r="6"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
      />
      <path
        d="M92 62c3-5 21-5 24 0"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width="1.75"
        strokeLinecap="round"
        stroke-linecap="round"
      />
      <circle cx="120" cy="34" r="3.5" fill="var(--atlas-action)" />
    </svg>
  );
}

export function AtlasEmptyState(props: AtlasEmptyStateProps) {
  const { kind, heading, body, action, className, testId } = props;
  const width = props.illustrationWidth ?? props.width ?? 160;
  const height = props.illustrationHeight ?? props.height ?? 100;
  const cssClass = props.class ?? className ?? "";
  const resolvedTestId = props["data-testid"] ?? testId ?? `empty-state-${kind}`;

  return (
    <div
      role="status"
      aria-live="polite"
      class={`ds-empty-state ${cssClass}`.trim()}
      data-testid={resolvedTestId}
      data-empty-state={kind}
    >
      <div class="ds-empty-state-illustration" aria-hidden="true">
        {kind === "map-atlas" ? (
          <EmptyMapAtlasSvg width={width} height={height} />
        ) : kind === "journal" ? (
          <EmptyJournalSvg width={width} height={height} />
        ) : kind === "actors" ? (
          <EmptyActorsSvg width={width} height={height} />
        ) : (
          <EmptyCampaignsSvg width={width} height={height} />
        )}
      </div>
      <div class="ds-empty-state-content">
        <h3 class="ds-empty-state-heading">{heading}</h3>
        {body && <p class="ds-empty-state-body">{body}</p>}
        {action && <div class="ds-empty-state-actions">{action}</div>}
      </div>
    </div>
  );
}

export const AtlasEmptyStateContainer = AtlasEmptyState;
export const EmptyStateContainer = AtlasEmptyState;

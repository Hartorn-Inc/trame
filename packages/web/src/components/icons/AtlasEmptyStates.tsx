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
 *   1. ZERO textual SVG tags inside illustrations (guaranteeing i18n independence).
 *   2. Theme-adaptive via CSS custom properties (`var(--atlas-border)`,
 *      `var(--atlas-text-muted)`, `var(--atlas-action)`).
 *   3. Accessible `role="status"` container with external heading/body elements.
 * ============================================================================
 */

import type { ComponentChildren } from "preact";

export type EmptyStateKind = "campaigns" | "map-atlas" | "journal" | "actors";

export interface EmptyStateSvgProps {
  width?: number;
  height?: number;
  className?: string;
  class?: string;
  "data-testid"?: string;
  testId?: string;
}

export function renderEmptyStateSvg(kind: EmptyStateKind, width = 160, height = 100): string {
  const borderStroke = "var(--atlas-border)";
  const mutedStroke = "var(--atlas-text-muted)";
  const actionStroke = "var(--atlas-action)";

  if (kind === "map-atlas") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="map-atlas" data-testid="empty-state-map-atlas"><rect x="12" y="12" width="136" height="76" rx="6" stroke="${borderStroke}" stroke-width="1.5"/><path d="M12 37h136M12 63h136M56 12v76M104 12v76" stroke="${borderStroke}" stroke-width="1" stroke-dasharray="3 3"/><path d="M32 68c16-24 38-28 56-12s28 12 40-16" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="88" cy="56" r="4" fill="${actionStroke}"/></svg>`;
  }

  if (kind === "journal") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="journal" data-testid="empty-state-journal"><rect x="36" y="14" width="88" height="72" rx="6" stroke="${borderStroke}" stroke-width="1.5"/><path d="M52 34h56M52 48h44M52 62h32" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="104" cy="62" r="4" fill="${actionStroke}"/></svg>`;
  }

  if (kind === "actors") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="actors" data-testid="empty-state-actors"><circle cx="56" cy="50" r="20" stroke="${borderStroke}" stroke-width="1.5" stroke-dasharray="4 4"/><circle cx="104" cy="50" r="20" stroke="${mutedStroke}" stroke-width="1.75"/><circle cx="104" cy="44" r="6" stroke="${mutedStroke}" stroke-width="1.75"/><path d="M92 62c3-5 21-5 24 0" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round"/><circle cx="120" cy="34" r="3.5" fill="${actionStroke}"/></svg>`;
  }

  // Default: campaigns
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 100" fill="none" aria-hidden="true" data-empty-state="campaigns" data-testid="empty-state-campaigns"><rect x="16" y="16" width="128" height="68" rx="8" stroke="${borderStroke}" stroke-width="1.5"/><path d="M34 64L66 36l28 20 32-24" stroke="${mutedStroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="66" cy="36" r="3.5" fill="${mutedStroke}"/><circle cx="94" cy="56" r="3.5" fill="${mutedStroke}"/><circle cx="126" cy="32" r="4.5" fill="${actionStroke}"/></svg>`;
}

export function EmptyCampaignsSvg(props: EmptyStateSvgProps = {}) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className ?? props.class}
      data-testid={props["data-testid"] ?? props.testId ?? "empty-state-campaigns"}
    >
      <rect x="16" y="16" width="128" height="68" rx="8" stroke="var(--atlas-border)" strokeWidth={1.5} stroke-width={1.5} />
      <path
        d="M34 64L66 36l28 20 32-24"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width={1.75}
        strokeLinecap="round"
        stroke-linecap="round"
        strokeLinejoin="round"
        stroke-linejoin="round"
      />
      <circle cx="66" cy="36" r={3.5} fill="var(--atlas-text-muted)" />
      <circle cx="94" cy="56" r={3.5} fill="var(--atlas-text-muted)" />
      <circle cx="126" cy="32" r={4.5} fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyMapAtlasSvg(props: EmptyStateSvgProps = {}) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className ?? props.class}
      data-testid={props["data-testid"] ?? props.testId ?? "empty-state-map-atlas"}
    >
      <rect x="12" y="12" width="136" height="76" rx="6" stroke="var(--atlas-border)" strokeWidth={1.5} stroke-width={1.5} />
      <path
        d="M12 37h136M12 63h136M56 12v76M104 12v76"
        stroke="var(--atlas-border)"
        strokeWidth={1}
        stroke-width={1}
        strokeDasharray="3 3"
        stroke-dasharray="3 3"
      />
      <path
        d="M32 68c16-24 38-28 56-12s28 12 40-16"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width={1.75}
        strokeLinecap="round"
        stroke-linecap="round"
      />
      <circle cx="88" cy="56" r={4} fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyJournalSvg(props: EmptyStateSvgProps = {}) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className ?? props.class}
      data-testid={props["data-testid"] ?? props.testId ?? "empty-state-journal"}
    >
      <rect x="36" y="14" width="88" height="72" rx="6" stroke="var(--atlas-border)" strokeWidth={1.5} stroke-width={1.5} />
      <path
        d="M52 34h56M52 48h44M52 62h32"
        stroke="var(--atlas-text-muted)"
        strokeWidth={1.75}
        stroke-width={1.75}
        strokeLinecap="round"
        stroke-linecap="round"
      />
      <circle cx="104" cy="62" r={4} fill="var(--atlas-action)" />
    </svg>
  );
}

export function EmptyActorsSvg(props: EmptyStateSvgProps = {}) {
  const width = props.width ?? 160;
  const height = props.height ?? 100;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 100"
      fill="none"
      aria-hidden="true"
      class={props.className ?? props.class}
      data-testid={props["data-testid"] ?? props.testId ?? "empty-state-actors"}
    >
      <circle cx="56" cy="50" r={20} stroke="var(--atlas-border)" strokeWidth={1.5} stroke-width={1.5} strokeDasharray="4 4" stroke-dasharray="4 4" />
      <circle cx="104" cy="50" r={20} stroke="var(--atlas-text-muted)" strokeWidth={1.75} stroke-width={1.75} />
      <circle cx="104" cy="44" r={6} stroke="var(--atlas-text-muted)" strokeWidth={1.75} stroke-width={1.75} />
      <path d="M92 62c3-5 21-5 24 0" stroke="var(--atlas-text-muted)" strokeWidth={1.75} stroke-width={1.75} strokeLinecap="round" stroke-linecap="round" />
      <circle cx="120" cy="34" r={3.5} fill="var(--atlas-action)" />
    </svg>
  );
}

export const AtlasEmptyStates = {
  EmptyCampaignsSvg,
  EmptyMapAtlasSvg,
  EmptyJournalSvg,
  EmptyActorsSvg,
};

export interface EmptyStateContainerProps {
  kind?: EmptyStateKind;
  illustration?: ComponentChildren;
  title: string;
  description?: string;
  action?: ComponentChildren;
  className?: string;
  class?: string;
  "data-testid"?: string;
  testId?: string;
}

export function AtlasEmptyStateContainer(props: EmptyStateContainerProps) {
  let illustration = props.illustration;
  if (!illustration && props.kind) {
    switch (props.kind) {
      case "campaigns":
        illustration = <EmptyCampaignsSvg />;
        break;
      case "map-atlas":
        illustration = <EmptyMapAtlasSvg />;
        break;
      case "journal":
        illustration = <EmptyJournalSvg />;
        break;
      case "actors":
        illustration = <EmptyActorsSvg />;
        break;
    }
  }

  const cssClass = ["ds-empty-state", props.className ?? props.class].filter(Boolean).join(" ");
  const testId = props["data-testid"] ?? props.testId ?? (props.kind ? `empty-state-${props.kind}-container` : "empty-state-container");

  return (
    <div
      role="status"
      aria-live="polite"
      class={cssClass}
      data-testid={testId}
    >
      {illustration && (
        <div class="ds-empty-state-illustration" aria-hidden="true">
          {illustration}
        </div>
      )}
      <h3 class="ds-empty-state-heading" data-testid="empty-state-heading">
        {props.title}
      </h3>
      {props.description && (
        <p class="ds-empty-state-body" data-testid="empty-state-body">
          {props.description}
        </p>
      )}
      {props.action && (
        <div class="ds-empty-state-action" data-testid="empty-state-action">
          {props.action}
        </div>
      )}
    </div>
  );
}

export const EmptyStateContainer = AtlasEmptyStateContainer;
export const AtlasEmptyState = AtlasEmptyStateContainer;

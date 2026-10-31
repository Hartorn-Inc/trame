/**
 * ============================================================================
 * TRAME ATLAS v1.1 STROKED ICON LIBRARY (AtlasIcons.tsx)
 * ============================================================================
 *
 * Canonical 20px / 24px SVG icon set using uniform 1.75px stroke width,
 * rounded caps/joins, stroke="currentColor", and aria-hidden="true".
 *
 * Covers the 34 standardized ATLAS v1.1 icons:
 *   1. Tabletop Tool Rail (SelectToolIcon, PanToolIcon, RulerToolIcon,
 *      GridToolIcon, FogBrushToolIcon, WallToolIcon, DoorToolIcon, LightToolIcon,
 *      AmbientToolIcon, AudioToolIcon, PingToolIcon, AoEToolIcon)
 *   2. Character Sheet, Padlock & Non-Color Disposition Badges
 *      (PadlockLockedIcon, PadlockUnlockedIcon, LevelUpArrowIcon,
 *      ShortRestCampfireIcon, LongRestTentIcon, DiceD20NeutralIcon,
 *      AllyBadgeIcon, HostileBadgeIcon, ActiveTurnChevronIcon)
 *   3. Theme Modes (ThemeDarkIcon, ThemeLightIcon, ThemeSystemIcon)
 *   4. Workspace Shell & Navigation (WorkspaceMapIcon, WorkspaceActorsIcon,
 *      WorkspaceJournalIcon, WorkspaceCompendiumIcon, WorkspaceSettingsIcon)
 *   5. Operational History & UI Controls (UndoIcon, RedoIcon, ChevronDownIcon,
 *      ChevronRightIcon, CloseIcon)
 *
 * INVARIANTS:
 *   - viewBox: "0 0 24 24"
 *   - strokeWidth: 1.75 (stroke-linecap="round", stroke-linejoin="round")
 *   - fill: "none"
 *   - stroke: "currentColor"
 *   - aria-hidden="true" by default
 * ============================================================================
 */

export const ATLAS_ICON_STROKE_WIDTH = 1.75;

export const ATLAS_ICON_NAMES = [
  "SelectToolIcon",
  "PanToolIcon",
  "RulerToolIcon",
  "GridToolIcon",
  "FogBrushToolIcon",
  "WallToolIcon",
  "DoorToolIcon",
  "LightToolIcon",
  "AmbientToolIcon",
  "AudioToolIcon",
  "PingToolIcon",
  "AoEToolIcon",
  "PadlockLockedIcon",
  "PadlockUnlockedIcon",
  "LevelUpArrowIcon",
  "ShortRestCampfireIcon",
  "LongRestTentIcon",
  "DiceD20NeutralIcon",
  "AllyBadgeIcon",
  "HostileBadgeIcon",
  "ActiveTurnChevronIcon",
  "ThemeDarkIcon",
  "ThemeLightIcon",
  "ThemeSystemIcon",
  "WorkspaceMapIcon",
  "WorkspaceActorsIcon",
  "WorkspaceJournalIcon",
  "WorkspaceCompendiumIcon",
  "WorkspaceSettingsIcon",
  "UndoIcon",
  "RedoIcon",
  "ChevronDownIcon",
  "ChevronRightIcon",
  "CloseIcon",
] as const;

export type CanonicalAtlasIconName = (typeof ATLAS_ICON_NAMES)[number];

export type AtlasIconAlias =
  | "MapIcon"
  | "ActorsIcon"
  | "JournalIcon"
  | "CompendiumIcon"
  | "SettingsIcon"
  | "MeasureRulerIcon"
  | "GridToggleIcon"
  | "FogBrushIcon"
  | "DoorStateIcon"
  | "LightSourceIcon"
  | "AmbientSunIcon"
  | "AmbientMoonIcon"
  | "AudioWaveIcon"
  | "PingBeaconIcon"
  | "AoETemplateIcon"
  | "LocaleIcon";

export type AtlasIconName = CanonicalAtlasIconName | AtlasIconAlias;

export interface AtlasIconProps {
  readonly name?: AtlasIconName;
  readonly size?: 20 | 24 | number;
  readonly color?: string;
  readonly className?: string;
  readonly class?: string;
  readonly "aria-hidden"?: boolean | "true" | "false";
  readonly "data-testid"?: string;
  readonly testId?: string;
}

export const ATLAS_ICON_PATHS: Record<string, readonly string[]> = {
  // 1. Tabletop Tool Rail
  SelectToolIcon: ["M4 4l7.07 17 2.51-7.39L21 11.07 4 4z", "M13.5 13.5L19 19"],
  PanToolIcon: [
    "M12 2v20",
    "M2 12h20",
    "M12 2l-3 3M12 2l3 3",
    "M12 22l-3-3M12 22l3-3",
    "M2 12l3-3M2 12l3 3",
    "M22 12l-3-3M22 12l-3 3",
  ],
  RulerToolIcon: [
    "M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0l12.6 12.6z",
    "M14.5 12.5l2-2",
    "M11.5 9.5l2-2",
    "M8.5 6.5l2-2",
    "M17.5 15.5l2-2",
  ],
  GridToolIcon: ["M3 3h18v18H3z", "M3 9h18", "M3 15h18", "M9 3v18", "M15 3v18"],
  FogBrushToolIcon: ["M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "M8 19h8", "M10 22h4"],
  WallToolIcon: ["M3 6h18v12H3z", "M3 12h18", "M9 6v6", "M15 6v6", "M6 12v6", "M12 12v6", "M18 12v6"],
  DoorToolIcon: ["M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16", "M3 21h18", "M15 12h.01"],
  LightToolIcon: [
    "M9 18h6",
    "M10 22h4",
    "M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14",
  ],
  AmbientToolIcon: [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M12 2v2",
    "M12 20v2",
    "M4.93 4.93l1.41 1.41",
    "M17.66 17.66l1.41 1.41",
    "M2 12h2",
    "M20 12h2",
  ],
  AudioToolIcon: ["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"],
  PingToolIcon: [
    "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M16.24 7.76a6 6 0 0 1 0 8.49",
    "M7.76 16.24a6 6 0 0 1 0-8.49",
    "M19.07 4.93a10 10 0 0 1 0 14.14",
    "M4.93 19.07a10 10 0 0 1 0-14.14",
  ],
  AoEToolIcon: ["M12 3l9 16H3L12 3z", "M12 9v5", "M12 17h.01"],

  // 2. Character Sheet, Padlock & Non-Color Disposition Badges
  PadlockLockedIcon: [
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M7 11V7a5 5 0 0 1 10 0v4",
    "M12 16v2",
  ],
  PadlockUnlockedIcon: [
    "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M7 11V7a5 5 0 0 1 9.9-1",
    "M12 16v2",
  ],
  LevelUpArrowIcon: ["M12 19V5", "M5 12l7-7 7 7", "M5 19h14"],
  ShortRestCampfireIcon: ["M12 3c2.5 3 4 5.5 4 8a4 4 0 1 1-8 0c0-2.5 1.5-5 4-8z", "M4 20l16-4", "M4 16l16 4"],
  LongRestTentIcon: ["M3 20h18L12 4 3 20z", "M12 4v16", "M9 20l3-6 3 6"],
  DiceD20NeutralIcon: ["M12 2l9 5v10l-9 5-9-5V7l9-5z", "M12 2v20", "M3 7l9 5 9-5", "M3 17l9-5 9 5"],
  AllyBadgeIcon: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M9 12l2 2 4-4"],
  HostileBadgeIcon: ["M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z", "M12 8v5", "M12 16h.01"],
  ActiveTurnChevronIcon: ["M9 6l6 6-6 6", "M5 6l6 6-6 6"],

  // 3. Theme Modes
  ThemeDarkIcon: ["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"],
  ThemeLightIcon: [
    "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
    "M12 1v2",
    "M12 21v2",
    "M4.22 4.22l1.42 1.42",
    "M18.36 18.36l1.42 1.42",
    "M1 12h2",
    "M21 12h2",
    "M4.22 19.78l1.42-1.42",
    "M18.36 5.64l1.42-1.42",
  ],
  ThemeSystemIcon: [
    "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M8 21h8",
    "M12 17v4",
  ],

  // 4. Workspace Shell & Navigation
  WorkspaceMapIcon: ["M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z", "M9 3v15", "M15 6v15"],
  WorkspaceActorsIcon: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  WorkspaceJournalIcon: [
    "M4 19.5A2.5 2.5 0 0 1 6.5 17H20",
    "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
    "M8 7h8",
    "M8 11h6",
  ],
  WorkspaceCompendiumIcon: [
    "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  ],
  WorkspaceSettingsIcon: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],

  // 5. Operational History & UI Controls
  UndoIcon: ["M3 7v6h6", "M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"],
  RedoIcon: ["M21 7v6h-6", "M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"],
  ChevronDownIcon: ["M6 9l6 6 6-6"],
  ChevronRightIcon: ["M9 18l6-6-6-6"],
  CloseIcon: ["M18 6L6 18", "M6 6l12 12"],

  // Backward-compatibility Aliases
  MapIcon: ["M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z", "M9 3v15", "M15 6v15"],
  ActorsIcon: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  JournalIcon: [
    "M4 19.5A2.5 2.5 0 0 1 6.5 17H20",
    "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
    "M8 7h8",
    "M8 11h6",
  ],
  CompendiumIcon: [
    "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  ],
  SettingsIcon: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],
  MeasureRulerIcon: [
    "M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0l12.6 12.6z",
    "M14.5 12.5l2-2",
    "M11.5 9.5l2-2",
    "M8.5 6.5l2-2",
    "M17.5 15.5l2-2",
  ],
  GridToggleIcon: ["M3 3h18v18H3z", "M3 9h18", "M3 15h18", "M9 3v18", "M15 3v18"],
  FogBrushIcon: ["M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "M8 19h8", "M10 22h4"],
  DoorStateIcon: ["M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16", "M3 21h18", "M15 12h.01"],
  LightSourceIcon: [
    "M9 18h6",
    "M10 22h4",
    "M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14",
  ],
  AmbientSunIcon: [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M12 2v2",
    "M12 20v2",
    "M4.93 4.93l1.41 1.41",
    "M17.66 17.66l1.41 1.41",
    "M2 12h2",
    "M20 12h2",
  ],
  AmbientMoonIcon: ["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"],
  AudioWaveIcon: ["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"],
  PingBeaconIcon: [
    "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M16.24 7.76a6 6 0 0 1 0 8.49",
    "M7.76 16.24a6 6 0 0 1 0-8.49",
    "M19.07 4.93a10 10 0 0 1 0 14.14",
    "M4.93 19.07a10 10 0 0 1 0-14.14",
  ],
  AoETemplateIcon: ["M12 3l9 16H3L12 3z", "M12 9v5", "M12 17h.01"],
  LocaleIcon: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  ],
};

export function renderAtlasIconSvg(name: AtlasIconName, size: number = 20): string {
  const paths = ATLAS_ICON_PATHS[name] ?? ATLAS_ICON_PATHS.SelectToolIcon;
  const pathNodes = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${ATLAS_ICON_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-icon="${name}">${pathNodes}</svg>`;
}

export function AtlasIcon(props: AtlasIconProps) {
  const name = props.name ?? "SelectToolIcon";
  const size = props.size ?? 20;
  const paths = ATLAS_ICON_PATHS[name] ?? ATLAS_ICON_PATHS.SelectToolIcon;
  const strokeColor = props.color ?? "currentColor";
  const ariaHidden = props["aria-hidden"] !== undefined ? String(props["aria-hidden"]) : "true";
  const cssClass = props.className ?? props.class;
  const testId = props["data-testid"] ?? props.testId ?? `atlas-icon-${name}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={strokeColor}
      strokeWidth={ATLAS_ICON_STROKE_WIDTH}
      stroke-width={ATLAS_ICON_STROKE_WIDTH}
      strokeLinecap="round"
      stroke-linecap="round"
      strokeLinejoin="round"
      stroke-linejoin="round"
      aria-hidden={ariaHidden}
      class={cssClass}
      data-testid={testId}
      data-icon={name}
    >
      {paths.map((d, idx) => (
        <path key={idx} d={d} />
      ))}
    </svg>
  );
}

function createIconComponent(name: AtlasIconName) {
  return function AtlasSvgIcon(props: AtlasIconProps = {}) {
    return <AtlasIcon {...props} name={name} />;
  };
}

// 1. Tabletop Tool Rail
export const SelectToolIcon = createIconComponent("SelectToolIcon");
export const PanToolIcon = createIconComponent("PanToolIcon");
export const RulerToolIcon = createIconComponent("RulerToolIcon");
export const GridToolIcon = createIconComponent("GridToolIcon");
export const FogBrushToolIcon = createIconComponent("FogBrushToolIcon");
export const WallToolIcon = createIconComponent("WallToolIcon");
export const DoorToolIcon = createIconComponent("DoorToolIcon");
export const LightToolIcon = createIconComponent("LightToolIcon");
export const AmbientToolIcon = createIconComponent("AmbientToolIcon");
export const AudioToolIcon = createIconComponent("AudioToolIcon");
export const PingToolIcon = createIconComponent("PingToolIcon");
export const AoEToolIcon = createIconComponent("AoEToolIcon");

// 2. Character Sheet, Padlock & Non-Color Disposition Badges
export const PadlockLockedIcon = createIconComponent("PadlockLockedIcon");
export const PadlockUnlockedIcon = createIconComponent("PadlockUnlockedIcon");
export const LevelUpArrowIcon = createIconComponent("LevelUpArrowIcon");
export const ShortRestCampfireIcon = createIconComponent("ShortRestCampfireIcon");
export const LongRestTentIcon = createIconComponent("LongRestTentIcon");
export const DiceD20NeutralIcon = createIconComponent("DiceD20NeutralIcon");
export const AllyBadgeIcon = createIconComponent("AllyBadgeIcon");
export const HostileBadgeIcon = createIconComponent("HostileBadgeIcon");
export const ActiveTurnChevronIcon = createIconComponent("ActiveTurnChevronIcon");

// 3. Theme Modes
export const ThemeDarkIcon = createIconComponent("ThemeDarkIcon");
export const ThemeLightIcon = createIconComponent("ThemeLightIcon");
export const ThemeSystemIcon = createIconComponent("ThemeSystemIcon");

// 4. Workspace Shell & Navigation
export const WorkspaceMapIcon = createIconComponent("WorkspaceMapIcon");
export const WorkspaceActorsIcon = createIconComponent("WorkspaceActorsIcon");
export const WorkspaceJournalIcon = createIconComponent("WorkspaceJournalIcon");
export const WorkspaceCompendiumIcon = createIconComponent("WorkspaceCompendiumIcon");
export const WorkspaceSettingsIcon = createIconComponent("WorkspaceSettingsIcon");

// 5. Operational History & UI Controls
export const UndoIcon = createIconComponent("UndoIcon");
export const RedoIcon = createIconComponent("RedoIcon");
export const ChevronDownIcon = createIconComponent("ChevronDownIcon");
export const ChevronRightIcon = createIconComponent("ChevronRightIcon");
export const CloseIcon = createIconComponent("CloseIcon");

// Backward-compatibility Aliases
export const MapIcon = WorkspaceMapIcon;
export const ActorsIcon = WorkspaceActorsIcon;
export const JournalIcon = WorkspaceJournalIcon;
export const CompendiumIcon = WorkspaceCompendiumIcon;
export const SettingsIcon = WorkspaceSettingsIcon;
export const MeasureRulerIcon = RulerToolIcon;
export const GridToggleIcon = GridToolIcon;
export const FogBrushIcon = FogBrushToolIcon;
export const DoorStateIcon = DoorToolIcon;
export const LightSourceIcon = LightToolIcon;
export const AmbientSunIcon = AmbientToolIcon;
export const AmbientMoonIcon = createIconComponent("AmbientMoonIcon");
export const AudioWaveIcon = AudioToolIcon;
export const PingBeaconIcon = PingToolIcon;
export const AoETemplateIcon = AoEToolIcon;
export const LocaleIcon = createIconComponent("LocaleIcon");

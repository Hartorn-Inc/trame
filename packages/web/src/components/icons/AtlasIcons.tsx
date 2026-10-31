/**
 * ============================================================================
 * TRAME ATLAS v1.1 STROKED ICON LIBRARY (AtlasIcons.tsx)
 * ============================================================================
 *
 * Canonical `20px` / `24px` SVG icon set using uniform `1.75px` stroke width,
 * rounded caps/joins, `stroke="currentColor"`, and `aria-hidden="true"`.
 *
 * Covers 34 canonical tabletop & UI icons:
 *   1. Workspace & Navigation (9):
 *      `MapIcon`, `ActorsIcon`, `JournalIcon`, `CompendiumIcon`, `SettingsIcon`,
 *      `ThemeDarkIcon`, `ThemeLightIcon`, `ThemeSystemIcon`, `LocaleIcon`
 *   2. Tabletop Tool Rail (13):
 *      `SelectToolIcon`, `PanToolIcon`, `MeasureRulerIcon`, `GridToggleIcon`,
 *      `FogBrushIcon`, `WallToolIcon`, `DoorStateIcon`, `LightSourceIcon`,
 *      `AmbientSunIcon`, `AmbientMoonIcon`, `AudioWaveIcon`, `PingBeaconIcon`,
 *      `AoETemplateIcon`
 *   3. Combat, Rest & Non-Color Disposition Badges (9):
 *      `PadlockLockedIcon`, `PadlockUnlockedIcon`, `LevelUpArrowIcon`,
 *      `ShortRestCampfireIcon`, `LongRestTentIcon`, `DiceD20NeutralIcon`,
 *      `AllyBadgeIcon`, `HostileBadgeIcon`, `ActiveTurnChevronIcon`
 *   4. Mobile Companion Tabs & History Operations (3):
 *      `SheetIcon`, `InventoryIcon`, `UndoIcon`
 * ============================================================================
 */

export interface AtlasIconProps {
  size?: 20 | 24 | number;
  className?: string;
  testId?: string;
}

export interface AtlasIconGenericProps extends AtlasIconProps {
  name: AtlasIconName | string;
}

export const ATLAS_ICON_STROKE_WIDTH = 1.75;

export const ATLAS_ICON_PATHS: Record<string, readonly string[]> = {
  // 1. Workspace & Navigation (9)
  MapIcon: [
    "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z",
    "M9 3v15",
    "M15 6v15",
  ],
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
  ThemeDarkIcon: [
    "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  ],
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
  LocaleIcon: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  ],

  // 2. Tabletop Tool Rail (13)
  SelectToolIcon: [
    "M4 4l7.07 17 2.51-7.39L21 11.07 4 4z",
    "M13.5 13.5L19 19",
  ],
  PanToolIcon: [
    "M12 2v20",
    "M2 12h20",
    "M12 2l-3 3M12 2l3 3",
    "M12 22l-3-3M12 22l3-3",
    "M2 12l3-3M2 12l3 3",
    "M22 12l-3-3M22 12l-3 3",
  ],
  MeasureRulerIcon: [
    "M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0l12.6 12.6z",
    "M14.5 12.5l2-2",
    "M11.5 9.5l2-2",
    "M8.5 6.5l2-2",
    "M17.5 15.5l2-2",
  ],
  GridToggleIcon: [
    "M3 3h18v18H3z",
    "M3 9h18",
    "M3 15h18",
    "M9 3v18",
    "M15 3v18",
  ],
  FogBrushIcon: [
    "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242",
    "M8 19h8",
    "M10 22h4",
  ],
  WallToolIcon: [
    "M3 6h18v12H3z",
    "M3 12h18",
    "M9 6v6",
    "M15 6v6",
    "M6 12v6",
    "M12 12v6",
    "M18 12v6",
  ],
  DoorStateIcon: [
    "M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16",
    "M3 21h18",
    "M15 12h.01",
  ],
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
  AmbientMoonIcon: [
    "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  ],
  AudioWaveIcon: [
    "M2 10v3",
    "M6 6v11",
    "M10 3v18",
    "M14 8v7",
    "M18 5v13",
    "M22 10v3",
  ],
  PingBeaconIcon: [
    "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M16.24 7.76a6 6 0 0 1 0 8.49",
    "M7.76 16.24a6 6 0 0 1 0-8.49",
    "M19.07 4.93a10 10 0 0 1 0 14.14",
    "M4.93 19.07a10 10 0 0 1 0-14.14",
  ],
  AoETemplateIcon: [
    "M12 3l9 16H3L12 3z",
    "M12 9v5",
    "M12 17h.01",
  ],

  // 3. Combat, Rest & Non-Color Disposition Badges (9)
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
  LevelUpArrowIcon: [
    "M12 19V5",
    "M5 12l7-7 7 7",
    "M5 19h14",
  ],
  ShortRestCampfireIcon: [
    "M12 3c2.5 3 4 5.5 4 8a4 4 0 1 1-8 0c0-2.5 1.5-5 4-8z",
    "M4 20l16-4",
    "M4 16l16 4",
  ],
  LongRestTentIcon: [
    "M3 20h18L12 4 3 20z",
    "M12 4v16",
    "M9 20l3-6 3 6",
  ],
  DiceD20NeutralIcon: [
    "M12 2l9 5v10l-9 5-9-5V7l9-5z",
    "M12 2v20",
    "M3 7l9 5 9-5",
    "M3 17l9-5 9 5",
  ],
  AllyBadgeIcon: [
    "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
    "M9 12l2 2 4-4",
  ],
  HostileBadgeIcon: [
    "M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z",
    "M12 8v5",
    "M12 16h.01",
  ],
  ActiveTurnChevronIcon: [
    "M9 6l6 6-6 6",
    "M5 6l6 6-6 6",
  ],

  // 4. Mobile Companion Tabs & History Operations (3)
  SheetIcon: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    "M14 2v6h6",
    "M16 13H8",
    "M16 17H8",
    "M10 9H8",
  ],
  InventoryIcon: [
    "M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8z",
    "M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2",
    "M8 10h8",
    "M8 14h8",
    "M12 10v4",
  ],
  UndoIcon: [
    "M3 9l4-4M3 9l4 4",
    "M3 9h11a6 6 0 0 1 0 12h-2",
  ],
};

export type AtlasIconName = keyof typeof ATLAS_ICON_PATHS;
export const ATLAS_ICON_NAMES = Object.keys(ATLAS_ICON_PATHS) as readonly AtlasIconName[];

export function resolveAtlasIconName(name: string): AtlasIconName {
  if (name in ATLAS_ICON_PATHS) {
    return name as AtlasIconName;
  }
  const withSuffix = `${name}Icon`;
  if (withSuffix in ATLAS_ICON_PATHS) {
    return withSuffix as AtlasIconName;
  }
  const normalized = name.toLowerCase().replace(/icon$/, "");
  for (const key of ATLAS_ICON_NAMES) {
    if (key.toLowerCase().replace(/icon$/, "") === normalized) {
      return key;
    }
  }
  return "MapIcon";
}

export function renderAtlasIconSvg(name: AtlasIconName | string, size: number = 20): string {
  const resolved = resolveAtlasIconName(name);
  const paths = ATLAS_ICON_PATHS[resolved] ?? ATLAS_ICON_PATHS.MapIcon;
  const pathNodes = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${ATLAS_ICON_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-icon="${resolved}">${pathNodes}</svg>`;
}

export function AtlasIcon(props: AtlasIconGenericProps) {
  const size = props.size ?? 20;
  const resolvedName = resolveAtlasIconName(props.name);
  const paths = ATLAS_ICON_PATHS[resolvedName] ?? ATLAS_ICON_PATHS.MapIcon;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ATLAS_ICON_STROKE_WIDTH}
      stroke-width={ATLAS_ICON_STROKE_WIDTH}
      strokeLinecap="round"
      stroke-linecap="round"
      strokeLinejoin="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.className}
      data-testid={props.testId ?? `atlas-icon-${resolvedName}`}
      data-icon={resolvedName}
    >
      {paths.map((d, idx) => (
        <path key={idx} d={d} />
      ))}
    </svg>
  );
}

function createIconComponent(name: AtlasIconName) {
  return function AtlasSvgIcon(props: AtlasIconProps) {
    const size = props.size ?? 20;
    const paths = ATLAS_ICON_PATHS[name];
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={ATLAS_ICON_STROKE_WIDTH}
        stroke-width={ATLAS_ICON_STROKE_WIDTH}
        strokeLinecap="round"
        stroke-linecap="round"
        strokeLinejoin="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={props.className}
        data-testid={props.testId ?? `atlas-icon-${name}`}
        data-icon={name}
      >
        {paths.map((d, idx) => (
          <path key={idx} d={d} />
        ))}
      </svg>
    );
  };
}

// 1. Workspace & Navigation (9)
export const MapIcon = createIconComponent("MapIcon");
export const ActorsIcon = createIconComponent("ActorsIcon");
export const JournalIcon = createIconComponent("JournalIcon");
export const CompendiumIcon = createIconComponent("CompendiumIcon");
export const SettingsIcon = createIconComponent("SettingsIcon");
export const ThemeDarkIcon = createIconComponent("ThemeDarkIcon");
export const ThemeLightIcon = createIconComponent("ThemeLightIcon");
export const ThemeSystemIcon = createIconComponent("ThemeSystemIcon");
export const LocaleIcon = createIconComponent("LocaleIcon");

// 2. Tabletop Tool Rail (13)
export const SelectToolIcon = createIconComponent("SelectToolIcon");
export const PanToolIcon = createIconComponent("PanToolIcon");
export const MeasureRulerIcon = createIconComponent("MeasureRulerIcon");
export const GridToggleIcon = createIconComponent("GridToggleIcon");
export const FogBrushIcon = createIconComponent("FogBrushIcon");
export const WallToolIcon = createIconComponent("WallToolIcon");
export const DoorStateIcon = createIconComponent("DoorStateIcon");
export const LightSourceIcon = createIconComponent("LightSourceIcon");
export const AmbientSunIcon = createIconComponent("AmbientSunIcon");
export const AmbientMoonIcon = createIconComponent("AmbientMoonIcon");
export const AudioWaveIcon = createIconComponent("AudioWaveIcon");
export const PingBeaconIcon = createIconComponent("PingBeaconIcon");
export const AoETemplateIcon = createIconComponent("AoETemplateIcon");

// 3. Combat, Rest & Non-Color Disposition Badges (9)
export const PadlockLockedIcon = createIconComponent("PadlockLockedIcon");
export const PadlockUnlockedIcon = createIconComponent("PadlockUnlockedIcon");
export const LevelUpArrowIcon = createIconComponent("LevelUpArrowIcon");
export const ShortRestCampfireIcon = createIconComponent("ShortRestCampfireIcon");
export const LongRestTentIcon = createIconComponent("LongRestTentIcon");
export const DiceD20NeutralIcon = createIconComponent("DiceD20NeutralIcon");
export const AllyBadgeIcon = createIconComponent("AllyBadgeIcon");
export const HostileBadgeIcon = createIconComponent("HostileBadgeIcon");
export const ActiveTurnChevronIcon = createIconComponent("ActiveTurnChevronIcon");

// 4. Mobile Companion Tabs & History Operations (3)
export const SheetIcon = createIconComponent("SheetIcon");
export const InventoryIcon = createIconComponent("InventoryIcon");
export const UndoIcon = createIconComponent("UndoIcon");

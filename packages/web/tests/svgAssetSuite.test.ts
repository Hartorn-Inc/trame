import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VNode } from "preact";

if (typeof module.register === "function") {
  try {
    module.register("./tsx-loader.mjs", import.meta.url);
  } catch {
    // Optional tsx-loader hook
  }
}

const {
  TrameLogo,
  renderTrameLogoSvg,
  TRAME_LOGO_VARIANTS,
} = await import("../src/components/icons/TrameLogo.tsx");

const {
  AtlasIcon,
  ATLAS_ICON_NAMES,
  ATLAS_ICON_PATHS,
  ATLAS_ICON_STROKE_WIDTH,
  renderAtlasIconSvg,
  SelectToolIcon,
  PanToolIcon,
  RulerToolIcon,
  GridToolIcon,
  FogBrushToolIcon,
  WallToolIcon,
  DoorToolIcon,
  LightToolIcon,
  AmbientToolIcon,
  AudioToolIcon,
  PingToolIcon,
  AoEToolIcon,
  PadlockLockedIcon,
  PadlockUnlockedIcon,
  LevelUpArrowIcon,
  ShortRestCampfireIcon,
  LongRestTentIcon,
  DiceD20NeutralIcon,
  AllyBadgeIcon,
  HostileBadgeIcon,
  ActiveTurnChevronIcon,
  ThemeDarkIcon,
  ThemeLightIcon,
  ThemeSystemIcon,
  WorkspaceMapIcon,
  WorkspaceActorsIcon,
  WorkspaceJournalIcon,
  WorkspaceCompendiumIcon,
  WorkspaceSettingsIcon,
  UndoIcon,
  RedoIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  MapIcon,
  ActorsIcon,
  JournalIcon,
  CompendiumIcon,
  SettingsIcon,
  MeasureRulerIcon,
  GridToggleIcon,
  FogBrushIcon,
  DoorStateIcon,
  LightSourceIcon,
  AmbientSunIcon,
  AudioWaveIcon,
  PingBeaconIcon,
  AoETemplateIcon,
} = await import("../src/components/icons/AtlasIcons.tsx");

const {
  AtlasEmptyStates,
  EmptyCampaignsSvg,
  EmptyMapAtlasSvg,
  EmptyJournalSvg,
  EmptyActorsSvg,
  AtlasEmptyStateContainer,
  EmptyStateContainer,
  AtlasEmptyState,
  renderEmptyStateSvg,
} = await import("../src/components/icons/AtlasEmptyStates.tsx");

/**
 * Helper to recursively inspect a VNode tree for any forbidden <text> nodes.
 */
function findTextNodesInVNode(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const vnode = node as { type?: unknown; props?: { children?: unknown } };
  const found: string[] = [];

  if (vnode.type === "text") {
    found.push("<text>");
  }

  const children = vnode.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      found.push(...findTextNodesInVNode(child));
    }
  } else if (children && typeof children === "object") {
    found.push(...findTextNodesInVNode(children));
  }

  return found;
}

describe("Ticket #106: ATLAS v1.1 In-House SVG Asset Suite", () => {
  describe("1. TrameLogo: Variants, Duotone Token Separation & Viewport Scaling", () => {
    it("exports all 3 cartographic variants", () => {
      assert.deepEqual(TRAME_LOGO_VARIANTS, [
        "route-intersection",
        "waypoint-grid",
        "monolith-path",
      ]);
    });

    it("WHEN TrameLogo renders with variant 'route-intersection' and duotone set to true, primary geometry uses var(--atlas-text) and accent geometry uses var(--atlas-action)", () => {
      const vnode = TrameLogo({ variant: "route-intersection", duotone: true }) as VNode<any>;
      assert.equal(vnode.type, "svg");
      assert.equal(vnode.props["data-testid"], "trame-logo-route-intersection");

      const children = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : [vnode.props.children];
      assert.ok(children.length >= 2, "Must contain primary and accent geometric elements");

      const primary = children.find((c: any) => c.key === "crossbar" || c.props?.d?.includes("M4 6.5h16"));
      assert.ok(primary, "Primary crossbar element must exist");
      assert.equal(primary.props.stroke, "var(--atlas-text)");

      const accentPath = children.find((c: any) => c.key === "waypoint-arms" || c.props?.d?.includes("M6.5 13h3"));
      assert.ok(accentPath, "Accent waypoint arms must exist");
      assert.equal(accentPath.props.stroke, "var(--atlas-action)");

      const accentDot = children.find((c: any) => c.key === "waypoint-node" || c.props?.cx === 12);
      assert.ok(accentDot, "Accent waypoint node must exist");
      assert.equal(accentDot.props.fill, "var(--atlas-action)");

      // Also verify string generator output
      const svgString = renderTrameLogoSvg({ variant: "route-intersection", duotone: true });
      assert.match(svgString, /stroke="var\(--atlas-text\)"/);
      assert.match(svgString, /stroke="var\(--atlas-action\)"/);
      assert.match(svgString, /fill="var\(--atlas-action\)"/);
    });

    it("WHEN TrameLogo renders with variant 'waypoint-grid' and duotone set to true, primary geometry uses var(--atlas-text) and accent geometry uses var(--atlas-action)", () => {
      const vnode = TrameLogo({ variant: "waypoint-grid", duotone: true }) as VNode<any>;
      const children = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : [vnode.props.children];

      const rect = children.find((c: any) => c.key === "frame" || c.type === "rect");
      assert.ok(rect, "Frame rect must exist");
      assert.equal(rect.props.stroke, "var(--atlas-text)");

      const dot = children.find((c: any) => c.key === "node" || c.type === "circle");
      assert.ok(dot, "Accent circle must exist");
      assert.equal(dot.props.fill, "var(--atlas-action)");
    });

    it("WHEN TrameLogo renders with variant 'monolith-path' and duotone set to true, primary geometry uses var(--atlas-text) and accent geometry uses var(--atlas-action)", () => {
      const vnode = TrameLogo({ variant: "monolith-path", duotone: true }) as VNode<any>;
      const children = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : [vnode.props.children];

      const lintel = children.find((c: any) => c.key === "lintel" || c.type === "path");
      assert.ok(lintel, "Lintel path must exist");
      assert.equal(lintel.props.stroke, "var(--atlas-text)");

      const marker = children.find((c: any) => c.key === "marker" || c.type === "rect");
      assert.ok(marker, "Accent marker rect must exist");
      assert.equal(marker.props.fill, "var(--atlas-action)");
    });

    it("WHEN TrameLogo renders with duotone set to false, all geometries fall back to currentColor", () => {
      const vnode = TrameLogo({ variant: "route-intersection", duotone: false }) as VNode<any>;
      const children = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : [vnode.props.children];

      for (const child of children) {
        if (child.props?.stroke) {
          assert.equal(child.props.stroke, "currentColor");
        }
        if (child.props?.fill && child.props.fill !== "none") {
          assert.equal(child.props.fill, "currentColor");
        }
      }
    });

    it("WHEN TrameLogo renders with size 16, the component sets width=16 and height=16 on the root svg tag", () => {
      const vnode = TrameLogo({ size: 16 }) as VNode<any>;
      assert.equal(vnode.props.width, 16);
      assert.equal(vnode.props.height, 16);

      const svgString = renderTrameLogoSvg({ size: 16 });
      assert.match(svgString, /width="16"/);
      assert.match(svgString, /height="16"/);
    });

    it("clamps size within the supported [16, 256] range", () => {
      const small = TrameLogo({ size: 8 }) as VNode<any>;
      assert.equal(small.props.width, 16);
      assert.equal(small.props.height, 16);

      const large = TrameLogo({ size: 512 }) as VNode<any>;
      assert.equal(large.props.width, 256);
      assert.equal(large.props.height, 256);
    });

    it("provides accessible role and title when title prop is specified", () => {
      const titled = TrameLogo({ title: "TRAME Tabletop Engine" }) as VNode<any>;
      assert.equal(titled.props["aria-label"], "TRAME Tabletop Engine");
      assert.equal(titled.props.role, "img");
      assert.equal(titled.props["aria-hidden"], undefined);

      const untitled = TrameLogo({}) as VNode<any>;
      assert.equal(untitled.props["aria-hidden"], "true");
      assert.equal(untitled.props.role, undefined);
    });
  });

  describe("2. AtlasIcon: 34 Normalized Icons, 1.75px Stroke & Unified Geometry", () => {
    it("contains exactly 34 canonical icon names without duplicates", () => {
      assert.equal(ATLAS_ICON_NAMES.length, 34);
      const uniqueNames = new Set(ATLAS_ICON_NAMES);
      assert.equal(uniqueNames.size, 34);
    });

    const expectedIcons = [
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

    for (const iconName of expectedIcons) {
      it(`WHEN AtlasIcon renders '${iconName}', the component outputs an SVG with viewBox '0 0 24 24', strokeWidth 1.75, fill 'none', stroke 'currentColor', and aria-hidden='true'`, () => {
        const vnode = AtlasIcon({ name: iconName }) as VNode<any>;
        assert.equal(vnode.type, "svg");
        assert.equal(vnode.props.viewBox, "0 0 24 24");
        assert.equal(vnode.props.strokeWidth, 1.75);
        assert.equal(vnode.props.fill, "none");
        assert.equal(vnode.props.stroke, "currentColor");
        assert.equal(vnode.props["aria-hidden"], "true");
        assert.equal(vnode.props["data-icon"], iconName);

        const svgString = renderAtlasIconSvg(iconName);
        assert.match(svgString, /viewBox="0 0 24 24"/);
        assert.match(svgString, /stroke-width="1.75"/);
        assert.match(svgString, /fill="none"/);
        assert.match(svgString, /stroke="currentColor"/);
        assert.match(svgString, /aria-hidden="true"/);
        assert.match(svgString, new RegExp(`data-icon="${iconName}"`));
      });
    }

    it("exports dedicated standalone components for every canonical icon and common aliases", () => {
      const standaloneMap: Record<string, () => VNode<any>> = {
        SelectToolIcon,
        PanToolIcon,
        RulerToolIcon,
        GridToolIcon,
        FogBrushToolIcon,
        WallToolIcon,
        DoorToolIcon,
        LightToolIcon,
        AmbientToolIcon,
        AudioToolIcon,
        PingToolIcon,
        AoEToolIcon,
        PadlockLockedIcon,
        PadlockUnlockedIcon,
        LevelUpArrowIcon,
        ShortRestCampfireIcon,
        LongRestTentIcon,
        DiceD20NeutralIcon,
        AllyBadgeIcon,
        HostileBadgeIcon,
        ActiveTurnChevronIcon,
        ThemeDarkIcon,
        ThemeLightIcon,
        ThemeSystemIcon,
        WorkspaceMapIcon,
        WorkspaceActorsIcon,
        WorkspaceJournalIcon,
        WorkspaceCompendiumIcon,
        WorkspaceSettingsIcon,
        UndoIcon,
        RedoIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        CloseIcon,
        // Aliases
        MapIcon,
        ActorsIcon,
        JournalIcon,
        CompendiumIcon,
        SettingsIcon,
        MeasureRulerIcon,
        GridToggleIcon,
        FogBrushIcon,
        DoorStateIcon,
        LightSourceIcon,
        AmbientSunIcon,
        AudioWaveIcon,
        PingBeaconIcon,
        AoETemplateIcon,
      };

      for (const [name, Component] of Object.entries(standaloneMap)) {
        const vnode = Component();
        assert.equal(vnode.type, "svg", `${name} must output an SVG element`);
        assert.equal(vnode.props.viewBox, "0 0 24 24", `${name} must have 24x24 viewBox`);
        assert.equal(vnode.props.strokeWidth, ATLAS_ICON_STROKE_WIDTH, `${name} must have 1.75 strokeWidth`);
        assert.equal(vnode.props.fill, "none", `${name} must have fill none`);
        assert.equal(vnode.props["aria-hidden"], "true", `${name} must have aria-hidden true`);
      }
    });

    it("allows customizing size, color, className, and ARIA attributes", () => {
      const vnode = AtlasIcon({
        name: "UndoIcon",
        size: 24,
        color: "var(--atlas-action)",
        className: "custom-icon",
        "aria-hidden": false,
        "data-testid": "custom-undo",
      }) as VNode<any>;

      assert.equal(vnode.props.width, 24);
      assert.equal(vnode.props.height, 24);
      assert.equal(vnode.props.stroke, "var(--atlas-action)");
      assert.equal(vnode.props.class, "custom-icon");
      assert.equal(vnode.props["aria-hidden"], "false");
      assert.equal(vnode.props["data-testid"], "custom-undo");
    });
  });

  describe("3. AtlasEmptyStates: 4 Cartographic SVGs & Zero-Text Invariant", () => {
    const emptyStateIllustrations = [
      { name: "EmptyCampaignsSvg", component: EmptyCampaignsSvg, testId: "empty-state-campaigns" },
      { name: "EmptyMapAtlasSvg", component: EmptyMapAtlasSvg, testId: "empty-state-map-atlas" },
      { name: "EmptyJournalSvg", component: EmptyJournalSvg, testId: "empty-state-journal" },
      { name: "EmptyActorsSvg", component: EmptyActorsSvg, testId: "empty-state-actors" },
    ] as const;

    for (const { name, component, testId } of emptyStateIllustrations) {
      it(`WHEN ${name} renders, the output DOM tree contains zero text elements`, () => {
        const vnode = component() as VNode<any>;
        assert.equal(vnode.type, "svg");
        assert.equal(vnode.props["data-testid"], testId);
        assert.equal(vnode.props["aria-hidden"], "true");
        assert.equal(vnode.props.viewBox, "0 0 160 100");

        const textNodes = findTextNodesInVNode(vnode);
        assert.deepEqual(textNodes, [], `${name} VNode must strictly contain zero <text> elements`);
      });
    }

    const kinds = ["campaigns", "map-atlas", "journal", "actors"] as const;
    for (const kind of kinds) {
      it(`WHEN renderEmptyStateSvg('${kind}') executes, the output string contains zero <text elements`, () => {
        const svgString = renderEmptyStateSvg(kind);
        assert.doesNotMatch(svgString, /<text[\s>]/i, `SVG string for ${kind} must not contain <text>`);
        assert.match(svgString, /viewBox="0 0 160 100"/);
        assert.match(svgString, /aria-hidden="true"/);
        assert.match(svgString, /var\(--atlas-action\)/);
      });
    }
  });

  describe("4. AtlasEmptyStateContainer: Accessible role='status', Localized Headings & Action Seam", () => {
    it("WHEN an empty state container renders an AtlasEmptyState illustration, the container wrapper provides an accessible role='status' with external localized heading and body elements", () => {
      const container = AtlasEmptyStateContainer({
        kind: "campaigns",
        title: "No Campaigns Found",
        description: "Create your first cartographic campaign to begin exploring.",
      }) as VNode<any>;

      assert.equal(container.type, "div");
      assert.equal(container.props.role, "status");
      assert.equal(container.props["aria-live"], "polite");
      assert.match(container.props.class, /ds-empty-state/);

      const children = container.props.children;
      assert.ok(Array.isArray(children));

      // Illustration wrapper
      const illustrationWrapper = children[0];
      assert.ok(illustrationWrapper);
      assert.equal(illustrationWrapper.props["aria-hidden"], "true");
      assert.match(illustrationWrapper.props.class, /ds-empty-state-illustration/);

      // Verify the illustration child inside the wrapper has zero <text>
      const innerSvg = illustrationWrapper.props.children;
      assert.equal(innerSvg.type, EmptyCampaignsSvg);

      // Localized heading element
      const heading = children[1];
      assert.ok(heading);
      assert.equal(heading.type, "h3");
      assert.equal(heading.props["data-testid"], "empty-state-heading");
      assert.equal(heading.props.children, "No Campaigns Found");

      // Localized body element
      const body = children[2];
      assert.ok(body);
      assert.equal(body.type, "p");
      assert.equal(body.props["data-testid"], "empty-state-body");
      assert.equal(body.props.children, "Create your first cartographic campaign to begin exploring.");
    });

    it("renders custom action CTA when action prop is provided", () => {
      const container = EmptyStateContainer({
        kind: "map-atlas",
        title: "Unconfigured Map Atlas",
        description: "Upload a UVTT or grid map to start tabletop play.",
        action: { type: "button", props: { children: "Upload Map", "data-testid": "upload-cta" } },
      }) as VNode<any>;

      assert.equal(container.props.role, "status");
      const children = container.props.children;
      const actionWrapper = children[3];
      assert.ok(actionWrapper, "Action container must exist");
      assert.equal(actionWrapper.props["data-testid"], "empty-state-action");
      assert.equal(actionWrapper.props.children.props.children, "Upload Map");
    });

    it("supports custom illustration component child directly", () => {
      const customIllustration = EmptyActorsSvg({ width: 200, height: 120 });
      const container = AtlasEmptyState({
        illustration: customIllustration,
        title: "Empty Actor Roster",
        description: "Add player characters and monsters to the roster.",
      }) as VNode<any>;

      assert.equal(container.props.role, "status");
      const illustrationWrapper = container.props.children[0];
      assert.equal(illustrationWrapper.props.children, customIllustration);
    });
  });
});

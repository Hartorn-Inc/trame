import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TrameLogo,
  renderTrameLogoSvg,
  TRAME_LOGO_VARIANTS,
  normalizeLogoSize,
  isLogoDuotone,
  type TrameLogoVariant,
} from "../src/components/icons/TrameLogo.tsx";
import {
  AtlasIcon,
  renderAtlasIconSvg,
  ATLAS_ICON_NAMES,
  ATLAS_ICON_PATHS,
  ATLAS_ICON_STROKE_WIDTH,
  resolveAtlasIconName,
  MapIcon,
  ActorsIcon,
  JournalIcon,
  CompendiumIcon,
  SettingsIcon,
  ThemeDarkIcon,
  ThemeLightIcon,
  ThemeSystemIcon,
  LocaleIcon,
  SelectToolIcon,
  PanToolIcon,
  MeasureRulerIcon,
  GridToggleIcon,
  FogBrushIcon,
  WallToolIcon,
  DoorStateIcon,
  LightSourceIcon,
  AmbientSunIcon,
  AmbientMoonIcon,
  AudioWaveIcon,
  PingBeaconIcon,
  AoETemplateIcon,
  PadlockLockedIcon,
  PadlockUnlockedIcon,
  LevelUpArrowIcon,
  ShortRestCampfireIcon,
  LongRestTentIcon,
  DiceD20NeutralIcon,
  AllyBadgeIcon,
  HostileBadgeIcon,
  ActiveTurnChevronIcon,
  SheetIcon,
  InventoryIcon,
  UndoIcon,
  RedoIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
} from "../src/components/icons/AtlasIcons.tsx";
import {
  AtlasEmptyState,
  AtlasEmptyStateContainer,
  EmptyCampaignsSvg,
  EmptyMapAtlasSvg,
  EmptyJournalSvg,
  EmptyActorsSvg,
  renderEmptyStateSvg,
  renderEmptyStateHtml,
  EMPTY_STATE_KINDS,
  type EmptyStateKind,
} from "../src/components/icons/AtlasEmptyStates.tsx";

describe("ATLAS v1.1 In-House SVG Asset Suite (#106)", () => {
  describe("1. TrameLogo Cartographic Brand Mark", () => {
    it("WHEN TrameLogo renders with variant 'route-intersection' and duotone set to true, the component outputs primary geometry in var(--atlas-text) and accent geometry in var(--atlas-action)", () => {
      const vnode = TrameLogo({ variant: "route-intersection", duotone: true });
      assert.ok(vnode);
      assert.equal(vnode.props["data-variant"], "route-intersection");
      assert.equal(vnode.props["data-mode"], "duotone");

      const children = (vnode.props.children as any[]) || [];
      assert.equal(children.length, 3);

      const primaryPath = children[0];
      assert.equal(primaryPath.props.stroke, "var(--atlas-text)");

      const accentPath = children[1];
      assert.equal(accentPath.props.stroke, "var(--atlas-action)");

      const accentCircle = children[2];
      assert.equal(accentCircle.props.fill, "var(--atlas-action)");

      const renderedSvg = renderTrameLogoSvg({ variant: "route-intersection", duotone: true });
      assert.match(renderedSvg, /stroke="var\(--atlas-text\)"/);
      assert.match(renderedSvg, /stroke="var\(--atlas-action\)"/);
      assert.match(renderedSvg, /fill="var\(--atlas-action\)"/);
    });

    it("WHEN TrameLogo renders with size 16, the component sets width=16 and height=16 on the root svg tag", () => {
      const vnode = TrameLogo({ size: 16 });
      assert.ok(vnode);
      assert.equal(vnode.props.width, 16);
      assert.equal(vnode.props.height, 16);

      const renderedSvg = renderTrameLogoSvg({ size: 16 });
      assert.match(renderedSvg, /width="16"/);
      assert.match(renderedSvg, /height="16"/);
    });

    it("clamps sizes to the supported 16px to 256px range", () => {
      assert.equal(normalizeLogoSize(10), 16);
      assert.equal(normalizeLogoSize(16), 16);
      assert.equal(normalizeLogoSize(48), 48);
      assert.equal(normalizeLogoSize(256), 256);
      assert.equal(normalizeLogoSize(512), 256);
      assert.equal(normalizeLogoSize(undefined), 24);
    });

    it("renders all 3 cartographic variants in monochrome mode with currentColor", () => {
      for (const variant of TRAME_LOGO_VARIANTS) {
        const vnode = TrameLogo({ variant, duotone: false });
        assert.equal(vnode.props["data-mode"], "monochrome");

        const rendered = renderTrameLogoSvg({ variant, duotone: false });
        assert.match(rendered, /stroke="currentColor"/);
        assert.doesNotMatch(rendered, /var\(--atlas-action\)/);
      }
    });

    it("provides accessible role='img' and aria-label when title is provided, or aria-hidden='true' otherwise", () => {
      const titled = TrameLogo({ title: "TRAME Cartographic Mark" });
      assert.equal(titled.props.role, "img");
      assert.equal(titled.props["aria-label"], "TRAME Cartographic Mark");
      assert.equal(titled.props["aria-hidden"], undefined);

      const untitled = TrameLogo({});
      assert.equal(untitled.props["aria-hidden"], "true");
      assert.equal(untitled.props.role, undefined);
    });
  });

  describe("2. AtlasIcons Stroked Tabletop & UI Library (34 Normalized Icons)", () => {
    it("contains exactly 38 canonical registered icon definitions", () => {
      assert.equal(ATLAS_ICON_NAMES.length, 38);
      assert.equal(Object.keys(ATLAS_ICON_PATHS).length, 38);
      assert.equal(ATLAS_ICON_STROKE_WIDTH, 1.75);
    });

    const testCases = ATLAS_ICON_NAMES.map((name) => ({ name }));
    for (const { name } of testCases) {
      it(`WHEN AtlasIcon renders '${name}', the component outputs an SVG with viewBox '0 0 24 24', strokeWidth 1.75, fill 'none', stroke 'currentColor', and aria-hidden='true'`, () => {
        const vnode = AtlasIcon({ name });
        assert.ok(vnode);
        assert.equal(vnode.props.viewBox, "0 0 24 24");
        assert.equal(vnode.props.strokeWidth, 1.75);
        assert.equal(vnode.props.fill, "none");
        assert.equal(vnode.props.stroke, "currentColor");
        assert.equal(vnode.props["aria-hidden"], "true");
        assert.equal(vnode.props["data-icon"], name);

        const svgString = renderAtlasIconSvg(name, 24);
        assert.match(svgString, /viewBox="0 0 24 24"/);
        assert.match(svgString, /stroke-width="1.75"/);
        assert.match(svgString, /fill="none"/);
        assert.match(svgString, /stroke="currentColor"/);
        assert.match(svgString, /aria-hidden="true"/);
        assert.match(svgString, new RegExp(`data-icon="${name}"`));
      });
    }

    it("resolves names with or without 'Icon' suffix and handles case-insensitivity", () => {
      assert.equal(resolveAtlasIconName("SheetIcon"), "SheetIcon");
      assert.equal(resolveAtlasIconName("Sheet"), "SheetIcon");
      assert.equal(resolveAtlasIconName("sheet"), "SheetIcon");
      assert.equal(resolveAtlasIconName("inventory"), "InventoryIcon");
      assert.equal(resolveAtlasIconName("undo"), "UndoIcon");
    });

    it("exports dedicated named component functions for all 34 canonical icons", () => {
      const iconComponents = [
        MapIcon,
        ActorsIcon,
        JournalIcon,
        CompendiumIcon,
        SettingsIcon,
        ThemeDarkIcon,
        ThemeLightIcon,
        ThemeSystemIcon,
        LocaleIcon,
        SelectToolIcon,
        PanToolIcon,
        MeasureRulerIcon,
        GridToggleIcon,
        FogBrushIcon,
        WallToolIcon,
        DoorStateIcon,
        LightSourceIcon,
        AmbientSunIcon,
        AmbientMoonIcon,
        AudioWaveIcon,
        PingBeaconIcon,
        AoETemplateIcon,
        PadlockLockedIcon,
        PadlockUnlockedIcon,
        LevelUpArrowIcon,
        ShortRestCampfireIcon,
        LongRestTentIcon,
        DiceD20NeutralIcon,
        AllyBadgeIcon,
        HostileBadgeIcon,
        ActiveTurnChevronIcon,
        SheetIcon,
        InventoryIcon,
        UndoIcon,
        RedoIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        CloseIcon,
      ];
      assert.equal(iconComponents.length, 38);
      for (const Comp of iconComponents) {
        const vnode = Comp({ size: 24 });
        assert.ok(vnode);
        assert.equal(vnode.props.viewBox, "0 0 24 24");
        assert.equal(vnode.props.strokeWidth, 1.75);
        assert.equal(vnode.props["aria-hidden"], "true");
      }
    });
  });

  describe("3. AtlasEmptyStates Cartographic Empty States & Accessibility", () => {
    const emptyStateCases: Array<{
      kind: EmptyStateKind;
      component: (props: any) => any;
      testId: string;
    }> = [
      { kind: "campaigns", component: EmptyCampaignsSvg, testId: "empty-state-campaigns" },
      { kind: "map-atlas", component: EmptyMapAtlasSvg, testId: "empty-state-map-atlas" },
      { kind: "journal", component: EmptyJournalSvg, testId: "empty-state-journal" },
      { kind: "actors", component: EmptyActorsSvg, testId: "empty-state-actors" },
    ];

    for (const { kind, component, testId } of emptyStateCases) {
      it(`WHEN SVG illustration '${kind}' renders, the output DOM tree contains zero text elements`, () => {
        const vnode = component({});
        assert.ok(vnode);
        assert.equal(vnode.props["data-testid"], testId);
        assert.equal(vnode.props.viewBox, "0 0 160 100");
        assert.equal(vnode.props["aria-hidden"], "true");

        const serializeChildren = (node: any): string => {
          if (!node || typeof node !== "object") return "";
          let out = `<${node.type}>`;
          const kids = Array.isArray(node.props?.children)
            ? node.props.children
            : node.props?.children
            ? [node.props.children]
            : [];
          for (const kid of kids) {
            out += serializeChildren(kid);
          }
          return out;
        };

        const domTreeString = serializeChildren(vnode);
        assert.doesNotMatch(domTreeString, /<text[\s>]/i);

        const rawSvg = renderEmptyStateSvg(kind);
        assert.doesNotMatch(rawSvg, /<text[\s>]/i);
        assert.match(rawSvg, /var\(--atlas-action\)/);
      });
    }

    it("WHEN an empty state container renders an AtlasEmptyState illustration, the container wrapper provides an accessible role='status' with external localized heading and body elements", () => {
      for (const kind of EMPTY_STATE_KINDS) {
        const container = AtlasEmptyState({
          kind,
          heading: `No ${kind} available`,
          body: `Create or join a new ${kind} to begin playing.`,
        });
        assert.ok(container);
        assert.equal(container.props.role, "status");
        assert.equal(container.props["aria-live"], "polite");
        assert.equal(container.props["data-empty-state"], kind);
        assert.match(container.props.class, /ds-empty-state/);

        const children = container.props.children as any[];
        assert.ok(children);
        assert.equal(children.length, 2);

        const illustrationWrapper = children[0];
        assert.equal(illustrationWrapper.props["aria-hidden"], "true");
        assert.equal(illustrationWrapper.props.class, "ds-empty-state-illustration");

        const contentWrapper = children[1];
        assert.equal(contentWrapper.props.class, "ds-empty-state-content");

        const contentKids = contentWrapper.props.children as any[];
        const heading = contentKids[0];
        assert.equal(heading.type, "h3");
        assert.equal(heading.props.children, `No ${kind} available`);

        const body = contentKids[1];
        assert.equal(body.type, "p");
        assert.equal(body.props.children, `Create or join a new ${kind} to begin playing.`);

        const renderedHtml = renderEmptyStateHtml({
          kind,
          heading: `No ${kind} available`,
          body: `Create or join a new ${kind} to begin playing.`,
        });
        assert.match(renderedHtml, /role="status"/);
        assert.match(renderedHtml, /aria-live="polite"/);
        assert.match(renderedHtml, /<h3 class="ds-empty-state-heading">/);
        assert.match(renderedHtml, /<p class="ds-empty-state-body">/);
        assert.doesNotMatch(renderedHtml, /<svg[^>]*>[\s\S]*?<text[\s>]/i);
      }
    });

    it("AtlasEmptyStateContainer alias functions identically to AtlasEmptyState", () => {
      assert.equal(AtlasEmptyStateContainer, AtlasEmptyState);
    });
  });
});

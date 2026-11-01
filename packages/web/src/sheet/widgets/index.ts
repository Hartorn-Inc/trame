import { h, type VNode } from "preact";
import type { WidgetProps } from "../WidgetRegistry.ts";

export function StatBlock6Widget(props: WidgetProps): VNode {
  const isLocked = props.isLocked ?? !props.options?.padlockUnlocked;
  const abilities = (props.boundValues?.abilities as Record<string, any>) || {};
  const order = (props.options?.displayOrder as string[]) || [
    "str",
    "dex",
    "con",
    "int",
    "wis",
    "cha",
  ];

  const cards = order.map((key) => {
    const val = abilities[key];
    const score = typeof val?.score === "number" ? val.score : Number(val || 10);
    const mod =
      typeof val?.modifier === "number"
        ? val.modifier
        : typeof val?.mod === "number"
          ? val.mod
          : Math.floor((score - 10) / 2);
    const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;

    const rollHandler = () => {
      props.dispatchCommand?.({
        cmd: "ROLL_DICE",
        expression: `1d20${modDisplay}`,
        ability: key,
        modifier: mod,
        visibility: "PUBLIC",
        reason: `Ability check: ${key}`,
      });
    };

    return h(
      "div",
      {
        key,
        "data-testid": `ability-card-${key}`,
        class: `ds-ability-card atlas-tabular-nums ${isLocked ? "is-rollable" : "is-editable"}`,
        role: isLocked ? "button" : undefined,
        tabIndex: isLocked ? 0 : undefined,
        "aria-label": isLocked ? `Roll ${key.toUpperCase()} check` : undefined,
        onClick: isLocked ? rollHandler : undefined,
        onKeyDown: isLocked
          ? (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                rollHandler();
              }
            }
          : undefined,
      },
      [
        h("span", { class: "ds-ability-name" }, key.toUpperCase()),
        h("span", { class: "ds-ability-mod atlas-tabular-nums" }, modDisplay),
        isLocked
          ? h(
              "span",
              {
                class: "ds-ability-score atlas-tabular-nums",
                "data-testid": `ability-score-${key}`,
              },
              String(score),
            )
          : h("div", { class: "ds-ability-stepper" }, [
              h(
                "button",
                {
                  type: "button",
                  class: "ds-btn ds-btn-secondary",
                  "data-testid": `ability-dec-${key}`,
                  "aria-label": `Decrease ${key} score`,
                },
                "-",
              ),
              h(
                "span",
                { class: "ds-ability-score-val atlas-tabular-nums" },
                String(score),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "ds-btn ds-btn-secondary",
                  "data-testid": `ability-inc-${key}`,
                  "aria-label": `Increase ${key} score`,
                },
                "+",
              ),
            ]),
      ],
    );
  });

  const vnode: any = h(
    "div",
    {
      id: props.id,
      "data-testid": "statblock-6-widget",
      class: "ds-statblock-6 atlas-tabular-nums",
    },
    cards,
  );

  vnode.triggerAbilityClick = (abilityKey: string) => {
    const val = abilities[abilityKey];
    const score = typeof val?.score === "number" ? val.score : Number(val || 10);
    const mod =
      typeof val?.modifier === "number"
        ? val.modifier
        : typeof val?.mod === "number"
          ? val.mod
          : Math.floor((score - 10) / 2);
    const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;
    props.dispatchCommand?.({
      cmd: "ROLL_DICE",
      expression: `1d20${modDisplay}`,
      ability: abilityKey,
      modifier: mod,
      visibility: "PUBLIC",
      reason: `Ability check: ${abilityKey}`,
    });
  };

  return vnode;
}

export function ResourceBarWidget(props: WidgetProps): VNode {
  const isLocked = props.isLocked ?? !props.options?.padlockUnlocked;
  const current = Number(props.boundValues?.current ?? props.boundValues?.hpCurrent ?? 0);
  const max = Number(props.boundValues?.max ?? props.boundValues?.hpMax ?? 0);
  const temp = Number(props.boundValues?.temp ?? props.boundValues?.hpTemp ?? 0);

  return h(
    "div",
    {
      id: props.id,
      "data-testid": "resource-bar-widget",
      class: "ds-resource-bar-widget atlas-tabular-nums",
    },
    [
      h("input", {
        type: "number",
        class: "ds-resource-input-current atlas-tabular-nums",
        "data-testid": "resource-input-current",
        "aria-label": "Current HP",
        value: String(current),
      }),
      isLocked
        ? h(
            "span",
            {
              class: "ds-resource-max-locked atlas-tabular-nums",
              "data-testid": "resource-max-val",
            },
            String(max),
          )
        : h("input", {
            type: "number",
            class: "ds-resource-input-max atlas-tabular-nums",
            "data-testid": "resource-input-max",
            "aria-label": "Maximum HP",
            value: String(max),
          }),
      h("input", {
        type: "number",
        class: "ds-resource-input-temp atlas-tabular-nums",
        "data-testid": "resource-input-temp",
        "aria-label": "Temporary HP",
        value: String(temp),
      }),
    ],
  );
}

export function ArmorInitiativeSpeedWidget(props: WidgetProps): VNode {
  const ac = Number(props.boundValues?.armorClass ?? 10);
  const init = Number(
    props.boundValues?.initiative ?? props.boundValues?.initiativeBonus ?? 0,
  );
  const speed = props.boundValues?.speed ?? "30 ft";
  const initDisplay = init >= 0 ? `+${init}` : `${init}`;

  return h(
    "div",
    {
      id: props.id,
      "data-testid": "armor-initiative-speed-widget",
      class: "ds-armor-initiative-speed atlas-tabular-nums",
    },
    [
      h("div", { class: "ds-stat-card atlas-tabular-nums", "data-testid": "ac-card" }, [
        h("span", { class: "ds-stat-label" }, "Armor Class"),
        h("span", { class: "ds-stat-value atlas-tabular-nums" }, String(ac)),
      ]),
      h(
        "div",
        {
          class: "ds-stat-card atlas-tabular-nums is-rollable",
          "data-testid": "initiative-card",
          role: "button",
          tabIndex: 0,
          "aria-label": "Roll Initiative",
          onClick: () => {
            props.dispatchCommand?.({
              cmd: "ROLL_DICE",
              expression: `1d20${initDisplay}`,
              visibility: "PUBLIC",
              reason: "Initiative",
            });
          },
        },
        [
          h("span", { class: "ds-stat-label" }, "Initiative"),
          h("span", { class: "ds-stat-value atlas-tabular-nums" }, initDisplay),
        ],
      ),
      h("div", { class: "ds-stat-card atlas-tabular-nums", "data-testid": "speed-card" }, [
        h("span", { class: "ds-stat-label" }, "Speed"),
        h("span", { class: "ds-stat-value atlas-tabular-nums" }, String(speed)),
      ]),
    ],
  );
}

export function HitDiceAndDeathSavesWidget(props: WidgetProps): VNode {
  const hdCurrent = Number(props.boundValues?.hitDiceCurrent ?? 0);
  const hdMax = Number(props.boundValues?.hitDiceMax ?? 0);
  const deathSucc = Number(props.boundValues?.deathSuccesses ?? 0);
  const deathFail = Number(props.boundValues?.deathFailures ?? 0);

  return h(
    "div",
    {
      id: props.id,
      "data-testid": "hitdice-death-saves-widget",
      class: "ds-hitdice-death-saves atlas-tabular-nums",
    },
    [
      h("div", { class: "ds-hitdice-section atlas-tabular-nums" }, [
        h("span", { class: "ds-stat-label" }, "Hit Dice"),
        h(
          "span",
          { class: "ds-stat-value atlas-tabular-nums" },
          `${hdCurrent}/${hdMax}`,
        ),
      ]),
      h("div", { class: "ds-deathsaves-section atlas-tabular-nums" }, [
        h("span", { class: "ds-stat-label" }, "Death Saves"),
        h(
          "span",
          { class: "ds-stat-value atlas-tabular-nums" },
          `S: ${deathSucc} / F: ${deathFail}`,
        ),
      ]),
    ],
  );
}

export function SavingThrowListWidget(props: WidgetProps): VNode {
  const isLocked = props.isLocked ?? !props.options?.padlockUnlocked;
  const saves = (props.boundValues?.saves as Record<string, any>) || {};

  return h(
    "div",
    {
      id: props.id,
      "data-testid": "saving-throw-list-widget",
      class: "ds-saving-throws atlas-tabular-nums",
    },
    Object.entries(saves).map(([key, val]) => {
      const mod = Number(val?.modifier ?? 0);
      const prof = Boolean(val?.proficient);
      const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;
      return h("div", { key, class: "ds-save-row atlas-tabular-nums" }, [
        isLocked
          ? null
          : h("button", {
              type: "button",
              "data-testid": `save-prof-toggle-${key}`,
              "aria-label": `Toggle ${key} saving throw proficiency`,
              "aria-pressed": prof ? "true" : "false",
            }),
        h("span", { class: "ds-save-label" }, key.toUpperCase()),
        h("span", { class: "ds-save-mod atlas-tabular-nums" }, modDisplay),
      ]);
    }),
  );
}

export function SkillCheckListWidget(props: WidgetProps): VNode {
  const isLocked = props.isLocked ?? !props.options?.padlockUnlocked;
  const skills = (props.boundValues?.skills as Record<string, any>) || {};

  return h(
    "div",
    {
      id: props.id,
      "data-testid": "skill-check-list-widget",
      class: "ds-skill-checks atlas-tabular-nums",
    },
    Object.entries(skills).map(([key, val]) => {
      const mod = Number(val?.modifier ?? 0);
      const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;
      return h("div", { key, class: "ds-skill-row atlas-tabular-nums" }, [
        isLocked
          ? null
          : h("button", {
              type: "button",
              "data-testid": `skill-prof-cycle-${key}`,
              "aria-label": `Cycle ${key} skill proficiency rank`,
            }),
        h("span", { class: "ds-skill-label" }, key),
        h("span", { class: "ds-skill-mod atlas-tabular-nums" }, modDisplay),
      ]);
    }),
  );
}

export function ConditionBadgeStripWidget(props: WidgetProps): VNode {
  const conditions = (props.boundValues?.conditions as any[]) || [];
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "condition-badge-strip-widget",
      class: "ds-condition-strip atlas-tabular-nums",
    },
    conditions.map((c, idx) =>
      h(
        "span",
        {
          key: idx,
          class: "ds-badge atlas-tabular-nums",
          "data-testid": `condition-badge-${c.id ?? c}`,
        },
        String(c.name ?? c),
      ),
    ),
  );
}

export function AttackActionTableWidget(props: WidgetProps): VNode {
  const attacks = (props.boundValues?.attacks as any[]) || [];
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "attack-action-table-widget",
      class: "ds-attack-table atlas-tabular-nums",
    },
    attacks.map((atk, idx) =>
      h("div", { key: idx, class: "ds-attack-row atlas-tabular-nums" }, [
        h("span", { class: "ds-attack-name" }, String(atk.name)),
        h(
          "span",
          { class: "ds-attack-bonus atlas-tabular-nums" },
          String(atk.attackBonus),
        ),
        h(
          "span",
          { class: "ds-attack-damage atlas-tabular-nums" },
          String(atk.damageFormula),
        ),
      ]),
    ),
  );
}

export function SpellbookAccordionWidget(props: WidgetProps): VNode {
  const spells = (props.boundValues?.spells as any[]) || [];
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "spellbook-accordion-widget",
      class: "ds-spellbook-accordion atlas-tabular-nums",
    },
    spells.map((sp, idx) =>
      h("div", { key: idx, class: "ds-spell-row atlas-tabular-nums" }, [
        h("span", { class: "ds-spell-name" }, String(sp.name)),
        h(
          "span",
          { class: "ds-spell-level atlas-tabular-nums" },
          String(sp.level),
        ),
      ]),
    ),
  );
}

export function InventoryContainerTreeWidget(props: WidgetProps): VNode {
  const items = (props.boundValues?.items as any[]) || [];
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "inventory-container-tree-widget",
      class: "ds-inventory-tree atlas-tabular-nums",
    },
    items.map((item, idx) =>
      h("div", { key: idx, class: "ds-inventory-item atlas-tabular-nums" }, [
        h("span", { class: "ds-item-name" }, String(item.name)),
        h(
          "span",
          { class: "ds-item-qty atlas-tabular-nums" },
          String(item.quantity ?? 1),
        ),
      ]),
    ),
  );
}

export function FeatureTraitListWidget(props: WidgetProps): VNode {
  const features = (props.boundValues?.features as any[]) || [];
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "feature-trait-list-widget",
      class: "ds-feature-list atlas-tabular-nums",
    },
    features.map((f, idx) =>
      h("div", { key: idx, class: "ds-feature-item atlas-tabular-nums" }, [
        h("h4", { class: "ds-feature-name" }, String(f.name)),
        h("p", { class: "ds-feature-desc" }, String(f.description ?? "")),
      ]),
    ),
  );
}

export function NotesMarkdownPaneWidget(props: WidgetProps): VNode {
  const bio = String(props.boundValues?.bio ?? "");
  const notes = String(props.boundValues?.notes ?? "");
  return h(
    "div",
    {
      id: props.id,
      "data-testid": "notes-markdown-pane-widget",
      class: "ds-notes-pane atlas-tabular-nums",
    },
    [
      h("div", { class: "ds-bio-text" }, bio),
      h("div", { class: "ds-notes-text" }, notes),
    ],
  );
}

export function registerAllCanonicalWidgets(registry: {
  register: (name: string, impl: unknown) => void;
}): void {
  const widgets: Record<string, unknown> = {
    StatBlock6: StatBlock6Widget,
    StatBlock6Widget,
    ResourceBar: ResourceBarWidget,
    ResourceBarWidget,
    ArmorInitiativeSpeed: ArmorInitiativeSpeedWidget,
    ArmorInitiativeSpeedWidget,
    HitDiceAndDeathSaves: HitDiceAndDeathSavesWidget,
    HitDiceAndDeathSavesWidget,
    SavingThrowList: SavingThrowListWidget,
    SavingThrowListWidget,
    SkillCheckList: SkillCheckListWidget,
    SkillCheckListWidget,
    ConditionBadgeStrip: ConditionBadgeStripWidget,
    ConditionBadgeStripWidget,
    AttackActionTable: AttackActionTableWidget,
    AttackActionTableWidget,
    SpellbookAccordion: SpellbookAccordionWidget,
    SpellbookAccordionWidget,
    InventoryContainerTree: InventoryContainerTreeWidget,
    InventoryContainerTreeWidget,
    FeatureTraitList: FeatureTraitListWidget,
    FeatureTraitListWidget,
    NotesMarkdownPane: NotesMarkdownPaneWidget,
    NotesMarkdownPaneWidget,
  };

  for (const [name, impl] of Object.entries(widgets)) {
    registry.register(name, impl);
  }
}

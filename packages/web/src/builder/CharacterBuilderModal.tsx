/**
 * ============================================================================
 * CHARACTER CREATION MODAL (builder/CharacterBuilderModal.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Accessible eight-step dialog over `CharacterBuilderWizard` (species, class,
 * background, ability scores, class skills, equipment, spells, review). On
 * confirm it creates the
 * actor with `POST /api/v1/campaigns/{id}/actors`, reusing the sheet id as the
 * actor id so the token link and the sheet stay one identity.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Wizard Owns The Rules`:
 *    - The modal never computes scores, HP, or feats itself; it renders the
 *      wizard's draft and shows the wizard's validation errors (i18n keys).
 * 2. `Modal Accessibility`:
 *    - `role="dialog"` + `aria-modal`, labelled title, focus trap with
 *      Escape-to-cancel, and a stepper marking the current step with
 *      `aria-current="step"`. Errors are announced through `role="alert"`.
 * 3. `Single Submission`:
 *    - The create button is inert while the request is in flight, so a double
 *      click cannot create two actors.
 * 4. `Class & Origin Feat Picks Capped In The UI`:
 *    - Multi-pick choices (skills, proficiencies, cantrips, spells) are
 *      checkboxes that disable the unpicked options once `count` are chosen,
 *      with a polite "n of count chosen" status; single picks are radios.
 * 5. `Accessible Ability Score Controls & Tabular Numerals`:
 *    - Standard Array pairs `<label for>` with `<select id>`; Point-Buy uses
 *      `role="group"` + `aria-labelledby` with localized stepper `aria-label`s
 *      and zero orphaned `for` attributes. Numeric scores, modifiers, and
 *      remaining Point-Buy points carry `.atlas-tabular-nums`.
 * ============================================================================
 */
import { h, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import {
  BACKGROUNDS,
  CompendiumResolver,
  SRD_CLASS_PROGRESSION,
  SRD_SPECIES,
  TOOL_OPTION_PREFIX,
  type AbilityId,
  type BackgroundId,
  type BuilderChoice,
  type BuilderChoiceOption,
  type SrdClassId,
  type SrdSpeciesId,
} from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient, CampaignActor } from '../api/client.ts';
import { describeActionError } from '../api/errorMessages.ts';
import type { Uuid } from '../api/wire.ts';
import { useModalFocusTrap } from '../components/a11y/useModalFocusTrap.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { BuilderDraftStore } from './builderDraftStore.ts';
import { CharacterBuilderWizard } from './CharacterBuilderWizard.ts';
import { BUILDER_STEPS, DND5E_ABILITIES, POINT_BUY_COST_TABLE, STANDARD_ARRAY, type BuilderStep } from './types.ts';

export interface CharacterBuilderModalProps {
  campaignId: Uuid;
  client: ApiClient;
  onClose: () => void;
  /** Called with the stored actor after `201 Created`. */
  onCreated?: (actor: CampaignActor) => void;
}

const ABILITY_LABEL: Record<AbilityId, MessageKey> = {
  str: 'ability.str.label',
  dex: 'ability.dex.label',
  con: 'ability.con.label',
  int: 'ability.int.label',
  wis: 'ability.wis.label',
  cha: 'ability.cha.label',
};

const GOLD_OPTION = '50 GP';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function stepLabel(step: BuilderStep): string {
  return t(`builder.step.${step}` as MessageKey);
}

function featLabel(featRef: string): string {
  return t(`builder.feat.${featRef.replace(/^srd:feat:/, '')}` as MessageKey);
}

function abilityModText(score: number): string {
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** SRD rules text of a spell option (English, verbatim), `null` when the compendium has none. */
function spellDescription(spellId: string): string | null {
  const description = CompendiumResolver.getDefault().get(spellId)?.data.description;
  return typeof description === 'string' && description.trim() ? description : null;
}

export function CharacterBuilderModal(props: CharacterBuilderModalProps): VNode<any> | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [wizard] = useState(() => new CharacterBuilderWizard({ draftStore: new BuilderDraftStore() }));
  const [, setTick] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => wizard.draftStore.subscribe(() => setTick((n) => n + 1)), [wizard]);
  useModalFocusTrap(dialogRef, {
    onEscape: () => {
      if (!submitting) props.onClose();
    },
  });

  const draft = wizard.getDraft();
  if (!draft) return null;
  const step = wizard.currentStep;
  const finalScores = wizard.getFinalAbilityScores();
  const rerender = () => setTick((n) => n + 1);

  const goNext = () => {
    const result = wizard.validateStep(step);
    setErrors(result.errors);
    if (result.valid) {
      wizard.nextStep();
      rerender();
    }
  };

  const goBack = () => {
    setErrors([]);
    wizard.previousStep();
    rerender();
  };

  const create = async () => {
    if (submitting) return;
    const result = wizard.validateStep('review');
    setErrors(result.errors);
    if (!result.valid) return;
    const actor = wizard.confirm();
    if (!actor) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await props.client.createActor(props.campaignId, { id: actor.id, name: actor.name, data: actor });
      wizard.draftStore.clear();
      props.onCreated?.(created);
      props.onClose();
    } catch (err) {
      setSubmitError(describeActionError(err, t('builder.createFailed')));
    } finally {
      setSubmitting(false);
    }
  };

  const radio = (
    name: string,
    value: string,
    checked: boolean,
    onSelect: () => void,
    label: string,
    meta?: string,
    extra?: { metaClass?: string; metaTestId?: string; describedBy?: string },
  ) =>
    h(
      'label',
      { key: value, class: cx('ds-choice ds-choice-stacked', checked && 'is-selected') },
      h(
        'span',
        { class: 'ds-cluster' },
        h('input', {
          type: 'radio',
          name,
          value,
          checked,
          'data-testid': `builder-${name}-${value}`,
          'aria-describedby': extra?.describedBy,
          onChange: onSelect,
        }),
        h('span', { class: 'ds-value' }, label),
      ),
      meta ? h('span', { class: cx('ds-meta', extra?.metaClass), 'data-testid': extra?.metaTestId }, meta) : null,
    );

  const fieldset = (legend: string, children: ComponentChildren) =>
    h('fieldset', { class: 'ds-stack-sm' }, h('legend', { class: 'ds-section-title' }, legend), children);

  const renderSpecies = () =>
    fieldset(
      t('builder.species.legend'),
      (Object.keys(SRD_SPECIES) as SrdSpeciesId[]).map((id) => {
        const rules = SRD_SPECIES[id];
        return radio('species', id, draft.speciesId === id, () => wizard.setSpecies(id), t(`builder.species.${id}` as MessageKey),
          t('builder.species.meta', { speed: rules.speedFt, darkvision: rules.darkvisionFt }));
      }),
    );

  const renderClass = () =>
    fieldset(
      t('builder.class.legend'),
      (Object.keys(SRD_CLASS_PROGRESSION) as SrdClassId[]).map((id) => {
        const rules = SRD_CLASS_PROGRESSION[id];
        return radio('class', id, draft.classId === id, () => wizard.setClass(id), t(`builder.class.${id}` as MessageKey),
          t('builder.class.meta', {
            die: rules.hitDie,
            saves: rules.savingThrows.map((ab) => ab.toUpperCase()).join(', '),
          }));
      }),
    );

  const renderBackground = () => {
    const background = draft.backgroundId ? BACKGROUNDS[draft.backgroundId as BackgroundId] : undefined;
    const choice = draft.backgroundChoice;
    return h(
      'div',
      { class: 'ds-stack' },
      fieldset(
        t('builder.background.legend'),
        (Object.keys(BACKGROUNDS) as BackgroundId[]).map((id) => {
          const rules = BACKGROUNDS[id];
          return radio('background', id, draft.backgroundId === id, () => wizard.setBackground(id), t(`builder.background.${id}` as MessageKey),
            t('builder.background.meta', {
              abilities: rules.abilities.map((ab) => ab.toUpperCase()).join(', '),
              feat: featLabel(rules.originFeat),
            }));
        }),
      ),
      background
        ? fieldset(t('builder.background.split'), [
            radio('split', 'plus1_each', choice?.mode === 'plus1_each', () => wizard.setBackgroundChoice({ mode: 'plus1_each' }),
              t('builder.background.plus1Each')),
            radio('split', 'plus2_plus1', choice?.mode === 'plus2_plus1',
              () => wizard.setBackgroundChoice({ mode: 'plus2_plus1', plus2: background.abilities[0], plus1: background.abilities[1] }),
              t('builder.background.plus2Plus1')),
            choice?.mode === 'plus2_plus1'
              ? h(
                  'div',
                  { key: 'split-selects', class: 'ds-grid-2' },
                  (['plus2', 'plus1'] as const).map((slot) =>
                    h(
                      'div',
                      { key: slot, class: 'ds-field' },
                      h('label', { for: `builder-${slot}`, class: 'ds-field-label' }, t(`builder.background.${slot}` as MessageKey)),
                      h(
                        'select',
                        {
                          id: `builder-${slot}`,
                          class: 'ds-input',
                          'data-testid': `builder-${slot}`,
                          value: choice[slot],
                          onChange: (e: Event) =>
                            wizard.setBackgroundChoice({ ...choice, [slot]: (e.target as HTMLSelectElement).value as AbilityId }),
                        },
                        background.abilities.map((ab) => h('option', { key: ab, value: ab }, t(ABILITY_LABEL[ab]))),
                      ),
                    ),
                  ),
                )
              : null,
          ])
        : null,
      ...wizard.getOriginFeatChoices().map((featChoice) => renderChoice(featChoice, 'feat')),
    );
  };

  const renderAbilities = () => {
    const isArray = draft.abilityGenerationMethod === 'standardArray';
    return h(
      'div',
      { class: 'ds-stack' },
      fieldset(t('builder.abilities.method'), [
        radio(
          'method',
          'pointBuy',
          !isArray,
          () => wizard.setAbilityScores({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }, 'pointBuy'),
          t('builder.abilities.pointBuy'),
          t('builder.abilities.remaining', { points: wizard.getRemainingPointBuyBudget() }),
          { metaClass: 'atlas-tabular-nums', metaTestId: 'builder-point-buy-remaining' },
        ),
        radio('method', 'standardArray', isArray,
          () => wizard.setAbilityScores({ str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, 'standardArray'),
          t('builder.abilities.standardArray')),
      ]),
      h(
        'ul',
        { class: 'ds-list-plain ds-stack-sm' },
        DND5E_ABILITIES.map((ab) => {
          const base = draft.abilityScores[ab];
          const abilityName = t(ABILITY_LABEL[ab]);
          const labelId = `builder-ability-label-${ab}`;
          const rowLabel = isArray
            ? h('label', { for: `builder-score-${ab}`, class: 'ds-field-label' }, abilityName)
            : h('span', { id: labelId, class: 'ds-field-label' }, abilityName);
          const control = isArray
            ? h(
                'select',
                {
                  id: `builder-score-${ab}`,
                  class: 'ds-input atlas-tabular-nums',
                  'data-testid': `builder-score-${ab}`,
                  value: String(base),
                  onChange: (e: Event) => wizard.setAbilityScores({ [ab]: Number((e.target as HTMLSelectElement).value) }),
                },
                STANDARD_ARRAY.map((v) => h('option', { key: v, value: String(v) }, String(v))),
              )
            : h(
                'div',
                {
                  role: 'group',
                  'aria-labelledby': labelId,
                  class: 'ds-cluster',
                  'data-testid': `builder-stepper-${ab}`,
                },
                h('button', {
                  type: 'button',
                  class: 'ds-btn ds-btn-secondary',
                  'data-testid': `builder-dec-${ab}`,
                  'aria-label': t('builder.abilities.decrease', { ability: abilityName }),
                  disabled: base <= 8,
                  onClick: () => wizard.setAbilityScores({ [ab]: base - 1 }),
                }, '−'),
                h('span', { class: 'ds-counter atlas-tabular-nums', 'data-testid': `builder-base-${ab}` }, String(base)),
                h('button', {
                  type: 'button',
                  class: 'ds-btn ds-btn-secondary',
                  'data-testid': `builder-inc-${ab}`,
                  'aria-label': t('builder.abilities.increase', { ability: abilityName }),
                  disabled: base >= 15 || POINT_BUY_COST_TABLE[base + 1] - POINT_BUY_COST_TABLE[base] > wizard.getRemainingPointBuyBudget(),
                  onClick: () => wizard.setAbilityScores({ [ab]: base + 1 }),
                }, '+'),
              );
          return h(
            'li',
            { key: ab, class: 'ds-row' },
            rowLabel,
            control,
            h(
              'span',
              { class: 'ds-cluster' },
              h('span', { class: 'ds-value atlas-tabular-nums', 'data-testid': `builder-final-${ab}` }, t('builder.abilities.final', { score: finalScores[ab] })),
              h('span', { class: 'ds-meta atlas-tabular-nums', 'data-testid': `builder-mod-${ab}` }, `(${abilityModText(finalScores[ab])})`),
            ),
          );
        }),
      ),
    );
  };

  const optionLabel = (choice: BuilderChoice, option: BuilderChoiceOption): string => {
    switch (choice.kind) {
      case 'ability':
        return t(ABILITY_LABEL[option.id as AbilityId]);
      case 'skill':
        return t(`skill.${option.id}` as MessageKey);
      case 'skill_or_tool':
        return option.id.startsWith(TOOL_OPTION_PREFIX)
          ? option.label
          : t(`skill.${option.id}` as MessageKey);
      case 'spell_list':
        return t(`builder.class.${option.id}` as MessageKey);
      case 'feat':
        return featLabel(option.id);
      default:
        return option.label;
    }
  };

  const renderSpellDetails = (testPrefix: string, option: BuilderChoiceOption, description: string | null, descriptionId: string) =>
    description
      ? h(
          'details',
          { class: 'ds-meta', 'data-testid': `${testPrefix}-details` },
          h('summary', null, t('builder.spells.details', { name: option.label })),
          h('p', { id: descriptionId, lang: 'en', 'data-testid': descriptionId }, description),
        )
      : null;

  /** One class or Origin feat choice: radios for a single pick, else checkboxes capped at `count` (invariant 4). */
  const renderChoice = (choice: BuilderChoice, scope: 'class' | 'feat' = 'class') => {
    const picked = scope === 'feat' ? wizard.getFeatSelection(choice.id) : wizard.getClassSelection(choice.id);
    const toggle = (optionId: string) =>
      scope === 'feat' ? wizard.toggleFeatOption(choice.id, optionId) : wizard.toggleClassOption(choice.id, optionId);
    const idPrefix = scope === 'feat' ? `feat-${choice.id}` : choice.id;
    const radioGroup = `${scope}-${choice.id}`;
    const full = picked.length >= choice.count;
    const legend = choice.kind === 'equipment_option'
      ? t('builder.choice.classEquipment')
      : t(`builder.choice.${choice.id}` as MessageKey, { count: choice.count });
    if (choice.count === 1) {
      return fieldset(legend, choice.options.map((option) => {
        const description = choice.kind === 'spell' ? spellDescription(option.id) : null;
        const testPrefix = `builder-${radioGroup}-${option.id}`;
        const descriptionId = `${testPrefix}-description`;
        const choiceRadio = radio(
          radioGroup,
          option.id,
          picked.includes(option.id),
          () => toggle(option.id),
          choice.kind === 'equipment_option' ? t('builder.equipment.classOption', { id: option.id }) : optionLabel(choice, option),
          choice.kind === 'equipment_option' ? option.label : undefined,
          description ? { describedBy: descriptionId } : undefined,
        );
        return description
          ? h('div', { key: option.id, class: 'ds-stack-sm' }, choiceRadio, renderSpellDetails(testPrefix, option, description, descriptionId))
          : choiceRadio;
      }));
    }
    return fieldset(legend, [
      h('p', { key: 'count', class: 'ds-meta atlas-tabular-nums', 'aria-live': 'polite', 'data-testid': `builder-${idPrefix}-count` },
        t('builder.choice.picked', { picked: picked.length, count: choice.count })),
      ...choice.options.map((option) => {
        const checked = picked.includes(option.id);
        const description = choice.kind === 'spell' ? spellDescription(option.id) : null;
        const testPrefix = `builder-${idPrefix}-${option.id}`;
        const descriptionId = `${testPrefix}-description`;
        return h(
          'div',
          { key: option.id, class: 'ds-stack-sm' },
          h(
            'label',
            { class: cx('ds-choice', checked && 'is-selected') },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: !checked && full,
              'data-testid': testPrefix,
              'aria-describedby': description ? descriptionId : undefined,
              onChange: () => toggle(option.id),
            }),
            h('span', { class: 'ds-value' }, optionLabel(choice, option)),
          ),
          renderSpellDetails(testPrefix, option, description, descriptionId),
        );
      }),
    ]);
  };

  const renderSkills = () => h('div', { class: 'ds-stack' }, wizard.choicesForStep('skills').map((c) => renderChoice(c)));

  const renderSpells = () => {
    const choices = wizard.choicesForStep('spells');
    return h('div', { class: 'ds-stack' }, choices.length
      ? choices.map((c) => renderChoice(c))
      : h('p', { class: 'ds-hint', 'data-testid': 'builder-no-spells' }, t('builder.spells.none')));
  };

  const renderEquipment = () => {
    const background = draft.backgroundId ? BACKGROUNDS[draft.backgroundId as BackgroundId] : undefined;
    const packageItems = background ? [...background.equipment] : [];
    const isGold = draft.equipmentIds.length === 1 && draft.equipmentIds[0] === GOLD_OPTION;
    return h('div', { class: 'ds-stack' },
      wizard.choicesForStep('equipment').map((c) => renderChoice(c)),
      fieldset(t('builder.equipment.legend'), [
        radio('equipment', 'package', draft.equipmentIds.length > 0 && !isGold, () => wizard.setEquipment(packageItems),
          t('builder.equipment.package'), packageItems.join(', ')),
        radio('equipment', 'gold', isGold, () => wizard.setEquipment([GOLD_OPTION]), t('builder.equipment.gold')),
      ]));
  };

  const renderReview = () =>
    h(
      'div',
      { class: 'ds-stack' },
      h(
        'div',
        { class: 'ds-field' },
        h('label', { for: 'builder-name', class: 'ds-field-label' }, t('builder.review.name')),
        h('input', {
          id: 'builder-name',
          class: 'ds-input',
          'data-testid': 'builder-name',
          value: draft.name,
          maxLength: 100,
          onInput: (e: Event) => wizard.setName((e.target as HTMLInputElement).value),
        }),
      ),
      h(
        'dl',
        { class: 'ds-stack-sm', 'data-testid': 'builder-summary' },
        h('dt', { class: 'ds-meta' }, t('builder.step.species')),
        h('dd', null, draft.speciesId ? t(`builder.species.${draft.speciesId}` as MessageKey) : ''),
        h('dt', { class: 'ds-meta' }, t('builder.step.class')),
        h('dd', null, draft.classId ? t(`builder.class.${draft.classId}` as MessageKey) : ''),
        h('dt', { class: 'ds-meta' }, t('builder.step.background')),
        h('dd', null, draft.backgroundId ? t(`builder.background.${draft.backgroundId}` as MessageKey) : ''),
        h('dt', { class: 'ds-meta' }, t('builder.step.abilityScores')),
        h('dd', { class: 'atlas-tabular-nums' }, DND5E_ABILITIES.map((ab) => `${ab.toUpperCase()} ${finalScores[ab]}`).join(' · ')),
      ),
    );

  const body: Record<BuilderStep, () => VNode<any>> = {
    species: renderSpecies,
    class: renderClass,
    background: renderBackground,
    abilityScores: renderAbilities,
    skills: renderSkills,
    equipment: renderEquipment,
    spells: renderSpells,
    review: renderReview,
  };

  return h(
    'div',
    {
      ref: dialogRef,
      class: 'ds-modal-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'data-testid': 'character-builder-modal',
      tabIndex: -1,
    },
    h(
      'div',
      { class: 'ds-modal' },
      h(
        'header',
        { class: 'ds-modal-header' },
        h('h2', { id: titleId, class: 'ds-modal-title' }, t('builder.title')),
        h('button', {
          type: 'button',
          class: 'ds-btn-reset ds-icon-btn',
          'aria-label': t('builder.close'),
          onClick: () => {
            if (!submitting) props.onClose();
          },
        }, '✕'),
      ),
      h(
        'nav',
        { class: 'ds-stepper', 'aria-label': t('builder.stepsLabel') },
        BUILDER_STEPS.map((s, i) => {
          const current = BUILDER_STEPS.indexOf(step);
          return h(
            'div',
            { key: s, class: cx('ds-stepper-item', i < current && 'is-complete'), 'aria-current': s === step ? 'step' : undefined },
            stepLabel(s),
          );
        }),
      ),
      h(
        'div',
        { class: 'ds-modal-body', 'data-testid': `builder-step-${step}` },
        body[step](),
        errors.length > 0
          ? h(
              'ul',
              { class: 'ds-list-plain', role: 'alert', 'data-testid': 'builder-errors' },
              errors.map((key) => h('li', { key, class: 'ds-field-error' }, t(key as MessageKey))),
            )
          : null,
        submitError ? h('p', { class: 'ds-field-error', role: 'alert' }, submitError) : null,
      ),
      h(
        'footer',
        { class: 'ds-modal-footer' },
        h('button', { type: 'button', class: 'ds-btn ds-btn-ghost', 'data-testid': 'builder-cancel', onClick: props.onClose }, t('action.cancel')),
        !wizard.isFirstStep()
          ? h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', 'data-testid': 'builder-back', onClick: goBack }, t('action.previous'))
          : null,
        wizard.isLastStep()
          ? h('button', {
              type: 'button',
              class: 'ds-btn ds-btn-primary',
              'data-testid': 'builder-create',
              'aria-disabled': submitting ? 'true' : 'false',
              onClick: create,
            }, submitting ? t('builder.creating') : t('builder.create'))
          : h('button', { type: 'button', class: 'ds-btn ds-btn-primary', 'data-testid': 'builder-next', onClick: goNext }, t('action.next')),
      ),
    ),
  );
}

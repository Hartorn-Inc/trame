/**
 * ============================================================================
 * CAMPAIGN ACTORS TAB (workspace/ActorsTab.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lists the actor sheets the caller may read, opens the character-creation
 * modal, opens a sheet in the HUD drawer, uploads a portrait through the
 * asset route, and (GM) places an actor on the live table as a linked token.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Filtered List`:
 *    - The list is `GET .../actors`; players only receive their own sheets,
 *      so the tab never filters (or leaks) anything client-side.
 * 2. `Linked Tokens`:
 *    - "Place on table" spawns a token whose `actor_id` is the sheet id and
 *      whose vitals come from the sheet, so damage on the table and edits on
 *      the sheet stay one record (ADR-0037). Only GMs may spawn tokens.
 * 3. `Portraits Are Assets`:
 *    - The image goes to `POST .../assets` (server transcodes to WebP); the
 *      sheet stores the returned object key in `portraitAssetKey` with a
 *      versioned PUT, never the short-lived signed URL. `Dnd5eActorData` has
 *      no portrait field yet; the server stores sheet `data` as opaque JSON,
 *      so the key round-trips as a web-owned extension (`PortraitExtension`).
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import type { Dnd5eActorData } from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, type ActorRecord } from '../api/session.ts';
import type { Uuid, WireTrameCommand } from '../api/wire.ts';
import { CharacterBuilderModal } from '../builder/CharacterBuilderModal.tsx';
import { isSheetDrawerOpenSignal } from '../hud/HudDrawers.tsx';
import { t } from '../i18n/index.ts';
import { saveActorSheet } from '../sheet/sheetPersistence.ts';
import { spawnToken } from '../table/commands.ts';
import { firstFreeCell } from '../table/tableView.ts';

/** Web-owned sheet extension holding the portrait object key (see invariant 3). */
export interface PortraitExtension {
  /** Asset object key (`instances/.../assets/{sha256}.webp`) from `POST .../assets`. */
  portraitAssetKey?: string;
}

/** Image types accepted by the asset route. */
const PORTRAIT_ACCEPT = 'image/png,image/jpeg,image/webp';

export interface ActorsTabProps {
  campaignId: Uuid;
  client: ApiClient;
  isGm: boolean;
}

/** Builds the `SPAWN_TOKEN` command for a stored actor at `topLeft` (`px`). */
export function spawnTokenForActor(actorId: Uuid, record: ActorRecord, topLeft: { x: number; y: number }, tokenId: Uuid): WireTrameCommand {
  const sheet = record.data as Partial<Dnd5eActorData>;
  const attrs = sheet.attributes;
  const dexScore = sheet.abilities?.dex?.score ?? 10;
  return spawnToken({
    tokenId,
    actorId,
    name: record.name ?? sheet.name ?? '',
    ownerUserId: record.ownerUserId ?? null,
    topLeft,
    hp: attrs?.hp?.current ?? 1,
    maxHp: attrs?.hp?.max ?? 1,
    ac: (attrs?.baseArmorAC ?? 10) + (attrs?.shieldBonus ?? 0),
    dexMod: Math.floor((dexScore - 10) / 2),
    speedFt: attrs?.speedFt ?? 30,
  });
}

export function ActorsTab({ campaignId, client, isGm }: ActorsTabProps) {
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actors = Object.entries(client.state.actors.value).sort(([, a], [, b]) => (a.name ?? '').localeCompare(b.name ?? ''));
  const tableOpen = client.state.table.value !== null;

  useEffect(() => {
    client.listActors(campaignId).catch(() => setError(t('actors.loadFailed')));
  }, [client, campaignId]);

  const openSheet = (actorId: Uuid) => {
    selectedActorIdSignal.value = actorId;
    isSheetDrawerOpenSignal.value = true;
  };

  const place = (actorId: Uuid, record: ActorRecord) => {
    const sent = client.submitCommand(spawnTokenForActor(actorId, record, firstFreeCell(client.state.table.value), crypto.randomUUID()));
    setStatus(sent ? t('actors.placed', { name: record.name ?? '' }) : null);
    setError(sent ? null : t('tray.offline'));
  };

  const uploadPortrait = async (actorId: Uuid, record: ActorRecord, file: File) => {
    setError(null);
    try {
      const asset = await client.uploadAsset(campaignId, file, file.type || 'application/octet-stream');
      const data: Dnd5eActorData & PortraitExtension = { ...(record.data as Dnd5eActorData), portraitAssetKey: asset.key };
      const outcome = await saveActorSheet(client, campaignId, actorId, data, { name: record.name });
      setStatus(outcome.status === 'saved' ? t('actors.portraitSaved', { name: record.name ?? '' }) : null);
      if (outcome.status === 'conflict') setError(t('actors.portraitConflict'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actors.portraitFailed'));
    }
  };

  return (
    <section class="ds-stack" aria-labelledby="actors-title" data-testid="actors-tab">
      <header class="ds-panel-header">
        <h2 id="actors-title" class="ds-panel-title">{t('actors.title')}</h2>
        <button type="button" class="ds-btn ds-btn-primary" data-testid="actors-new" onClick={() => setCreating(true)}>
          {t('actors.new')}
        </button>
      </header>
      <p role="status" class="ds-meta" data-testid="actors-status">{status ?? ''}</p>
      {error ? <p role="alert" class="ds-field-error" data-testid="actors-error">{error}</p> : null}
      {actors.length === 0 ? (
        <p class="ds-hint" data-testid="actors-empty">{t('actors.empty')}</p>
      ) : (
        <ul class="ds-list-plain ds-stack-sm">
          {actors.map(([actorId, record]) => (
            <li key={actorId} class="ds-panel ds-row" data-testid={`actor-${actorId}`}>
              <span class="ds-value">{record.name ?? actorId}</span>
              <div class="ds-cluster">
                <button type="button" class="ds-btn ds-btn-secondary" data-testid={`actor-open-${actorId}`} onClick={() => openSheet(actorId)}>
                  {t('vitals.openSheet')}
                </button>
                {isGm ? (
                  <button
                    type="button"
                    class="ds-btn ds-btn-secondary"
                    data-testid={`actor-place-${actorId}`}
                    disabled={!tableOpen}
                    onClick={() => place(actorId, record)}
                  >
                    {t('actors.place')}
                  </button>
                ) : null}
                <label class="ds-btn ds-btn-ghost">
                  {t('actors.portrait')}
                  <input
                    type="file"
                    class="ds-visually-hidden"
                    accept={PORTRAIT_ACCEPT}
                    data-testid={`actor-portrait-${actorId}`}
                    aria-label={t('actors.portraitFor', { name: record.name ?? '' })}
                    onChange={(e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) void uploadPortrait(actorId, record, file);
                    }}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <CharacterBuilderModal
          campaignId={campaignId}
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(actor) => {
            setStatus(t('actors.created', { name: actor.name }));
            openSheet(actor.id);
          }}
        />
      ) : null}
    </section>
  );
}

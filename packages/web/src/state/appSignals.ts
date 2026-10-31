import { batch, signal, type Signal } from "@preact/signals";
import type {
  ActorRecord,
  AuthUser,
  Campaign,
  CampaignRoomState,
  ClientDiceLogEntry,
  HandoutRevealedBroadcast,
  NoteDto,
  Point2D,
  SessionTimelineEvent,
} from "../types/index.ts";

export const authUserSignal: Signal<AuthUser | null> = signal<AuthUser | null>(null);
export const campaignsSignal: Signal<Campaign[]> = signal<Campaign[]>([]);
export const activeCampaignSignal: Signal<Campaign | null> = signal<Campaign | null>(null);
export const tableStateSignal: Signal<CampaignRoomState | null> = signal<CampaignRoomState | null>(null);
export const actorsSignal: Signal<ActorRecord[]> = signal<ActorRecord[]>([]);
export const notesSignal: Signal<NoteDto[]> = signal<NoteDto[]>([]);
export const timelineSignal: Signal<SessionTimelineEvent[]> = signal<SessionTimelineEvent[]>([]);
export const diceLogSignal: Signal<ClientDiceLogEntry[]> = signal<ClientDiceLogEntry[]>([]);
export const activeDrawerSignal: Signal<string | null> = signal<string | null>(null);
export const revealedHandoutSignal: Signal<HandoutRevealedBroadcast | null> = signal<HandoutRevealedBroadcast | null>(null);
export const companionModeSignal: Signal<boolean> = signal<boolean>(false);

export const appSignals = {
  authUserSignal,
  campaignsSignal,
  activeCampaignSignal,
  tableStateSignal,
  actorsSignal,
  notesSignal,
  timelineSignal,
  diceLogSignal,
  activeDrawerSignal,
  revealedHandoutSignal,
  companionModeSignal,
};

export type PreactSignalState = typeof appSignals;

export function resetAppSignals(): void {
  batch(() => {
    authUserSignal.value = null;
    campaignsSignal.value = [];
    activeCampaignSignal.value = null;
    tableStateSignal.value = null;
    actorsSignal.value = [];
    notesSignal.value = [];
    timelineSignal.value = [];
    diceLogSignal.value = [];
    activeDrawerSignal.value = null;
    revealedHandoutSignal.value = null;
    companionModeSignal.value = false;
  });
}

export function mutateActorPosition(
  actorId: string,
  newPosition: Point2D,
  elevationFt?: number,
  speedRemainingFt?: number,
): boolean {
  const current = tableStateSignal.value;
  if (!current) {
    return false;
  }
  let mutated = false;
  if (current.tokens && current.tokens[actorId]) {
    const token = current.tokens[actorId];
    token.topLeft = { ...newPosition };
    if (elevationFt !== undefined) {
      token.elevationFt = elevationFt;
    }
    if (speedRemainingFt !== undefined) {
      token.speedRemainingFt = speedRemainingFt;
    }
    mutated = true;
  }
  if (current.actors && Array.isArray(current.actors)) {
    const actor = current.actors.find((a) => a.id === actorId);
    if (actor) {
      actor.position = { ...newPosition };
      actor.topLeft = { ...newPosition };
      if (elevationFt !== undefined) {
        actor.elevationFt = elevationFt;
      }
      mutated = true;
    }
  }
  if (actorsSignal.value && Array.isArray(actorsSignal.value)) {
    const item = actorsSignal.value.find((a) => a.id === actorId);
    if (item) {
      item.position = { ...newPosition };
      item.topLeft = { ...newPosition };
      if (elevationFt !== undefined) {
        item.elevationFt = elevationFt;
      }
    }
  }
  return mutated;
}

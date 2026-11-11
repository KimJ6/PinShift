import type { SlotDefinition } from "./shared/types";

export function roundScore(round: number): number {
  return Math.max(1, Math.floor(round));
}

export function slotDelta(slot: SlotDefinition, round: number): number {
  if (slot.kind === "loss") return -roundScore(round);
  if (isOddPenaltyRound(round) && slot.oddRoundNetStep !== 0) return 1 + oddRoundPenaltyStep(round) * slot.oddRoundNetStep;
  return slot.roundScaled ? roundScore(round) + 1 : slot.value;
}

export function slotNetDelta(slot: SlotDefinition, round: number): number {
  if (isOddPenaltyRound(round) && slot.oddRoundNetStep !== 0) return oddRoundPenaltyStep(round) * slot.oddRoundNetStep;
  const delta = slotDelta(slot, round);
  return slot.kind === "loss" ? delta : delta - 1;
}

function isOddPenaltyRound(round: number): boolean {
  return roundScore(round) >= 3 && roundScore(round) % 2 === 1;
}

function oddRoundPenaltyStep(round: number): number {
  return Math.floor(roundScore(round) / 2);
}

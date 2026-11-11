import type { BasePinRowSnapshot, GameConfig, PinSnapshot, PlacementRailSnapshot, PinType } from "./shared/types";

export interface PlacementBody {
  id: number;
  x: number;
  y: number;
  radius: number;
}

export function pinPlacementRadius(pin: Pick<PinSnapshot, "type" | "parameters">): number {
  return pin.type === "rotor" ? pin.parameters.half_length + 0.1 : pin.parameters.length / 2 + pin.parameters.thickness;
}

export function maximumSpecialPinRadius(config: GameConfig): number {
  const maximum = (type: PinType, key: string): number => Math.max(...config.upgrades.filter((row) => row.pinType === type && row.paramKey === key).map((row) => row.maxValue));
  return Math.max(
    maximum("elastic", "length") / 2 + maximum("elastic", "thickness"),
    maximum("absorber", "length") / 2 + maximum("absorber", "thickness"),
    maximum("slope", "length") / 2 + maximum("slope", "thickness"),
    maximum("rotor", "half_length") + 0.1
  );
}

export function createPlacementRails(rows: BasePinRowSnapshot[], config: GameConfig): PlacementRailSnapshot[] {
  const margin = config.rules.special_pin_wall_clearance_m + maximumSpecialPinRadius(config);
  return rows.slice(0, -1).map((row, index) => ({
    railIndex: index,
    y: (row.y + rows[index + 1].y) / 2,
    startX: margin,
    endX: config.rules.field_width_m - margin
  }));
}

export function closestFreePoint(rail: PlacementRailSnapshot, desiredX: number, radius: number, pins: PlacementBody[], ignoredId?: number, collisionPadding = 0.04): number | undefined {
  const blocked: Array<{ start: number; end: number }> = [];
  for (const pin of pins) {
    if (pin.id === ignoredId) continue;
    const requiredDistance = radius + pin.radius + collisionPadding;
    const verticalDistance = Math.abs(pin.y - rail.y);
    if (verticalDistance >= requiredDistance) continue;
    const horizontalDistance = Math.sqrt(requiredDistance ** 2 - verticalDistance ** 2);
    blocked.push({ start: pin.x - horizontalDistance, end: pin.x + horizontalDistance });
  }
  const candidates = [desiredX, rail.startX, rail.endX, ...blocked.flatMap((interval) => [interval.start - 0.002, interval.end + 0.002])]
    .filter((candidate) => candidate >= rail.startX && candidate <= rail.endX)
    .filter((candidate) => blocked.every((interval) => candidate < interval.start || candidate > interval.end));
  return candidates.sort((a, b) => Math.abs(a - desiredX) - Math.abs(b - desiredX))[0];
}

export function snapToPlacementRail(rails: PlacementRailSnapshot[], requestedX: number, requestedY: number, radius: number, pins: PlacementBody[], ignoredId?: number, collisionPadding = 0.04): { x: number; y: number } | undefined {
  if (rails.length === 0) return undefined;
  const rail = rails.reduce((closest, candidate) => Math.abs(candidate.y - requestedY) < Math.abs(closest.y - requestedY) ? candidate : closest);
  const desiredX = Math.min(rail.endX, Math.max(rail.startX, requestedX));
  const x = closestFreePoint(rail, desiredX, radius, pins, ignoredId, collisionPadding);
  return x === undefined ? undefined : { x, y: rail.y };
}

export function isValidPlacement(config: GameConfig, rails: PlacementRailSnapshot[], candidate: PlacementBody, pins: PlacementBody[], ignoredId?: number): boolean {
  const epsilon = 1e-6;
  const { field_width_m: width, special_pin_wall_clearance_m: wallClearance } = config.rules;
  if (candidate.x - candidate.radius < wallClearance - epsilon || candidate.x + candidate.radius > width - wallClearance + epsilon) return false;
  const rail = rails.find((entry) => Math.abs(entry.y - candidate.y) < epsilon && candidate.x >= entry.startX - epsilon && candidate.x <= entry.endX + epsilon);
  return rail !== undefined && pins.every((pin) => pin.id === ignoredId || Math.hypot(candidate.x - pin.x, candidate.y - pin.y) >= candidate.radius + pin.radius + config.rules.special_pin_collision_padding_m);
}

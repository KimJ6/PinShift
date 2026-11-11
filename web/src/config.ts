import type { BallConfig, ControlMode, GameConfig, GameRules, PinDefinition, PinType, SlotDefinition, UpgradeRange } from "./shared/types";

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const rows = text.trim().split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  const headers = rows.shift()?.split(",").map((header) => header.trim()) ?? [];
  return rows.map((line) => {
    const values = line.split(",").map((value) => value.trim());
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function numberValue(row: CsvRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} 값이 유효한 수가 아닙니다.`);
  return value;
}

function requireValue(row: CsvRow, key: string): string {
  const value = row[key];
  if (!value) throw new Error(`${key} 값이 비어 있습니다.`);
  return value;
}

function booleanValue(row: CsvRow, key: string): boolean {
  const value = requireValue(row, key).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} 값은 true 또는 false여야 합니다.`);
}

async function loadRows(path: string): Promise<CsvRow[]> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}을 불러오지 못했습니다.`);
  return parseCsv(await response.text());
}

export async function loadGameConfig(): Promise<GameConfig> {
  const [ballRows, pinRows, upgradeRows, slotRows, ruleRows] = await Promise.all([
    loadRows("/config/balls.csv"),
    loadRows("/config/pins.csv"),
    loadRows("/config/pin_upgrades.csv"),
    loadRows("/config/slots.csv"),
    loadRows("/config/game_rules.csv")
  ]);

  if (ballRows.length !== 1) throw new Error("balls.csv에는 볼 정의가 정확히 하나여야 합니다.");
  const ballRow = ballRows[0];
  const ball: BallConfig = {
    id: requireValue(ballRow, "id"), radiusM: numberValue(ballRow, "radius_m"),
    density: numberValue(ballRow, "density"), friction: numberValue(ballRow, "friction"),
    restitution: numberValue(ballRow, "restitution")
  };

  const pins = {} as Record<PinType, PinDefinition>;
  for (const row of pinRows) {
    const pinType = requireValue(row, "pin_type") as PinType;
    pins[pinType] = {
      pinType, purchaseCost: numberValue(row, "purchase_cost"),
      shape: requireValue(row, "shape") as PinDefinition["shape"],
      defaultSizeM: numberValue(row, "default_size_m"),
      defaultThicknessM: numberValue(row, "default_thickness_m"),
      defaultRestitution: numberValue(row, "default_restitution"),
      defaultFriction: numberValue(row, "default_friction")
    };
  }
  for (const type of ["elastic", "absorber", "slope", "rotor"] as PinType[]) {
    if (!pins[type]) throw new Error(`pins.csv에 ${type} 정의가 없습니다.`);
  }

  const upgrades: UpgradeRange[] = upgradeRows.map((row) => ({
    pinType: requireValue(row, "pin_type") as PinType, level: numberValue(row, "level"),
    cost: numberValue(row, "cost"), paramKey: requireValue(row, "param_key"),
    minValue: numberValue(row, "min_value"), maxValue: numberValue(row, "max_value"), unit: requireValue(row, "unit"),
    controlMode: requireValue(row, "control_mode") as ControlMode,
    anchorValue: row.anchor_value === "" ? undefined : numberValue(row, "anchor_value"),
    stepValue: numberValue(row, "step_value"),
    initialValue: row.initial_value === "" ? undefined : numberValue(row, "initial_value")
  }));
  for (const upgrade of upgrades) {
    if (upgrade.minValue > upgrade.maxValue) throw new Error(`${upgrade.pinType} 범위가 역전되었습니다.`);
    if (upgrade.stepValue <= 0) throw new Error(`${upgrade.pinType} 조절 단위가 0보다 커야 합니다.`);
    if (upgrade.initialValue !== undefined && (upgrade.initialValue < upgrade.minValue || upgrade.initialValue > upgrade.maxValue)) throw new Error(`${upgrade.pinType} 초기값이 제어 범위를 벗어났습니다.`);
    if (upgrade.controlMode !== "upper_expand" && upgrade.controlMode !== "center_expand") throw new Error(`${upgrade.pinType} 제어 방식이 유효하지 않습니다.`);
    if (upgrade.controlMode === "center_expand" && upgrade.anchorValue === undefined) throw new Error(`${upgrade.pinType} 중앙 확장 제어에는 기준값이 필요합니다.`);
  }
  const controlGroups = new Map<string, UpgradeRange[]>();
  for (const upgrade of upgrades) {
    const key = `${upgrade.pinType}:${upgrade.paramKey}`;
    controlGroups.set(key, [...(controlGroups.get(key) ?? []), upgrade]);
  }
  for (const [key, rows] of controlGroups) {
    rows.sort((a, b) => a.level - b.level);
    const [first] = rows;
    if (rows.some((row) => row.controlMode !== first.controlMode || row.anchorValue !== first.anchorValue || row.stepValue !== first.stepValue || row.unit !== first.unit)) {
      throw new Error(`${key}의 제어 메타데이터는 모든 레벨에서 같아야 합니다.`);
    }
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (current.level !== previous.level + 1) throw new Error(`${key}의 레벨은 연속되어야 합니다.`);
      if (current.controlMode === "upper_expand" && (Math.abs(current.minValue - previous.minValue) > 1e-7 || current.maxValue < previous.maxValue)) {
        throw new Error(`${key}의 증가형 범위는 하한을 유지하고 상한만 확장해야 합니다.`);
      }
      if (current.controlMode === "center_expand" && (current.minValue > previous.minValue || current.maxValue < previous.maxValue)) {
        throw new Error(`${key}의 중앙 확장형 범위는 기준점 양쪽으로만 확장해야 합니다.`);
      }
      if (current.controlMode === "center_expand" && (first.anchorValue! < current.minValue || first.anchorValue! > current.maxValue)) {
        throw new Error(`${key}의 기준값은 모든 레벨 범위 안에 있어야 합니다.`);
      }
    }
  }

  const slots: SlotDefinition[] = slotRows.map((row) => ({
    slotId: requireValue(row, "slot_id"), position: numberValue(row, "position"),
    kind: requireValue(row, "kind") as SlotDefinition["kind"], value: numberValue(row, "value"),
    roundScaled: booleanValue(row, "round_scaled"),
    oddRoundNetStep: numberValue(row, "odd_round_net_step")
  })).sort((a, b) => a.position - b.position);
  if (new Set(slots.map((slot) => slot.slotId)).size !== slots.length) throw new Error("slot_id가 중복되었습니다.");
  if (slots.some((slot) => !Number.isInteger(slot.oddRoundNetStep))) {
    throw new Error("홀수 라운드 순변화 단계값은 정수여야 합니다.");
  }

  const ruleValues: Record<string, number> = {};
  for (const row of ruleRows) ruleValues[requireValue(row, "key")] = numberValue(row, "value");
  const requiredRuleKeys = [
    "field_width_m", "field_height_m", "initial_balls", "fixed_dt_s", "sub_steps", "launch_interval_s",
    "fixed_pin_rows", "fixed_pin_even_columns", "fixed_pin_odd_columns", "fixed_pin_radius_m",
    "fixed_pin_x_spacing_m", "fixed_pin_y_spacing_m", "fixed_pin_top_y_m", "fixed_pin_row_amplitude_m", "fixed_pin_row_period_s",
    "special_pin_wall_clearance_m", "special_pin_collision_padding_m", "slot_horizontal_inset_m", "score_slot_bottom_margin_m", "score_slot_height_m",
    "launcher_vertical_inset_m", "stuck_grace_s", "stuck_speed_threshold_mps", "stuck_progress_threshold_m",
    "stuck_detection_s", "unstick_vertical_speed_mps", "unstick_cooldown_s", "max_unstick_attempts"
  ] as const satisfies ReadonlyArray<keyof GameRules>;
  const rules = {} as GameRules;
  for (const key of requiredRuleKeys) {
    if (!(key in ruleValues)) throw new Error(`game_rules.csv에 ${key}가 없습니다.`);
    rules[key] = ruleValues[key];
  }
  const scoreSlotTopY = rules.score_slot_bottom_margin_m + rules.score_slot_height_m;
  const bottomRowY = rules.fixed_pin_top_y_m - (rules.fixed_pin_rows - 1) * rules.fixed_pin_y_spacing_m;
  const expectedBottomRowY = scoreSlotTopY + rules.fixed_pin_y_spacing_m / 2;
  if (Math.abs(bottomRowY - expectedBottomRowY) > 0.01) {
    throw new Error("최하단 고정 핀과 점수칸의 간격은 배치 선분 간격과 같아야 합니다.");
  }

  return { ball, pins, upgrades, slots, rules };
}

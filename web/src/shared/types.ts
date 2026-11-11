export type Phase = "INIT" | "PREPARE" | "SIMULATE" | "SETTLE" | "GAME_OVER";
export type PinType = "elastic" | "absorber" | "slope" | "rotor";
export type SlotKind = "reward" | "loss";
export type ControlMode = "upper_expand" | "center_expand";
export type SimulationSpeed = 1 | 2 | 4 | 8;

export interface BallConfig {
  id: string;
  radiusM: number;
  density: number;
  friction: number;
  restitution: number;
}

export interface PinDefinition {
  pinType: PinType;
  purchaseCost: number;
  shape: "circle" | "capsule" | "rotor";
  defaultSizeM: number;
  defaultThicknessM: number;
  defaultRestitution: number;
  defaultFriction: number;
}

export interface UpgradeRange {
  pinType: PinType;
  level: number;
  cost: number;
  paramKey: string;
  minValue: number;
  maxValue: number;
  unit: string;
  controlMode: ControlMode;
  anchorValue?: number;
  stepValue: number;
  initialValue?: number;
}

export interface SlotDefinition {
  slotId: string;
  position: number;
  kind: SlotKind;
  value: number;
  roundScaled: boolean;
  oddRoundNetStep: number;
}

export interface GameRules {
  field_width_m: number;
  field_height_m: number;
  initial_balls: number;
  fixed_dt_s: number;
  sub_steps: number;
  launch_interval_s: number;
  fixed_pin_rows: number;
  fixed_pin_even_columns: number;
  fixed_pin_odd_columns: number;
  fixed_pin_radius_m: number;
  fixed_pin_x_spacing_m: number;
  fixed_pin_y_spacing_m: number;
  fixed_pin_top_y_m: number;
  fixed_pin_row_amplitude_m: number;
  fixed_pin_row_period_s: number;
  special_pin_wall_clearance_m: number;
  special_pin_collision_padding_m: number;
  slot_horizontal_inset_m: number;
  score_slot_bottom_margin_m: number;
  score_slot_height_m: number;
  launcher_vertical_inset_m: number;
  stuck_grace_s: number;
  stuck_speed_threshold_mps: number;
  stuck_progress_threshold_m: number;
  stuck_detection_s: number;
  unstick_vertical_speed_mps: number;
  unstick_cooldown_s: number;
  max_unstick_attempts: number;
}

export interface GameConfig {
  ball: BallConfig;
  pins: Record<PinType, PinDefinition>;
  upgrades: UpgradeRange[];
  slots: SlotDefinition[];
  rules: GameRules;
}

export interface PinSnapshot {
  id: number;
  type: PinType;
  level: number;
  x: number;
  y: number;
  angle: number;
  installationAngle?: number;
  parameters: Record<string, number>;
}

export interface BallSnapshot {
  id: number;
  x: number;
  y: number;
  angle: number;
}

export interface BasePinRowSnapshot {
  rowIndex: number;
  y: number;
  startX: number;
  spacingX: number;
  columns: number;
  offsetX: number;
  radius: number;
}

export interface PlacementRailSnapshot {
  railIndex: number;
  y: number;
  startX: number;
  endX: number;
}

export interface SettlementSnapshot {
  round: number;
  launchedCount: number;
  settledCount: number;
  slotHitCounts: number[];
  netBallDelta: number;
  balance: number;
  finalized: boolean;
}

export interface GameSnapshot {
  phase: Phase;
  round: number;
  balance: number;
  launchCount: number;
  launcherAngle: number;
  simulationSpeed: SimulationSpeed;
  settlement: SettlementSnapshot;
  basePinRows: BasePinRowSnapshot[];
  placementRails: PlacementRailSnapshot[];
  pins: PinSnapshot[];
  balls: BallSnapshot[];
}

export type GameEvent =
  | { type: "impact"; intensity: number }
  | { type: "ballSettled"; slotId: string; netDelta: number; shortfall?: number }
  | { type: "ballRecovered"; ballId: number; attempt: number; maxAttempts: number }
  | { type: "ballForcedSettled"; ballId: number; reason: "stuck" | "timeout" }
  | { type: "roundPrepared"; round: number }
  | { type: "gameOver" };

export type Command =
  | { type: "purchasePin"; pinType: PinType }
  | { type: "movePin"; pinId: number; x: number; y: number; angle: number }
  | { type: "upgradePin"; pinId: number }
  | { type: "setPinParameter"; pinId: number; paramKey: string; value: number }
  | { type: "setBallCount"; count: number }
  | { type: "setLauncherAngle"; angle: number }
  | { type: "setSimulationSpeed"; speed: SimulationSpeed }
  | { type: "startRound" }
  | { type: "restartGame" };

export type WorkerRequest =
  | { type: "init"; config: GameConfig }
  | { type: "command"; requestId: number; command: Command }
  | { type: "tick"; elapsedSeconds: number };

export type WorkerEvent =
  | { type: "ready"; snapshot: GameSnapshot }
  | { type: "tick"; snapshot: GameSnapshot; events: GameEvent[] }
  | { type: "commandResult"; requestId: number; ok: boolean; reason?: string; snapshot: GameSnapshot };

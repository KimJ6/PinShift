/// <reference lib="webworker" />
import Box2DFactory from "box2d3-wasm/compat";
import { consumeFixedSteps } from "../fixed-step";
import { closestFreePoint, createPlacementRails, isValidPlacement, maximumSpecialPinRadius, pinPlacementRadius, snapToPlacementRail, type PlacementBody } from "../placement";
import { roundScore, slotDelta, slotNetDelta } from "../scoring";
import type { BasePinRowSnapshot, Command, GameConfig, GameEvent, GameSnapshot, PinSnapshot, PinType, PlacementRailSnapshot, SimulationSpeed, SlotDefinition, WorkerEvent, WorkerRequest } from "../shared/types";

const CATEGORY_BALL = 0x0001;
const CATEGORY_FIXED = 0x0002;
const CATEGORY_SPECIAL = 0x0004;
const CATEGORY_ROTOR = 0x0008;
const CATEGORY_SENSOR = 0x0010;
const SLOT_USER_DATA_BASE = 100_000;

type RuntimePin = {
  id: number;
  type: PinType;
  level: number;
  x: number;
  y: number;
  angle: number;
  parameters: Record<string, number>;
  body: any;
  joint?: any;
  radius: number;
};
type RuntimeBall = {
  id: number;
  body: any;
  age: number;
  progressReferenceY: number;
  stuckElapsed: number;
  unstickCooldown: number;
  unstickAttempts: number;
};
type RuntimeBasePinRow = BasePinRowSnapshot & { body: any; direction: number };
type RuntimeSettlement = {
  round: number;
  launchedCount: number;
  settledCount: number;
  slotHitCounts: number[];
  startBalance: number;
  finalized: boolean;
};

class PhysicsGame {
  private b2: any;
  private world: any;
  private groundBody: any;
  private launcherBody: any;
  private config!: GameConfig;
  private phase: GameSnapshot["phase"] = "INIT";
  private round = 1;
  private balance = 0;
  private launchCount = 1;
  private launcherAngle = 0;
  private simulationSpeed: SimulationSpeed = 1;
  private nextPinId = 1;
  private nextBallId = 1;
  private accumulator = 0;
  private nextLaunchIn = 0;
  private pendingLaunches = 0;
  private basePinTime = 0;
  private pins = new Map<number, RuntimePin>();
  private balls = new Map<number, RuntimeBall>();
  private basePinRows: RuntimeBasePinRow[] = [];
  private placementRailsCache: PlacementRailSnapshot[] = [];
  private slotByPosition = new Map<number, SlotDefinition>();
  private settlement!: RuntimeSettlement;

  async initialize(config: GameConfig): Promise<void> {
    this.b2 = await Box2DFactory();
    this.config = config;
    this.balance = config.rules.initial_balls;
    this.launchCount = this.balance;
    this.settlement = this.createSettlement(this.round, this.balance);

    const worldDef = this.b2.b2DefaultWorldDef();
    worldDef.gravity.Set(0, -9.8);
    worldDef.enableSleep = true;
    worldDef.workerCount = 0;
    this.world = this.b2.b2CreateWorld(worldDef);
    worldDef.delete();
    this.b2.b2World_SetHitEventThreshold(this.world, 0.45);
    this.groundBody = this.createStaticBody(0, 0);
    this.createArena();
    this.createBasePins();
    this.placementRailsCache = createPlacementRails(this.basePinRows, this.config);
    this.slotByPosition = new Map(this.config.slots.map((slot) => [slot.position, slot]));
    this.createSlots();
    this.createLauncher();
    this.phase = "PREPARE";
  }

  command(command: Command): { ok: boolean; reason?: string } {
    switch (command.type) {
      case "purchasePin":
        return this.phase === "PREPARE" ? this.purchasePin(command.pinType) : { ok: false, reason: "시뮬레이션 중에는 핀을 편집할 수 없습니다." };
      case "movePin":
        return this.phase === "PREPARE" ? this.movePin(command.pinId, command.x, command.y, command.angle) : { ok: false, reason: "시뮬레이션 중에는 핀을 편집할 수 없습니다." };
      case "upgradePin":
        return this.phase === "PREPARE" ? this.upgradePin(command.pinId) : { ok: false, reason: "시뮬레이션 중에는 핀을 편집할 수 없습니다." };
      case "setPinParameter":
        return this.phase === "PREPARE" ? this.setPinParameter(command.pinId, command.paramKey, command.value) : { ok: false, reason: "시뮬레이션 중에는 핀을 편집할 수 없습니다." };
      case "setBallCount":
        if (this.phase !== "PREPARE") return { ok: false, reason: "투입량은 준비 단계에서만 변경할 수 있습니다." };
        if (!Number.isInteger(command.count) || command.count < 1 || command.count > this.balance) return { ok: false, reason: "투입 수는 1 이상 보유 ● 수 이하이어야 합니다." };
        this.launchCount = command.count;
        return { ok: true };
      case "setLauncherAngle":
        if (this.phase !== "PREPARE" && this.phase !== "SIMULATE") return { ok: false, reason: "발사대는 준비 또는 시뮬레이션 단계에서만 조절할 수 있습니다." };
        if (!Number.isFinite(command.angle)) return { ok: false, reason: "발사대 각도가 유효하지 않습니다." };
        this.launcherAngle = normalizeAngle(command.angle);
        this.setLauncherTransform();
        return { ok: true };
      case "setSimulationSpeed":
        if (command.speed !== 1 && command.speed !== 2 && command.speed !== 4 && command.speed !== 8) return { ok: false, reason: "지원하지 않는 시뮬레이션 속도입니다." };
        this.simulationSpeed = command.speed;
        return { ok: true };
      case "startRound": return this.startRound();
      case "restartGame": return this.phase === "GAME_OVER" ? this.restartGame() : { ok: false, reason: "게임 오버 상태에서만 새 게임을 시작할 수 있습니다." };
    }
  }

  tick(elapsedSeconds: number): GameEvent[] {
    const elapsed = Math.min(Math.max(0, elapsedSeconds), 0.05) * this.simulationSpeed;
    this.basePinTime += elapsed;
    this.updateBasePinRows();
    if (this.phase !== "SIMULATE") return [];
    const events: GameEvent[] = [];
    this.accumulator = Math.min(this.accumulator + elapsed, 0.25);
    const dt = this.config.rules.fixed_dt_s;
    this.accumulator = consumeFixedSteps(
      this.accumulator,
      dt,
      () => this.phase === "SIMULATE",
      (stepDt) => this.step(stepDt, events)
    );
    return events;
  }

  snapshot(): GameSnapshot {
    const pins: PinSnapshot[] = [...this.pins.values()].map((runtimePin) => {
      let visualAngle = runtimePin.angle;
      if (runtimePin.type === "rotor") {
        const rotation = this.b2.b2Body_GetRotation(runtimePin.body);
        visualAngle = rotation.GetAngle();
        rotation.delete();
      }
      return {
        id: runtimePin.id,
        type: runtimePin.type,
        level: runtimePin.level,
        x: runtimePin.x,
        y: runtimePin.y,
        angle: visualAngle,
        installationAngle: runtimePin.angle,
        parameters: { ...runtimePin.parameters }
      };
    });
    const balls = [...this.balls.values()].map((ball) => {
      const position = this.b2.b2Body_GetPosition(ball.body);
      const rotation = this.b2.b2Body_GetRotation(ball.body);
      const result = { id: ball.id, x: position.x, y: position.y, angle: rotation.GetAngle() };
      position.delete();
      rotation.delete();
      return result;
    });
    const basePinRows = this.basePinRows.map(({ body: _body, direction: _direction, ...row }) => ({ ...row }));
    const placementRails = this.placementRailsCache;
    const settlement = {
      round: this.settlement.round,
      launchedCount: this.settlement.launchedCount,
      settledCount: this.settlement.settledCount,
      slotHitCounts: [...this.settlement.slotHitCounts],
      netBallDelta: this.balance - this.settlement.startBalance,
      balance: this.balance,
      finalized: this.settlement.finalized
    };
    return { phase: this.phase, round: this.round, balance: this.balance, launchCount: this.launchCount, launcherAngle: this.launcherAngle, simulationSpeed: this.simulationSpeed, settlement, basePinRows, placementRails, pins, balls };
  }

  private createArena(): void {
    const width = this.config.rules.field_width_m;
    const height = this.config.rules.field_height_m;
    this.createStaticBox(0.1, height / 2, 0.1, height / 2, CATEGORY_FIXED, CATEGORY_BALL);
    this.createStaticBox(width - 0.1, height / 2, 0.1, height / 2, CATEGORY_FIXED, CATEGORY_BALL);
    this.createStaticBox(width / 2, 0.12, width / 2, 0.12, CATEGORY_FIXED, CATEGORY_BALL);
  }

  private createBasePins(): void {
    const rules = this.config.rules;
    if (maximumSpecialPinRadius(this.config) + rules.fixed_pin_radius_m >= rules.fixed_pin_y_spacing_m / 2) {
      throw new Error("특수 핀 최대 반경에 비해 고정 핀 행 간격이 부족합니다.");
    }
    const width = rules.field_width_m;
    for (let rowIndex = 0; rowIndex < rules.fixed_pin_rows; rowIndex += 1) {
      const columns = rowIndex % 2 === 0 ? rules.fixed_pin_even_columns : rules.fixed_pin_odd_columns;
      const spacingX = rules.fixed_pin_x_spacing_m;
      const startX = (width - (columns - 1) * spacingX) / 2;
      const y = rules.fixed_pin_top_y_m - rowIndex * rules.fixed_pin_y_spacing_m;
      const bodyDef = this.b2.b2DefaultBodyDef();
      bodyDef.type = this.b2.b2BodyType.b2_kinematicBody;
      bodyDef.position.Set(width / 2, y);
      const body = this.b2.b2CreateBody(this.world, bodyDef);
      bodyDef.delete();
      const shapeDef = this.shapeDef(CATEGORY_FIXED, CATEGORY_BALL, 0.35, 0.28, 0);
      for (let column = 0; column < columns; column += 1) {
        const circle = new this.b2.b2Circle();
        circle.center.Set(startX + column * spacingX - width / 2, 0);
        circle.radius = rules.fixed_pin_radius_m;
        this.b2.b2CreateCircleShape(body, shapeDef, circle);
        circle.delete();
      }
      shapeDef.delete();
      this.basePinRows.push({ rowIndex, body, direction: rowIndex % 2 === 0 ? 1 : -1, y, startX, spacingX, columns, offsetX: 0, radius: rules.fixed_pin_radius_m });
    }
    this.updateBasePinRows();
  }

  private updateBasePinRows(): void {
    const rules = this.config.rules;
    const angularFrequency = 2 * Math.PI / rules.fixed_pin_row_period_s;
    const sine = Math.sin(angularFrequency * this.basePinTime);
    const cosine = Math.cos(angularFrequency * this.basePinTime);
    for (const row of this.basePinRows) {
      row.offsetX = row.direction * rules.fixed_pin_row_amplitude_m * sine;
      const velocityX = row.direction * rules.fixed_pin_row_amplitude_m * angularFrequency * cosine;
      const position = new this.b2.b2Vec2(rules.field_width_m / 2 + row.offsetX, row.y);
      const rotation = new this.b2.b2Rot();
      rotation.SetAngle(0);
      this.b2.b2Body_SetTransform(row.body, position, rotation);
      const velocity = new this.b2.b2Vec2(velocityX, 0);
      this.b2.b2Body_SetLinearVelocity(row.body, velocity);
      position.delete();
      rotation.delete();
      velocity.delete();
    }
  }

  private createSlots(): void {
    const inset = this.config.rules.slot_horizontal_inset_m;
    const width = (this.config.rules.field_width_m - inset * 2) / this.config.slots.length;
    const height = this.config.rules.score_slot_height_m;
    const centerY = this.config.rules.score_slot_bottom_margin_m + height / 2;
    for (const slot of this.config.slots) {
      const x = inset + width * (slot.position + 0.5);
      this.createSensorBox(x, centerY, width / 2 - 0.03, height / 2, SLOT_USER_DATA_BASE + slot.position);
    }
  }

  private createLauncher(): void {
    const bodyDef = this.b2.b2DefaultBodyDef();
    bodyDef.type = this.b2.b2BodyType.b2_staticBody;
    bodyDef.position.Set(this.config.rules.field_width_m / 2, this.launcherY());
    this.launcherBody = this.b2.b2CreateBody(this.world, bodyDef);
    bodyDef.delete();
    const shapeDef = this.shapeDef(CATEGORY_FIXED, CATEGORY_BALL, 0.35, 0.2, 0);
    const capsule = new this.b2.b2Capsule();
    capsule.center1.Set(-0.58, 0);
    capsule.center2.Set(0.58, 0);
    capsule.radius = 0.07;
    this.b2.b2CreateCapsuleShape(this.launcherBody, shapeDef, capsule);
    shapeDef.delete();
    capsule.delete();
    this.setLauncherTransform();
  }

  private setLauncherTransform(): void {
    const position = new this.b2.b2Vec2(this.config.rules.field_width_m / 2, this.launcherY());
    const rotation = new this.b2.b2Rot();
    rotation.SetAngle(this.launcherAngle);
    this.b2.b2Body_SetTransform(this.launcherBody, position, rotation);
    position.delete();
    rotation.delete();
  }

  private purchasePin(type: PinType): { ok: boolean; reason?: string } {
    const definition = this.config.pins[type];
    if (this.balance < definition.purchaseCost) return { ok: false, reason: "●이 부족합니다." };
    const candidate = this.findOpenPosition(this.defaultRadius(type));
    if (!candidate) return { ok: false, reason: "설치 가능한 빈 공간이 없습니다." };
    const pin: RuntimePin = {
      id: this.nextPinId++, type, level: 0, x: candidate.x, y: candidate.y, angle: 0,
      parameters: this.defaultParameters(type), body: undefined, radius: this.defaultRadius(type)
    };
    this.balance -= definition.purchaseCost;
    this.syncPrepareLaunchCount();
    this.createPinBody(pin);
    this.pins.set(pin.id, pin);
    return { ok: true };
  }

  private movePin(id: number, x: number, y: number, angle: number): { ok: boolean; reason?: string } {
    const pin = this.pins.get(id);
    if (!pin) return { ok: false, reason: "핀 ID가 유효하지 않습니다." };
    if (![x, y, angle].every(Number.isFinite)) return { ok: false, reason: "설치 값이 유효하지 않습니다." };
    const angleRange = this.parameterRange(pin, "angle");
    if (angleRange && !this.isAllowedValue(angle * 180 / Math.PI, angleRange)) return { ok: false, reason: "현재 레벨에서 허용되지 않는 설치 각도입니다." };
    const snapped = this.snapToPlacementRail(x, y, pin.radius, id);
    if (!snapped || !this.isPlacementValid(snapped.x, snapped.y, pin.radius, id)) return { ok: false, reason: "설치 레일에 빈 위치가 없습니다." };
    this.destroyPinBody(pin);
    pin.x = snapped.x;
    pin.y = snapped.y;
    pin.angle = angle;
    this.createPinBody(pin);
    return { ok: true };
  }

  private upgradePin(id: number): { ok: boolean; reason?: string } {
    const pin = this.pins.get(id);
    if (!pin) return { ok: false, reason: "핀 ID가 유효하지 않습니다." };
    const next = pin.level + 1;
    const costs = this.config.upgrades.filter((row) => row.pinType === pin.type && row.level === next).map((row) => row.cost);
    if (costs.length === 0) return { ok: false, reason: "최대 레벨입니다." };
    const cost = costs[0];
    if (this.balance < cost) return { ok: false, reason: "●이 부족합니다." };
    this.balance -= cost;
    this.syncPrepareLaunchCount();
    pin.level = next;
    return { ok: true };
  }

  private setPinParameter(id: number, key: string, value: number): { ok: boolean; reason?: string } {
    const pin = this.pins.get(id);
    if (!pin || !Number.isFinite(value)) return { ok: false, reason: "설정값이 유효하지 않습니다." };
    const range = this.parameterRange(pin, key);
    if (!range || !this.isAllowedValue(value, range)) return { ok: false, reason: "현재 레벨에서 허용되지 않는 값입니다." };
    const previousValue = pin.parameters[key];
    const previousRadius = pin.radius;
    this.destroyPinBody(pin);
    pin.parameters[key] = value;
    pin.radius = this.radiusFor(pin);
    if (!this.isPlacementValid(pin.x, pin.y, pin.radius, pin.id)) {
      pin.parameters[key] = previousValue;
      pin.radius = previousRadius;
      this.createPinBody(pin);
      return { ok: false, reason: "변경한 크기가 주변 형상과 겹칩니다." };
    }
    this.createPinBody(pin);
    return { ok: true };
  }

  private startRound(): { ok: boolean; reason?: string } {
    if (this.phase !== "PREPARE") return { ok: false, reason: "준비 단계가 아닙니다." };
    if (!Number.isInteger(this.launchCount) || this.launchCount < 1 || this.launchCount > this.balance) return { ok: false, reason: "투입 수가 유효하지 않습니다." };
    this.settlement = this.createSettlement(this.round, this.balance, this.launchCount);
    this.balance -= this.launchCount;
    this.pendingLaunches = this.launchCount;
    this.nextLaunchIn = 0;
    this.accumulator = 0;
    this.phase = "SIMULATE";
    return { ok: true };
  }

  private restartGame(): { ok: boolean } {
    for (const ball of this.balls.values()) this.b2.b2DestroyBody(ball.body);
    for (const pin of this.pins.values()) this.destroyPinBody(pin);
    this.balls.clear();
    this.pins.clear();
    this.round = 1;
    this.balance = this.config.rules.initial_balls;
    this.launchCount = this.balance;
    this.launcherAngle = 0;
    this.pendingLaunches = 0;
    this.nextLaunchIn = 0;
    this.accumulator = 0;
    this.nextPinId = 1;
    this.nextBallId = 1;
    this.basePinTime = 0;
    this.settlement = this.createSettlement(this.round, this.balance);
    this.updateBasePinRows();
    this.setLauncherTransform();
    this.phase = "PREPARE";
    return { ok: true };
  }

  private createSettlement(round: number, startBalance: number, launchedCount = 0): RuntimeSettlement {
    return {
      round,
      launchedCount,
      settledCount: 0,
      slotHitCounts: Array.from({ length: this.config.slots.length }, () => 0),
      startBalance,
      finalized: false
    };
  }

  private syncPrepareLaunchCount(): void {
    if (this.phase !== "PREPARE") return;
    this.launchCount = this.balance;
    if (!this.settlement.finalized && this.settlement.launchedCount === 0) {
      this.settlement.startBalance = this.balance;
    }
  }

  private step(dt: number, events: GameEvent[]): void {
    if (this.pendingLaunches > 0) {
      this.nextLaunchIn -= dt;
      if (this.nextLaunchIn <= 0) {
        this.spawnBall();
        this.pendingLaunches -= 1;
        this.nextLaunchIn = this.config.rules.launch_interval_s;
      }
    }
    this.b2.b2World_Step(this.world, dt, this.config.rules.sub_steps);
    this.consumeHitEvents(events);
    this.consumeSensorEvents(events);
    for (const ball of [...this.balls.values()]) {
      // Sensor begin events are the primary settlement path. This positional check
      // is a deterministic safety net for a ball resting on the physical floor after
      // crossing the thin sensor volume between fixed steps.
      const position = this.b2.b2Body_GetPosition(ball.body);
      const velocity = this.b2.b2Body_GetLinearVelocity(ball.body);
      const reachedFloor = position.y <= this.scoreSlotTopY();
      const x = position.x;
      const y = position.y;
      const speed = Math.hypot(velocity.x, velocity.y);
      position.delete();
      velocity.delete();
      if (reachedFloor) {
        this.settleBall(ball.id, this.slotAtX(x), events);
        continue;
      }
      ball.age += dt;
      this.updateStuckRecovery(ball, x, y, speed, dt, events);
      if (this.balls.has(ball.id) && ball.age >= 12) {
        events.push({ type: "ballForcedSettled", ballId: ball.id, reason: "timeout" });
        this.settleBall(ball.id, this.slotAtX(x), events);
      }
    }
    if (this.pendingLaunches === 0 && this.balls.size === 0) {
      this.phase = "SETTLE";
      this.settlement.finalized = true;
      this.launchCount = this.balance;
      if (this.balance <= 0) {
        this.phase = "GAME_OVER";
        events.push({ type: "gameOver" });
      } else {
        this.round += 1;
        this.phase = "PREPARE";
        events.push({ type: "roundPrepared", round: this.round });
      }
    }
  }

  private spawnBall(): void {
    const bodyDef = this.b2.b2DefaultBodyDef();
    bodyDef.type = this.b2.b2BodyType.b2_dynamicBody;
    // The guide is a visible, collidable launcher part. Spawn just below it so that a
    // horizontal (0 degree) guide cannot hold the ball indefinitely. Its angle still
    // controls the release offset and horizontal launch condition.
    bodyDef.position.Set(
      this.config.rules.field_width_m / 2 + Math.sin(this.launcherAngle) * 0.28,
      this.launcherY() - 0.47
    );
    bodyDef.linearVelocity.Set(Math.sin(this.launcherAngle) * 3.2, -0.75);
    bodyDef.isBullet = true;
    const id = this.nextBallId++;
    bodyDef.userData = id;
    const body = this.b2.b2CreateBody(this.world, bodyDef);
    bodyDef.delete();
    const shapeDef = this.shapeDef(CATEGORY_BALL, CATEGORY_FIXED | CATEGORY_SPECIAL | CATEGORY_ROTOR | CATEGORY_SENSOR, this.config.ball.restitution, this.config.ball.friction, id);
    shapeDef.density = this.config.ball.density;
    shapeDef.enableHitEvents = true;
    const circle = new this.b2.b2Circle();
    circle.center.Set(0, 0);
    circle.radius = this.config.ball.radiusM;
    this.b2.b2CreateCircleShape(body, shapeDef, circle);
    shapeDef.delete();
    circle.delete();
    this.balls.set(id, { id, body, age: 0, progressReferenceY: this.launcherY() - 0.47, stuckElapsed: 0, unstickCooldown: 0, unstickAttempts: 0 });
  }

  private consumeSensorEvents(events: GameEvent[]): void {
    const sensorEvents = this.b2.b2World_GetSensorEvents(this.world);
    for (let index = 0; index < sensorEvents.beginCount; index += 1) {
      const event = sensorEvents.GetBeginEvent(index);
      const sensorData = this.b2.b2Shape_GetUserData(event.sensorShapeId);
      const ballId = this.b2.b2Shape_GetUserData(event.visitorShapeId);
      if (sensorData >= SLOT_USER_DATA_BASE && this.balls.has(ballId)) {
        const slot = this.slotByPosition.get(sensorData - SLOT_USER_DATA_BASE);
        this.settleBall(ballId, slot, events);
      }
    }
    sensorEvents.delete();
  }

  private consumeHitEvents(events: GameEvent[]): void {
    const contactEvents = this.b2.b2World_GetContactEvents(this.world);
    for (let index = 0; index < contactEvents.hitCount; index += 1) {
      const hit = contactEvents.GetHitEvent(index);
      const first = this.b2.b2Shape_GetUserData(hit.shapeIdA);
      const second = this.b2.b2Shape_GetUserData(hit.shapeIdB);
      const ballId = this.balls.has(first) ? first : this.balls.has(second) ? second : undefined;
      const other = ballId === first ? second : first;
      if (ballId === undefined || other >= SLOT_USER_DATA_BASE) continue;
      const intensity = clamp((hit.approachSpeed - 0.45) / 7, 0, 1);
      if (intensity > 0) events.push({ type: "impact", intensity });
    }
    contactEvents.delete();
  }

  private updateStuckRecovery(ball: RuntimeBall, x: number, y: number, speed: number, dt: number, events: GameEvent[]): void {
    const rules = this.config.rules;
    ball.unstickCooldown = Math.max(0, ball.unstickCooldown - dt);
    const descendedEnough = ball.progressReferenceY - y >= rules.stuck_progress_threshold_m;
    if (speed > rules.stuck_speed_threshold_mps || descendedEnough) {
      ball.progressReferenceY = y;
      ball.stuckElapsed = 0;
      return;
    }
    if (ball.age < rules.stuck_grace_s || ball.unstickCooldown > 0) return;
    ball.stuckElapsed += dt;
    if (ball.stuckElapsed < rules.stuck_detection_s) return;
    if (ball.unstickAttempts >= rules.max_unstick_attempts) {
      events.push({ type: "ballForcedSettled", ballId: ball.id, reason: "stuck" });
      this.settleBall(ball.id, this.slotAtX(x), events);
      return;
    }
    const upwardVelocity = new this.b2.b2Vec2(0, rules.unstick_vertical_speed_mps);
    this.b2.b2Body_SetLinearVelocity(ball.body, upwardVelocity);
    upwardVelocity.delete();
    ball.unstickAttempts += 1;
    ball.unstickCooldown = rules.unstick_cooldown_s;
    ball.progressReferenceY = y;
    ball.stuckElapsed = 0;
    events.push({ type: "ballRecovered", ballId: ball.id, attempt: ball.unstickAttempts, maxAttempts: rules.max_unstick_attempts });
  }

  private settleBall(id: number, slot: SlotDefinition | undefined, events: GameEvent[]): void {
    const ball = this.balls.get(id);
    if (!ball) return;
    this.balls.delete(id);
    this.b2.b2DestroyBody(ball.body);
    this.settlement.settledCount += 1;
    if (!slot) {
      this.applyLoss(events, "미정산");
      return;
    }
    this.settlement.slotHitCounts[slot.position] = (this.settlement.slotHitCounts[slot.position] ?? 0) + 1;
    if (slot.kind === "reward") {
      const reward = slotDelta(slot, this.round);
      this.balance += reward;
      events.push({ type: "ballSettled", slotId: slot.slotId, netDelta: slotNetDelta(slot, this.round) });
    } else {
      this.applyLoss(events, slot.slotId);
    }
  }

  private applyLoss(events: GameEvent[], slotId: string): void {
    const totalLoss = roundScore(this.round);
    const extraLoss = Math.max(0, totalLoss - 1);
    const paid = Math.min(this.balance, extraLoss);
    this.balance -= paid;
    const shortfall = extraLoss - paid;
    events.push({ type: "ballSettled", slotId, netDelta: -totalLoss, shortfall: shortfall || undefined });
  }

  private slotAtX(x: number): SlotDefinition {
    const inset = this.config.rules.slot_horizontal_inset_m;
    const slotWidth = (this.config.rules.field_width_m - inset * 2) / this.config.slots.length;
    const position = clamp(Math.floor((x - inset) / slotWidth), 0, this.config.slots.length - 1);
    return this.slotByPosition.get(position) ?? this.config.slots[0];
  }

  private createPinBody(pin: RuntimePin): void {
    const isRotor = pin.type === "rotor";
    const bodyDef = this.b2.b2DefaultBodyDef();
    bodyDef.type = isRotor ? this.b2.b2BodyType.b2_dynamicBody : this.b2.b2BodyType.b2_staticBody;
    bodyDef.position.Set(pin.x, pin.y);
    const rotation = new this.b2.b2Rot();
    rotation.SetAngle(pin.angle);
    bodyDef.rotation = rotation;
    if (isRotor) bodyDef.angularDamping = 0.15;
    pin.body = this.b2.b2CreateBody(this.world, bodyDef);
    bodyDef.delete();
    rotation.delete();

    const category = isRotor ? CATEGORY_ROTOR : CATEGORY_SPECIAL;
    const shapeDef = this.shapeDef(category, CATEGORY_BALL, pin.parameters.restitution ?? this.config.pins[pin.type].defaultRestitution, pin.parameters.friction ?? this.config.pins[pin.type].defaultFriction, 0);
    if (isRotor) shapeDef.density = 3;
    if (pin.type !== "rotor") {
      const capsule = new this.b2.b2Capsule();
      capsule.center1.Set(-pin.parameters.length / 2, 0);
      capsule.center2.Set(pin.parameters.length / 2, 0);
      capsule.radius = pin.parameters.thickness;
      this.b2.b2CreateCapsuleShape(pin.body, shapeDef, capsule);
      capsule.delete();
    } else {
      const polygon = this.b2.b2MakeBox(pin.parameters.half_length, 0.08);
      this.b2.b2CreatePolygonShape(pin.body, shapeDef, polygon);
      polygon.delete();
      const jointDef = this.b2.b2DefaultRevoluteJointDef();
      jointDef.base.bodyIdA = this.groundBody;
      jointDef.base.bodyIdB = pin.body;
      jointDef.base.localFrameA.p.Set(pin.x, pin.y);
      jointDef.base.localFrameB.p.Set(0, 0);
      jointDef.enableMotor = true;
      jointDef.motorSpeed = pin.parameters.motor_speed;
      jointDef.maxMotorTorque = pin.parameters.max_torque;
      pin.joint = this.b2.b2CreateRevoluteJoint(this.world, jointDef);
      jointDef.delete();
    }
    shapeDef.delete();
  }

  private destroyPinBody(pin: RuntimePin): void {
    if (pin.joint) {
      this.b2.b2DestroyJoint(pin.joint);
      pin.joint = undefined;
    }
    if (pin.body) this.b2.b2DestroyBody(pin.body);
  }

  private defaultParameters(type: PinType): Record<string, number> {
    const ranges = this.config.upgrades.filter((row) => row.pinType === type && row.level === 0 && row.paramKey !== "angle");
    const parameters = Object.fromEntries(ranges.map((row) => [row.paramKey, row.initialValue ?? (row.minValue + row.maxValue) / 2]));
    if (type !== "rotor") parameters.thickness = this.config.pins[type].defaultThicknessM;
    return parameters;
  }

  private parameterRange(pin: RuntimePin, key: string) {
    return this.config.upgrades.find((row) => row.pinType === pin.type && row.level === pin.level && row.paramKey === key);
  }

  private isAllowedValue(value: number, range: NonNullable<ReturnType<PhysicsGame["parameterRange"]>>): boolean {
    const epsilon = Math.max(1e-7, range.stepValue * 1e-5);
    if (value < range.minValue - epsilon || value > range.maxValue + epsilon) return false;
    const steps = (value - range.minValue) / range.stepValue;
    return Math.abs(steps - Math.round(steps)) <= epsilon;
  }

  private defaultRadius(type: PinType): number {
    return pinPlacementRadius({ type, parameters: this.defaultParameters(type) });
  }

  private radiusFor(pin: RuntimePin): number {
    return pinPlacementRadius(pin);
  }

  private findOpenPosition(radius: number): { x: number; y: number } | undefined {
    for (const rail of this.placementRails()) {
      const candidate = closestFreePoint(rail, (rail.startX + rail.endX) / 2, radius, this.placementBodies());
      if (candidate !== undefined && this.isPlacementValid(candidate, rail.y, radius)) return { x: candidate, y: rail.y };
    }
    return undefined;
  }

  private isPlacementValid(x: number, y: number, radius: number, ignoredId?: number): boolean {
    return isValidPlacement(this.config, this.placementRails(), { id: ignoredId ?? -1, x, y, radius }, this.placementBodies(), ignoredId);
  }

  private placementRails(): PlacementRailSnapshot[] {
    return this.placementRailsCache;
  }

  private snapToPlacementRail(x: number, y: number, radius: number, ignoredId?: number): { x: number; y: number } | undefined {
    return snapToPlacementRail(this.placementRails(), x, y, radius, this.placementBodies(), ignoredId, this.config.rules.special_pin_collision_padding_m);
  }

  private placementBodies(): PlacementBody[] {
    return [...this.pins.values()].map(({ id, x, y, radius }) => ({ id, x, y, radius }));
  }

  private launcherY(): number {
    return this.config.rules.field_height_m - this.config.rules.launcher_vertical_inset_m;
  }

  private scoreSlotTopY(): number {
    return this.config.rules.score_slot_bottom_margin_m + this.config.rules.score_slot_height_m;
  }

  private createStaticBody(x: number, y: number): any {
    const bodyDef = this.b2.b2DefaultBodyDef();
    bodyDef.type = this.b2.b2BodyType.b2_staticBody;
    bodyDef.position.Set(x, y);
    const body = this.b2.b2CreateBody(this.world, bodyDef);
    bodyDef.delete();
    return body;
  }

  private createStaticBox(x: number, y: number, halfWidth: number, halfHeight: number, category: number, mask: number): void {
    const body = this.createStaticBody(x, y);
    const shapeDef = this.shapeDef(category, mask, 0.1, 0.3, 0);
    const polygon = this.b2.b2MakeBox(halfWidth, halfHeight);
    this.b2.b2CreatePolygonShape(body, shapeDef, polygon);
    shapeDef.delete();
    polygon.delete();
  }

  private createSensorBox(x: number, y: number, halfWidth: number, halfHeight: number, userData: number): void {
    const body = this.createStaticBody(x, y);
    const shapeDef = this.shapeDef(CATEGORY_SENSOR, CATEGORY_BALL, 0, 0, userData);
    shapeDef.isSensor = true;
    shapeDef.enableSensorEvents = true;
    const polygon = this.b2.b2MakeBox(halfWidth, halfHeight);
    this.b2.b2CreatePolygonShape(body, shapeDef, polygon);
    shapeDef.delete();
    polygon.delete();
  }

  private shapeDef(category: number, mask: number, restitution: number, friction: number, userData: number): any {
    const definition = this.b2.b2DefaultShapeDef();
    definition.filter.categoryBits = category;
    definition.filter.maskBits = mask;
    definition.material.restitution = restitution;
    definition.material.friction = friction;
    definition.userData = userData;
    return definition;
  }
}

let game: PhysicsGame | undefined;
function post(message: WorkerEvent): void {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    game = new PhysicsGame();
    await game.initialize(message.config);
    post({ type: "ready", snapshot: game.snapshot() });
    return;
  }
  if (!game) return;
  if (message.type === "command") {
    const result = game.command(message.command);
    post({ type: "commandResult", requestId: message.requestId, ...result, snapshot: game.snapshot() });
    return;
  }
  if (message.type === "tick") {
    const events = game.tick(message.elapsedSeconds);
    post({ type: "tick", events, snapshot: game.snapshot() });
  }
};

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

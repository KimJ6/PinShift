import { loadGameConfig } from "./config";
import { formatDisplayBallAmount, formatDisplayCount, formatDisplayProgress, formatDisplaySignedBallAmount } from "./format";
import { GameRenderer } from "./game-renderer";
import { pinPlacementRadius, snapToPlacementRail as snapOnPlacementRail } from "./placement";
import { SoundEngine } from "./sound-engine";
import type { Command, GameConfig, GameEvent, GameSnapshot, PinSnapshot, PinType, SimulationSpeed, UpgradeRange, WorkerEvent } from "./shared/types";
import PhysicsWorker from "./worker/physics.worker?worker";
import "./styles.css";

const PIN_NAMES: Record<PinType, string> = { elastic: "탄성 핀", absorber: "흡수 핀", slope: "경사 핀", rotor: "회전 핀" };
const PIN_COLORS: Record<PinType, number> = { elastic: 0xffc857, absorber: 0x6fd3c0, slope: 0x95a7ff, rotor: 0xff7aa2 };
const PARAMETER_NAMES: Record<string, string> = {
  radius: "반지름", restitution: "반발계수", friction: "마찰계수", length: "길이",
  half_length: "반 길이", motor_speed: "회전 속도", max_torque: "최대 토크", angle: "설치 각도"
};

const shop = document.querySelector<HTMLDivElement>("#shop-list")!;
const digitButtons = [...document.querySelectorAll<HTMLButtonElement>(".digit-button")];
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>(".speed-button")];
const soundToggle = document.querySelector<HTMLButtonElement>("#sound-toggle")!;
const soundVolumeInput = document.querySelector<HTMLInputElement>("#sound-volume")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const status = document.querySelector<HTMLParagraphElement>("#status-message")!;
const roundValue = document.querySelector<HTMLElement>("#round-value")!;
const balanceValue = document.querySelector<HTMLElement>("#balance-value")!;
const phaseValue = document.querySelector<HTMLElement>("#phase-value")!;
const eventLog = document.querySelector<HTMLOListElement>("#event-log")!;
const settlementTitle = document.querySelector<HTMLElement>("#settlement-title")!;
const settlementState = document.querySelector<HTMLElement>("#settlement-state")!;
const slotSummary = document.querySelector<HTMLDivElement>("#slot-summary")!;
const settlementLaunched = document.querySelector<HTMLElement>("#settlement-launched")!;
const settlementNet = document.querySelector<HTMLElement>("#settlement-net")!;
const settlementBalance = document.querySelector<HTMLElement>("#settlement-balance")!;
const inspectorEmpty = document.querySelector<HTMLDivElement>("#inspector-empty")!;
const inspector = document.querySelector<HTMLDivElement>("#inspector")!;
const pinName = document.querySelector<HTMLParagraphElement>("#pin-name")!;
const pinLevel = document.querySelector<HTMLParagraphElement>("#pin-level")!;
const upgradeButton = document.querySelector<HTMLButtonElement>("#upgrade-button")!;
const parameterList = document.querySelector<HTMLDivElement>("#parameter-list")!;

let config: GameConfig;
let snapshot: GameSnapshot | undefined;
let selectedPinId: number | undefined;
let draggingPinId: number | undefined;
let dragPreview: { pinId: number; x: number; y: number } | undefined;
let requestId = 1;
let lastFrame = performance.now();
let pendingTickSeconds = 0;
let tickInFlight = false;
let workerReady = false;
let knownPinIds = new Set<number>();
const slotHitValues = new Map<number, HTMLElement>();

const worker = new PhysicsWorker();
let renderer!: GameRenderer;
const sound = new SoundEngine();
let soundVolume = Number(soundVolumeInput.value) / 100;
let lastAudibleSoundVolume = soundVolume;

worker.onmessage = (event: MessageEvent<WorkerEvent>) => receive(event.data);

try {
  config = await loadGameConfig();
  renderer = new GameRenderer();
  await renderer.initialize(document.querySelector<HTMLDivElement>("#canvas-host")!, config);
  registerCanvasInput();
  buildShop();
  buildSettlementSummary();
  worker.postMessage({ type: "init", config });
  requestAnimationFrame(frame);
} catch (error) {
  status.textContent = error instanceof Error ? error.message : "설정 파일을 불러오지 못했습니다.";
  status.classList.add("error");
}

function frame(now: number): void {
  const elapsedSeconds = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  pendingTickSeconds = Math.min(pendingTickSeconds + elapsedSeconds, 0.25);
  dispatchTick();
  requestAnimationFrame(frame);
}

function dispatchTick(): void {
  if (!workerReady || tickInFlight || pendingTickSeconds <= 0) return;
  const elapsedSeconds = Math.min(pendingTickSeconds, 0.05);
  pendingTickSeconds -= elapsedSeconds;
  tickInFlight = true;
  worker.postMessage({ type: "tick", elapsedSeconds });
}

function receive(message: WorkerEvent): void {
  if (message.type === "tick") {
    tickInFlight = false;
    const phaseChanged = snapshot?.phase !== message.snapshot.phase;
    for (const event of message.events) {
      if (event.type === "impact") sound.queueImpact(event.intensity);
      else appendEvent(formatGameEvent(event));
    }
    update(message.snapshot, phaseChanged);
    dispatchTick();
    return;
  }
  if (message.type === "commandResult") {
    status.textContent = message.ok ? "적용했습니다." : message.reason ?? "요청을 처리하지 못했습니다.";
    status.classList.toggle("error", !message.ok);
    update(message.snapshot, true);
    return;
  }
  workerReady = true;
  update(message.snapshot, true);
  if (message.type === "ready") status.textContent = "준비 단계입니다. 핀을 구매해 배치하세요.";
  dispatchTick();
}

function send(command: Command): void {
  worker.postMessage({ type: "command", requestId: requestId++, command });
}

function update(next: GameSnapshot, refreshPanels = true): void {
  const newlyPurchased = next.pins.filter((pin) => !knownPinIds.has(pin.id));
  if (newlyPurchased.length > 0) selectedPinId = newlyPurchased.at(-1)?.id;
  knownPinIds = new Set(next.pins.map((pin) => pin.id));
  if (selectedPinId !== undefined && !knownPinIds.has(selectedPinId)) selectedPinId = undefined;
  snapshot = next;
  setTextIfChanged(roundValue, formatDisplayCount(next.round));
  setAttributeIfChanged(roundValue, "aria-label", `라운드 ${next.round}`);
  setTextIfChanged(balanceValue, formatDisplayCount(next.balance));
  setAttributeIfChanged(balanceValue, "aria-label", `보유 볼 ${next.balance}개`);
  setTextIfChanged(phaseValue, phaseLabel(next.phase));
  if (phaseValue.dataset.phase !== next.phase) phaseValue.dataset.phase = next.phase;
  renderSimulationControls(next.simulationSpeed);
  const canRestart = next.phase === "GAME_OVER";
  setTextIfChanged(startButton, canRestart ? "새 게임 시작" : "라운드 시작");
  const startDisabled = !canRestart && (next.phase !== "PREPARE" || next.balance < 1);
  if (startButton.disabled !== startDisabled) startButton.disabled = startDisabled;
  if (refreshPanels) {
    renderLaunchDigits(next.launchCount, next.phase !== "PREPARE");
  }
  renderSettlementSummary(next);
  drawBoard(next);
  if (refreshPanels) drawInspector();
}

function buildShop(): void {
  const pinTypes = (Object.keys(config.pins) as PinType[])
    .map((type, index) => ({ type, index }))
    .sort((left, right) => config.pins[left.type].purchaseCost - config.pins[right.type].purchaseCost || left.index - right.index)
    .map(({ type }) => type);
  for (const type of pinTypes) {
    const definition = config.pins[type];
    const button = document.createElement("button");
    button.className = "shop-item";
    button.innerHTML = `<span class="swatch" style="background:#${PIN_COLORS[type].toString(16).padStart(6, "0")}"></span><span><strong>${PIN_NAMES[type]}</strong><small>${ballAmountMarkup(definition.purchaseCost)}</small></span>`;
    button.addEventListener("click", () => send({ type: "purchasePin", pinType: type }));
    shop.append(button);
  }
}

function buildSettlementSummary(): void {
  slotSummary.style.setProperty("--score-inset", `${config.rules.slot_horizontal_inset_m / config.rules.field_width_m * 100}%`);
  for (const slot of config.slots) {
    const cell = document.createElement("div");
    cell.className = "slot-hit";
    cell.setAttribute("aria-label", `${slot.slotId} 유입 공 수`);
    const value = document.createElement("strong");
    value.textContent = formatDisplayBallAmount(0);
    cell.append(value);
    slotHitValues.set(slot.position, value);
    slotSummary.append(cell);
  }
}

function renderSettlementSummary(state: GameSnapshot): void {
  const summary = state.settlement;
  setTextIfChanged(settlementTitle, `라운드 ${formatDisplayCount(summary.round)} 현황`);
  const settlementStateText = state.phase === "GAME_OVER"
    ? "게임 오버"
    : summary.finalized
      ? "정산 완료"
      : state.phase === "SIMULATE"
        ? `정산 ${formatDisplayProgress(summary.settledCount, summary.launchedCount)}`
        : "대기";
  setTextIfChanged(settlementState, settlementStateText);
  setTextIfChanged(settlementLaunched, formatDisplayBallAmount(summary.launchedCount));
  setAttributeIfChanged(settlementLaunched, "aria-label", `투입 볼 ${summary.launchedCount}개`);
  setTextIfChanged(settlementNet, formatDisplaySignedBallAmount(summary.netBallDelta));
  setAttributeIfChanged(settlementNet, "aria-label", `순변화 ${summary.netBallDelta >= 0 ? "+" : ""}${summary.netBallDelta}개`);
  setTextIfChanged(settlementBalance, formatDisplayBallAmount(summary.balance));
  setAttributeIfChanged(settlementBalance, "aria-label", `보유 볼 ${summary.balance}개`);
  for (const [position, value] of slotHitValues) {
    const count = summary.slotHitCounts[position] ?? 0;
    setTextIfChanged(value, formatDisplayBallAmount(count));
    setAttributeIfChanged(value, "aria-label", `유입 볼 ${count}개`);
  }
}

function drawBoard(state: GameSnapshot): void {
  renderer.render(state, selectedPinId, dragPreview);
}

function drawInspector(): void {
  const pin = snapshot?.pins.find((candidate) => candidate.id === selectedPinId);
  if (!pin || !snapshot) {
    inspector.hidden = true;
    inspectorEmpty.hidden = false;
    return;
  }
  inspector.hidden = false;
  inspectorEmpty.hidden = true;
  pinName.textContent = PIN_NAMES[pin.type];
  pinLevel.textContent = `레벨 ${formatDisplayCount(pin.level)}`;
  const nextCost = upgradeCost(pin);
  upgradeButton.disabled = snapshot.phase !== "PREPARE" || nextCost === undefined || snapshot.balance < nextCost;
  upgradeButton.innerHTML = nextCost === undefined
    ? "<span>최대 레벨</span>"
    : `<span>업그레이드</span><span class="upgrade-cost">${ballAmountMarkup(nextCost)}</span>`;
  upgradeButton.onclick = () => send({ type: "upgradePin", pinId: pin.id });
  parameterList.replaceChildren();
  const keys = [...new Set(config.upgrades.filter((row) => row.pinType === pin.type).map((row) => row.paramKey))];
  for (const key of keys) {
    const range = parameterRange(pin.type, pin.level, key);
    if (!range) continue;
    const value = key === "angle" ? (pin.installationAngle ?? pin.angle) * 180 / Math.PI : pin.parameters[key];
    if (value === undefined) continue;
    parameterList.append(createParameterControl(pin, key, value, range));
  }
}

function createParameterControl(pin: PinSnapshot, key: string, value: number, current: UpgradeRange): HTMLDivElement {
  const rows = controlRanges(pin.type, key);
  const next = parameterRange(pin.type, pin.level + 1, key);
  const minimum = Math.min(...rows.map((row) => row.minValue));
  const maximum = Math.max(...rows.map((row) => row.maxValue));
  const control = document.createElement("div");
  control.className = "parameter-control";

  const header = document.createElement("div");
  header.className = "parameter-header";
  const name = document.createElement("strong");
  name.textContent = PARAMETER_NAMES[key] ?? key;
  const valueText = document.createElement("output");
  valueText.textContent = formatControlValue(value, current);
  header.append(name, valueText);

  const track = document.createElement("div");
  track.className = "range-track";
  appendRangeSegment(track, "active", current.minValue, current.maxValue, minimum, maximum);
  if (next) {
    appendRangeSegment(track, "next", next.minValue, Math.min(next.maxValue, current.minValue), minimum, maximum);
    appendRangeSegment(track, "next", Math.max(next.minValue, current.maxValue), next.maxValue, minimum, maximum);
  }
  if (current.controlMode === "center_expand" && current.anchorValue !== undefined) {
    const anchor = document.createElement("span");
    anchor.className = "range-anchor";
    anchor.style.left = `${rangePercent(current.anchorValue, minimum, maximum)}%`;
    track.append(anchor);
  }

  const writable = current.maxValue - current.minValue > Number.EPSILON;
  if (writable) {
    const input = document.createElement("input");
    input.type = "range";
    input.className = "range-input";
    input.min = String(current.minValue);
    input.max = String(current.maxValue);
    input.step = String(current.stepValue);
    input.value = String(value);
    input.disabled = snapshot?.phase !== "PREPARE";
    input.style.left = `${rangePercent(current.minValue, minimum, maximum)}%`;
    input.style.width = `${rangePercent(current.maxValue, minimum, maximum) - rangePercent(current.minValue, minimum, maximum)}%`;
    input.setAttribute("aria-label", `${PARAMETER_NAMES[key] ?? key}: 현재 제어 범위 ${formatRange(current)}`);
    input.addEventListener("input", () => {
      valueText.textContent = formatControlValue(Number(input.value), current);
    });
    input.addEventListener("change", () => {
      const nextValue = Number(input.value);
      if (key === "angle") send({ type: "movePin", pinId: pin.id, x: pin.x, y: pin.y, angle: nextValue * Math.PI / 180 });
      else send({ type: "setPinParameter", pinId: pin.id, paramKey: key, value: nextValue });
    });
    track.append(input);
  } else {
    const fixed = document.createElement("span");
    fixed.className = "range-fixed";
    fixed.style.left = `${rangePercent(current.minValue, minimum, maximum)}%`;
    track.append(fixed);
  }

  const details = document.createElement("div");
  details.className = "range-details";
  const currentText = document.createElement("p");
  currentText.textContent = writable ? `현재 · ${formatRange(current)}` : `현재 · ${formatControlValue(current.minValue, current)}로 고정`;
  details.append(currentText);
  const nextText = document.createElement("p");
  nextText.className = next ? "next-range" : "max-range";
  nextText.textContent = next ? `다음 · Lv.${pin.level + 1} ${formatRange(next)} (${formatExpansion(current, next)})` : "최대 · 전체 범위가 해금되었습니다.";
  details.append(nextText);
  const maximumText = document.createElement("p");
  maximumText.textContent = `전체 · ${formatNumber(minimum, current)} ~ ${formatNumber(maximum, current)} ${unitLabel(current.unit)}`;
  details.append(maximumText);

  control.append(header, track, details);
  return control;
}

function appendRangeSegment(track: HTMLDivElement, kind: "active" | "next", start: number, end: number, minimum: number, maximum: number): void {
  if (end - start <= Number.EPSILON) return;
  const segment = document.createElement("span");
  segment.className = `range-segment ${kind}`;
  segment.style.left = `${rangePercent(start, minimum, maximum)}%`;
  segment.style.width = `${rangePercent(end, minimum, maximum) - rangePercent(start, minimum, maximum)}%`;
  track.append(segment);
}

function controlRanges(type: PinType, key: string): UpgradeRange[] {
  return config.upgrades.filter((row) => row.pinType === type && row.paramKey === key).sort((a, b) => a.level - b.level);
}

function rangePercent(value: number, minimum: number, maximum: number): number {
  return maximum - minimum <= Number.EPSILON ? 0 : clamp((value - minimum) / (maximum - minimum) * 100, 0, 100);
}

function formatControlValue(value: number, range: UpgradeRange): string {
  return `${formatNumber(value, range)} ${unitLabel(range.unit)}`;
}

function formatRange(range: UpgradeRange): string {
  return `${formatNumber(range.minValue, range)} ~ ${formatNumber(range.maxValue, range)} ${unitLabel(range.unit)}`;
}

function formatNumber(value: number, range: UpgradeRange): string {
  const decimals = range.unit === "deg" ? 0 : range.stepValue < 0.1 ? 2 : 1;
  return value.toFixed(decimals);
}

function unitLabel(unit: string): string {
  return ({ m: "m", ratio: "", deg: "°", rad_s: "rad/s", Nm: "Nm" })[unit] ?? unit;
}

function formatExpansion(current: UpgradeRange, next: UpgradeRange): string {
  if (current.controlMode === "center_expand") {
    const left = Math.max(0, current.minValue - next.minValue);
    const right = Math.max(0, next.maxValue - current.maxValue);
    return `좌측 -${formatNumber(left, current)} / 우측 +${formatNumber(right, current)} ${unitLabel(current.unit)}`;
  }
  const lower = Math.max(0, current.minValue - next.minValue);
  const upper = Math.max(0, next.maxValue - current.maxValue);
  const parts = [lower > 0 ? `하한 -${formatNumber(lower, current)}` : "", upper > 0 ? `상한 +${formatNumber(upper, current)}` : ""].filter(Boolean);
  return `${parts.join(", ")} ${unitLabel(current.unit)}`.trim();
}

function parameterRange(type: PinType, level: number, key: string): UpgradeRange | undefined {
  return config.upgrades.find((row) => row.pinType === type && row.level === level && row.paramKey === key);
}

function upgradeCost(pin: PinSnapshot): number | undefined {
  return config.upgrades.find((row) => row.pinType === pin.type && row.level === pin.level + 1)?.cost;
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function phaseLabel(phase: GameSnapshot["phase"]): string { return ({ INIT: "초기화", PREPARE: "준비", SIMULATE: "진행", SETTLE: "정산", GAME_OVER: "게임 오버" })[phase]; }

function appendEvent(message: string): void {
  eventLog.classList.remove("is-empty");
  eventLog.querySelector("#event-log-empty")?.remove();
  const item = document.createElement("li");
  item.textContent = message;
  eventLog.prepend(item);
  while (eventLog.children.length > 6) eventLog.lastElementChild?.remove();
}

function clearEventLog(): void {
  const empty = document.createElement("li");
  empty.id = "event-log-empty";
  empty.className = "event-log-empty";
  empty.innerHTML = "<span>기록</span><span>아직 정산 기록이 없습니다.<br />라운드를 시작하면 공의 도착 결과가 기록됩니다.</span>";
  eventLog.replaceChildren(empty);
  eventLog.classList.add("is-empty");
}

function formatGameEvent(event: GameEvent): string {
  switch (event.type) {
    case "ballSettled":
      return `${event.slotId}: 순변화 ${formatDisplaySignedBallAmount(event.netDelta)}${event.shortfall ? ` (부족 ${formatDisplayBallAmount(event.shortfall)})` : ""}`;
    case "ballRecovered":
      return `● #${event.ballId}: 끼임 보정 · 수직 재도약 ${event.attempt}/${event.maxAttempts}`;
    case "ballForcedSettled":
      return `● #${event.ballId}: ${event.reason === "stuck" ? "끼임 보정" : "장기 체류 보정"} 정산`;
    case "roundPrepared":
      return `라운드 ${formatDisplayCount(event.round)} 준비 단계입니다.`;
    case "gameOver":
      return "●이 소진되어 게임 오버입니다.";
    case "impact":
      return "";
  }
}

function registerCanvasInput(): void {
renderer.canvas.addEventListener("wheel", (event) => {
  if (snapshot?.phase !== "PREPARE" && snapshot?.phase !== "SIMULATE") return;
  event.preventDefault();
  send({ type: "setLauncherAngle", angle: snapshot.launcherAngle + (event.deltaY > 0 ? -1 : 1) * Math.PI / 90 });
}, { passive: false });

renderer.canvas.addEventListener("pointerdown", (event) => {
  if (!snapshot || snapshot.phase !== "PREPARE") return;
  const { x, y } = renderer.worldPointFromPointer(event);
  const pin = [...snapshot.pins].reverse().find((candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= pinPlacementRadius(candidate) + 0.05);
  if (!pin) return;
  selectedPinId = pin.id;
  draggingPinId = pin.id;
  dragPreview = { pinId: pin.id, x: pin.x, y: pin.y };
  renderer.canvas.setPointerCapture(event.pointerId);
  drawInspector();
});
renderer.canvas.addEventListener("pointerup", (event) => {
  if (!draggingPinId || !snapshot) return;
  const pin = snapshot.pins.find((candidate) => candidate.id === draggingPinId);
  if (pin && dragPreview) send({ type: "movePin", pinId: pin.id, x: dragPreview.x, y: dragPreview.y, angle: pin.installationAngle ?? pin.angle });
  draggingPinId = undefined;
  dragPreview = undefined;
  if (renderer.canvas.hasPointerCapture(event.pointerId)) renderer.canvas.releasePointerCapture(event.pointerId);
  drawBoard(snapshot);
});
renderer.canvas.addEventListener("pointermove", (event) => {
  if (!draggingPinId || !snapshot || snapshot.phase !== "PREPARE") return;
  const pin = snapshot.pins.find((candidate) => candidate.id === draggingPinId);
  if (!pin) return;
  const { x, y } = renderer.worldPointFromPointer(event);
  dragPreview = snapToPlacementRail(pin, x, y, snapshot);
  drawBoard(snapshot);
});
renderer.canvas.addEventListener("pointercancel", () => {
  draggingPinId = undefined;
  dragPreview = undefined;
  if (snapshot) drawBoard(snapshot);
});
}

function snapToPlacementRail(pin: PinSnapshot, requestedX: number, requestedY: number, state: GameSnapshot): { pinId: number; x: number; y: number } {
  const snapped = snapOnPlacementRail(
    state.placementRails,
    requestedX,
    requestedY,
    pinPlacementRadius(pin),
    state.pins.map((other) => ({ id: other.id, x: other.x, y: other.y, radius: pinPlacementRadius(other) })),
    pin.id,
    config.rules.special_pin_collision_padding_m
  );
  return { pinId: pin.id, x: snapped?.x ?? pin.x, y: snapped?.y ?? pin.y };
}

function ballAmountMarkup(value: number): string {
  return `<span class="ball-amount" aria-label="볼 ${value}개">${formatDisplayBallAmount(value)}</span>`;
}

startButton.addEventListener("click", () => {
  void sound.resume();
  if (snapshot?.phase === "GAME_OVER") {
    clearEventLog();
    send({ type: "restartGame" });
  }
  else send({ type: "startRound" });
});

function renderSimulationControls(speed: SimulationSpeed): void {
  for (const button of speedButtons) {
    const selected = Number(button.dataset.speed) === speed;
    if (button.classList.contains("is-active") !== selected) button.classList.toggle("is-active", selected);
    setAttributeIfChanged(button, "aria-pressed", String(selected));
  }
}

function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function setAttributeIfChanged(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

for (const button of speedButtons) {
  button.addEventListener("click", () => {
    const speed = Number(button.dataset.speed);
    if (speed !== 1 && speed !== 2 && speed !== 4 && speed !== 8) return;
    void sound.resume();
    send({ type: "setSimulationSpeed", speed });
  });
}

soundToggle.addEventListener("click", () => {
  setSoundVolume(soundVolume > 0 ? 0 : lastAudibleSoundVolume);
  void sound.resume();
});

soundVolumeInput.addEventListener("input", () => {
  setSoundVolume(Number(soundVolumeInput.value) / 100);
  if (soundVolume > 0) void sound.resume();
});

function setSoundVolume(value: number): void {
  soundVolume = clamp(value, 0, 1);
  if (soundVolume > 0) lastAudibleSoundVolume = soundVolume;
  sound.setVolume(soundVolume);
  soundVolumeInput.value = String(Math.round(soundVolume * 100));
  const muted = soundVolume <= 0;
  const level = muted ? "muted" : soundVolume < 0.45 ? "low" : "high";
  soundToggle.dataset.volumeLevel = level;
  soundToggle.setAttribute("aria-pressed", String(!muted));
  soundToggle.setAttribute("aria-label", muted ? "효과음 켜기" : `효과음 음소거, 볼륨 ${Math.round(soundVolume * 100)}%`);
  soundToggle.title = muted ? "효과음 켜기" : "효과음 음소거";
}

function renderLaunchDigits(count: number, disabled: boolean): void {
  for (const button of digitButtons) {
    const place = Number(button.dataset.place);
    button.textContent = String(Math.floor(count / place) % 10);
    button.disabled = disabled;
  }
}

function adjustLaunchDigit(place: number, delta: number): void {
  if (!snapshot || snapshot.phase !== "PREPARE") return;
  const current = snapshot.launchCount;
  const digit = Math.floor(current / place) % 10;
  const nextDigit = (digit + delta + 10) % 10;
  const candidate = current - digit * place + nextDigit * place;
  const maximum = Math.min(snapshot.balance, 999);
  send({ type: "setBallCount", count: clamp(candidate, 1, maximum) });
}

for (const button of digitButtons) {
  const place = Number(button.dataset.place);
  button.addEventListener("click", () => adjustLaunchDigit(place, 1));
  button.addEventListener("wheel", (event) => {
    event.preventDefault();
    adjustLaunchDigit(place, event.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

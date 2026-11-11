import { Application, Container, Graphics, Text } from "pixi.js";
import { formatDisplayCount } from "./format";
import { slotNetDelta } from "./scoring";
import type { GameConfig, GameSnapshot, PinSnapshot, PinType } from "./shared/types";

export const VIEW_WIDTH = 528;
export const VIEW_HEIGHT = 704;
const SCALE = 44;

const PIN_COLORS: Record<PinType, number> = {
  elastic: 0xffc857,
  absorber: 0x6fd3c0,
  slope: 0x95a7ff,
  rotor: 0xff7aa2
};

export interface DragPreview {
  pinId: number;
  x: number;
  y: number;
}

export class GameRenderer {
  readonly app = new Application();
  private readonly board = new Container();
  private readonly staticField = new Graphics();
  private readonly movingRows = new Graphics();
  private readonly slotField = new Graphics();
  private readonly launcher = new Graphics();
  private readonly labels = new Container();
  private readonly pinLayer = new Container();
  private readonly ballLayer = new Container();
  private readonly slotLabels = new Map<number, Text>();
  private readonly pinGraphics = new Map<number, Graphics>();
  private readonly pinVisualKeys = new Map<number, string>();
  private readonly ballGraphics = new Map<number, Graphics>();
  private readonly launcherReadout = new Text({ text: "", style: { fill: 0xf4e8b5, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 } });
  private config!: GameConfig;
  private staticFieldDrawn = false;
  private renderedRound = Number.NaN;
  private renderedLauncherAngle = Number.NaN;

  async initialize(host: HTMLElement, config: GameConfig): Promise<void> {
    this.config = config;
    await this.app.init({
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      background: "#0c1224",
      antialias: true,
      resolution: Math.min(devicePixelRatio, 2),
      autoDensity: true
    });
    this.labels.addChild(this.launcherReadout);
    this.board.addChild(this.staticField, this.movingRows, this.slotField, this.launcher, this.labels, this.pinLayer, this.ballLayer);
    this.app.stage.addChild(this.board);
    host.append(this.app.canvas);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  worldPointFromPointer(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * VIEW_WIDTH / rect.width) / SCALE,
      y: (VIEW_HEIGHT - (event.clientY - rect.top) * VIEW_HEIGHT / rect.height) / SCALE
    };
  }

  render(state: GameSnapshot, selectedPinId?: number, dragPreview?: DragPreview): void {
    this.drawStaticField(state);
    this.drawMovingRows(state);
    this.drawLauncher(state);
    this.drawSlots(state);
    this.drawPins(state, selectedPinId, dragPreview);
    this.drawBalls(state);
  }

  private drawStaticField(state: GameSnapshot): void {
    if (this.staticFieldDrawn) return;
    this.staticField.clear();
    this.staticField.rect(0, 0, VIEW_WIDTH, VIEW_HEIGHT).fill(0x0c1224);
    const inset = this.xToPx(this.config.rules.slot_horizontal_inset_m);
    this.staticField.rect(inset, inset, VIEW_WIDTH - inset * 2, VIEW_HEIGHT - inset * 2).stroke({ color: 0x42506c, width: 2 });
    for (const rail of state.placementRails) {
      const y = this.yToPx(rail.y);
      for (let x = rail.startX; x < rail.endX; x += 0.32) {
        this.staticField.moveTo(this.xToPx(x), y).lineTo(this.xToPx(Math.min(x + 0.17, rail.endX)), y).stroke({ color: 0x6b9ed9, alpha: 0.58, width: 1 });
      }
      this.staticField.circle(this.xToPx(rail.startX), y, 2.5).fill(0x93b9ee);
      this.staticField.circle(this.xToPx(rail.endX), y, 2.5).fill(0x93b9ee);
    }
    this.staticFieldDrawn = true;
  }

  private drawMovingRows(state: GameSnapshot): void {
    this.movingRows.clear();
    for (const row of state.basePinRows) {
      for (let column = 0; column < row.columns; column += 1) {
        const x = row.startX + row.offsetX + column * row.spacingX;
        this.movingRows.circle(this.xToPx(x), this.yToPx(row.y), row.radius * SCALE).fill(0x536078).stroke({ color: 0x7d8baa, alpha: 0.45, width: 1 });
      }
    }
  }

  private drawLauncher(state: GameSnapshot): void {
    if (this.renderedLauncherAngle === state.launcherAngle) return;
    this.launcher.clear();
    const launcherX = this.xToPx(this.config.rules.field_width_m / 2);
    const launcherY = this.yToPx(this.launcherY());
    this.launcher.moveTo(launcherX - Math.cos(state.launcherAngle) * 0.58 * SCALE, launcherY + Math.sin(state.launcherAngle) * 0.58 * SCALE)
      .lineTo(launcherX + Math.cos(state.launcherAngle) * 0.58 * SCALE, launcherY - Math.sin(state.launcherAngle) * 0.58 * SCALE)
      .stroke({ color: 0xf4e8b5, width: 7, cap: "round" });
    this.launcherReadout.text = `발사 각도 ∠ ${Math.round(state.launcherAngle * 180 / Math.PI)}° · 휠 조절`;
    this.launcherReadout.position.set(launcherX - this.launcherReadout.width / 2, Math.max(8, launcherY - 29));
    this.renderedLauncherAngle = state.launcherAngle;
  }

  private drawSlots(state: GameSnapshot): void {
    if (this.renderedRound === state.round) return;
    this.slotField.clear();
    const inset = this.xToPx(this.config.rules.slot_horizontal_inset_m);
    const slotWidth = (VIEW_WIDTH - inset * 2) / this.config.slots.length;
    const slotY = this.yToPx(this.scoreSlotTopY());
    const slotHeight = this.config.rules.score_slot_height_m * SCALE;
    for (const slot of this.config.slots) {
      const delta = slotNetDelta(slot, state.round);
      const color = delta < 0 ? 0xdc5f74 : delta === 0 ? 0x566b8c : slot.roundScaled ? 0xf2b84b : 0x4fb894;
      const x = inset + slot.position * slotWidth + 2;
      this.slotField.rect(x, slotY, slotWidth - 4, slotHeight).fill({ color, alpha: 0.8 });
      let label = this.slotLabels.get(slot.position);
      if (!label) {
        label = new Text({ text: "", style: { fill: 0x101522, fontSize: 14, fontWeight: "700" } });
        this.slotLabels.set(slot.position, label);
        this.labels.addChild(label);
      }
      label.text = delta === 0 ? "0" : `${delta > 0 ? "+" : "-"}${formatDisplayCount(Math.abs(delta))}`;
      label.alpha = delta === 0 ? 0.62 : 1;
      label.position.set(x + (slotWidth - 4 - label.width) / 2, slotY + (slotHeight - label.height) / 2);
    }
    this.renderedRound = state.round;
  }

  private drawPins(state: GameSnapshot, selectedPinId?: number, dragPreview?: DragPreview): void {
    const activeIds = new Set<number>();
    for (const pin of state.pins) {
      activeIds.add(pin.id);
      const displayPin = dragPreview?.pinId === pin.id ? { ...pin, x: dragPreview.x, y: dragPreview.y } : pin;
      let graphic = this.pinGraphics.get(pin.id);
      if (!graphic) {
        graphic = new Graphics();
        this.pinGraphics.set(pin.id, graphic);
        this.pinLayer.addChild(graphic);
      }
      const selected = selectedPinId === pin.id;
      const visualKey = this.pinVisualKey(displayPin, selected);
      if (this.pinVisualKeys.get(pin.id) !== visualKey) {
        this.drawPinShape(graphic, displayPin, selected);
        this.pinVisualKeys.set(pin.id, visualKey);
      }
      graphic.position.set(this.xToPx(displayPin.x), this.yToPx(displayPin.y));
      graphic.rotation = -displayPin.angle;
    }
    this.removeStaleGraphics(this.pinGraphics, activeIds, (id) => this.pinVisualKeys.delete(id));
  }

  private drawPinShape(graphic: Graphics, pin: PinSnapshot, selected: boolean): void {
    graphic.clear();
    const color = PIN_COLORS[pin.type];
    const outline = { color: 0xffffff, alpha: selected ? 0.75 : 0.35, width: selected ? 3 : 1 };
    if (pin.type !== "rotor") {
      const length = pin.parameters.length * SCALE;
      const thickness = pin.parameters.thickness * SCALE * 2;
      graphic.roundRect(-length / 2, -thickness / 2, length, thickness, thickness / 2).fill(color).stroke(outline);
    } else {
      const length = pin.parameters.half_length * 2 * SCALE;
      graphic.roundRect(-length / 2, -0.08 * SCALE, length, 0.16 * SCALE, 0.08 * SCALE).fill(color).stroke(outline);
      graphic.circle(0, 0, 4).fill(0x17213b);
    }
  }

  private drawBalls(state: GameSnapshot): void {
    const activeIds = new Set<number>();
    for (const ball of state.balls) {
      activeIds.add(ball.id);
      let graphic = this.ballGraphics.get(ball.id);
      if (!graphic) {
        graphic = new Graphics();
        this.ballGraphics.set(ball.id, graphic);
        this.ballLayer.addChild(graphic);
        graphic.circle(0, 0, this.config.ball.radiusM * SCALE).fill(0xf5f7ff).stroke({ color: 0xa8b9e8, width: 1 });
      }
      graphic.position.set(this.xToPx(ball.x), this.yToPx(ball.y));
    }
    this.removeStaleGraphics(this.ballGraphics, activeIds);
  }

  private pinVisualKey(pin: PinSnapshot, selected: boolean): string {
    return `${pin.type}:${pin.parameters.length ?? ""}:${pin.parameters.thickness ?? ""}:${pin.parameters.half_length ?? ""}:${selected}`;
  }

  private removeStaleGraphics(graphics: Map<number, Graphics>, activeIds: Set<number>, onRemoved?: (id: number) => void): void {
    for (const [id, graphic] of graphics) {
      if (activeIds.has(id)) continue;
      graphic.destroy();
      graphics.delete(id);
      onRemoved?.(id);
    }
  }

  private xToPx(x: number): number { return x * SCALE; }
  private yToPx(y: number): number { return VIEW_HEIGHT - y * SCALE; }
  private launcherY(): number { return this.config.rules.field_height_m - this.config.rules.launcher_vertical_inset_m; }
  private scoreSlotTopY(): number { return this.config.rules.score_slot_bottom_margin_m + this.config.rules.score_slot_height_m; }
}

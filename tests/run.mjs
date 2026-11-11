import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });

try {
  const format = await server.ssrLoadModule("/web/src/format.ts");
  const scoring = await server.ssrLoadModule("/web/src/scoring.ts");
  const placement = await server.ssrLoadModule("/web/src/placement.ts");
  const fixedStep = await server.ssrLoadModule("/web/src/fixed-step.ts");

  assert.equal(format.formatDisplayCount(999), "999");
  assert.equal(format.formatDisplayCount(1_000), "1k");
  assert.equal(format.formatDisplayBallAmount(1_250), "● × 1.3k");
  assert.equal(format.formatDisplaySignedBallAmount(-9), "-● × 9");
  assert.equal(format.formatDisplayProgress(100, 999), "100 / 999");

  const reward = { slotId: "jackpot", position: 0, kind: "reward", value: 0, roundScaled: true, oddRoundNetStep: 0 };
  const loss = { slotId: "loss", position: 1, kind: "loss", value: 1, roundScaled: false, oddRoundNetStep: 0 };
  const oddRoundPenalty = { slotId: "safe", position: 2, kind: "reward", value: 1, roundScaled: false, oddRoundNetStep: -1 };
  assert.equal(scoring.slotDelta(reward, 3), 4);
  assert.equal(scoring.slotNetDelta(reward, 3), 3);
  assert.equal(scoring.slotDelta(loss, 3), -3);
  assert.equal(scoring.slotNetDelta(oddRoundPenalty, 2), 0);
  assert.equal(scoring.slotDelta(oddRoundPenalty, 3), 0);
  assert.equal(scoring.slotNetDelta(oddRoundPenalty, 3), -1);
  assert.equal(scoring.slotDelta(oddRoundPenalty, 5), -1);
  assert.equal(scoring.slotNetDelta(oddRoundPenalty, 5), -2);

  let phase = "SIMULATE";
  let executedSteps = 0;
  const remaining = fixedStep.consumeFixedSteps(0.08, 0.016, () => phase === "SIMULATE", () => {
    executedSteps += 1;
    phase = "PREPARE";
  });
  assert.equal(executedSteps, 1);
  assert.equal(remaining, 0.064);

  const config = {
    rules: { field_width_m: 12, field_height_m: 16, special_pin_wall_clearance_m: 0.2, special_pin_collision_padding_m: 0.04 },
    upgrades: [
      { pinType: "elastic", paramKey: "length", maxValue: 1 }, { pinType: "elastic", paramKey: "thickness", maxValue: 0.1 },
      { pinType: "absorber", paramKey: "length", maxValue: 1 }, { pinType: "absorber", paramKey: "thickness", maxValue: 0.1 },
      { pinType: "slope", paramKey: "length", maxValue: 1 }, { pinType: "slope", paramKey: "thickness", maxValue: 0.1 },
      { pinType: "rotor", paramKey: "half_length", maxValue: 0.5 }
    ]
  };
  const rows = [
    { rowIndex: 0, y: 10, startX: 1, spacingX: 2, columns: 5, offsetX: 0, radius: 0.15 },
    { rowIndex: 1, y: 8, startX: 2, spacingX: 2, columns: 4, offsetX: 0, radius: 0.15 }
  ];
  const rails = placement.createPlacementRails(rows, config);
  assert.equal(rails.length, 1);
  assert.equal(rails[0].y, 9);
  assert.deepEqual(placement.snapToPlacementRail(rails, -100, 9, 0.3, []), { x: rails[0].startX, y: 9 });
  const snapped = placement.snapToPlacementRail(rails, 6, 9, 0.3, []);
  assert.deepEqual(snapped, { x: 6, y: 9 });
  assert.equal(placement.isValidPlacement(config, rails, { id: 1, x: 6, y: 9, radius: 0.3 }, [], 1), true);
  assert.equal(placement.isValidPlacement(config, rails, { id: 1, x: 6, y: 9, radius: 0.3 }, [{ id: 2, x: 6.1, y: 9, radius: 0.3 }], 1), false);

  console.log("Rule tests passed.");
} finally {
  await server.close();
}

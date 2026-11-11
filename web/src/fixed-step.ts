export function consumeFixedSteps(
  accumulator: number,
  fixedDt: number,
  canStep: () => boolean,
  step: (dt: number) => void
): number {
  let remaining = accumulator;
  while (canStep() && remaining >= fixedDt) {
    remaining -= fixedDt;
    step(fixedDt);
  }
  return remaining;
}

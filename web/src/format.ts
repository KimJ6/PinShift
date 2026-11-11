export function formatBallAmount(value: number): string {
  return `● × ${value}`;
}

export function formatSignedBallAmount(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatBallAmount(Math.abs(value))}`;
}

export function formatDisplayCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return String(absolute);
  if (absolute < 10_000) return `${(absolute / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (absolute < 1_000_000) return `${Math.round(absolute / 1_000)}k`;
  return `${(absolute / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatDisplayBallAmount(value: number): string {
  return `● × ${formatDisplayCount(value)}`;
}

export function formatDisplaySignedBallAmount(value: number): string {
  return value === 0 ? "0" : `${value > 0 ? "+" : "-"}${formatDisplayBallAmount(Math.abs(value))}`;
}

export function formatDisplayProgress(current: number, total: number): string {
  return `${formatDisplayCount(current)} / ${formatDisplayCount(total)}`;
}

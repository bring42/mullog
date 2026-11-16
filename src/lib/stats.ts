/** Most common value; ties go to the larger value (e.g. the wider column count). */
export function mode(values: number[]): number {
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best ?? 0;
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

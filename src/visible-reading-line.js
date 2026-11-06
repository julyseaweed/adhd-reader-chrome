// Choose a visible reading cursor without confusing screen Y order with the
// document's column order. Flow identities come from the shared layout model.
export function chooseVisibleReadingLine(lines, {
  previousIndex = -1, viewport, direction = 1, y,
  boundsForLine = line => ({ left: line.x, top: line.y,
    right: line.right ?? line.x + line.width, bottom: line.bottom ?? line.y + line.height }),
} = {}) {
  const flowOf = line => line?.flowId ?? line?.regionId;
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    const bounds = boundsForLine(lines[index], index);
    if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
      || bounds.right <= viewport.left || bounds.left >= viewport.right
      || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
    candidates.push({ index, flow: flowOf(lines[index]),
      partial: bounds.top < viewport.top || bounds.bottom > viewport.bottom,
      distance: Number.isFinite(y) ? Math.abs((bounds.top + bounds.bottom) / 2 - y)
        : direction < 0 ? Math.abs(viewport.bottom - bounds.bottom) : Math.abs(bounds.top - viewport.top) });
  }
  if (!candidates.length) return -1;
  const nearest = values => values.reduce((best, value) => !best || Number(value.partial) < Number(best.partial)
    || value.partial === best.partial && (value.distance < best.distance - .1
      || direction < 0 && Math.abs(value.distance - best.distance) <= .1 && value.index > best.index) ? value : best, null).index;
  const previousFlow = flowOf(lines[previousIndex]);
  if (previousFlow != null) {
    const sameFlow = candidates.filter(value => value.flow === previousFlow);
    if (sameFlow.length) return nearest(sameFlow);
  }
  // Unclassified layouts retain geometric following; no columns are invented.
  if (!candidates.some(value => value.flow != null)) return nearest(candidates);
  let next = previousIndex >= 0 ? candidates.filter(value => direction < 0 ? value.index < previousIndex : value.index > previousIndex) : candidates;
  if (!next.length) next = candidates;
  const first = direction < 0 ? next.at(-1) : next[0];
  return first.flow == null ? first.index : nearest(next.filter(value => value.flow === first.flow));
}

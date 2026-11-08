const validPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
const padding = value => Number.isFinite(value) ? Math.max(0, value) : 0;

function expandedBounds(rect, tolerance) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return null;
  const bounds = {
    left: rect.x - tolerance, top: rect.y - tolerance,
    right: rect.x + rect.width + tolerance, bottom: rect.y + rect.height + tolerance,
  };
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function contains(bounds, point) {
  return point.x >= bounds.left && point.x <= bounds.right
    && point.y >= bounds.top && point.y <= bounds.bottom;
}

// Clip the segment parameter against both rectangle axes. This checks the
// complete gesture, including thin annotations between distant pointer events.
function intersectsSegment(bounds, start, end) {
  let enter = 0, leave = 1;
  for (const [axis, minimum, maximum] of [
    ['x', bounds.left, bounds.right], ['y', bounds.top, bounds.bottom],
  ]) {
    const origin = start[axis], delta = end[axis] - origin;
    if (!Number.isFinite(delta)) return false;
    if (delta === 0) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta, second = (maximum - origin) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return false;
  }
  return true;
}

function hits(annotation, tolerance, predicate) {
  return Array.isArray(annotation?.rects) && annotation.rects.some(rect => {
    const bounds = expandedBounds(rect, tolerance);
    return bounds !== null && predicate(bounds);
  });
}

/** Return the topmost annotation under a viewport point, or null. */
export function annotationAtPoint(annotations, point, tolerance = 3) {
  if (!Array.isArray(annotations) || !validPoint(point)) return null;
  const radius = padding(tolerance);
  for (let index = annotations.length - 1; index >= 0; index--) {
    const annotation = annotations[index];
    if (hits(annotation, radius, bounds => contains(bounds, point))) return annotation;
  }
  return null;
}

/** Return intersected annotations once each, from top to bottom. */
export function annotationsAlongSegment(annotations, start, end, tolerance = 3) {
  if (!Array.isArray(annotations) || !validPoint(start) || !validPoint(end)) return [];
  const radius = padding(tolerance), result = [], seen = new Set();
  for (let index = annotations.length - 1; index >= 0; index--) {
    const annotation = annotations[index];
    if (!annotation) continue;
    const identity = annotation.key ?? annotation;
    if (seen.has(identity) || !hits(annotation, radius, bounds => intersectsSegment(bounds, start, end))) continue;
    seen.add(identity);
    result.push(annotation);
  }
  return result;
}

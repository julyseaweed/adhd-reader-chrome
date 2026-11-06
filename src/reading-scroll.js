// A shared motion owner for browser and privileged Zotero reader windows.
// Only primitive offsets cross into the native reader; option dictionaries
// passed to content-window scrollTo can be silently ignored by Gecko.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const close = (a, b, tolerance = .5) => Math.abs(a.top - b.top) <= tolerance && Math.abs(a.left - b.left) <= tolerance;

export function readingScrollTarget(row, viewport, position, { center = false, direction = 0 } = {}) {
  let { top, left } = position;
  const height = row.bottom - row.top, width = row.right - row.left;
  const viewHeight = viewport.height ?? viewport.bottom - viewport.top;
  const viewWidth = viewport.width ?? viewport.right - viewport.left;
  const tolerance = .5;
  if (height > viewHeight - 16) {
    const distance = row.top - viewport.top - 8;
    if (Math.abs(distance) > tolerance) top += distance;
  }
  else {
    const middle = (row.top + row.bottom) / 2;
    // The host may round offsets, and transformed PDF boxes contain fractions.
    // A settled box touching its visibility boundary must not reverse on a
    // subpixel rounding difference during the next key or layout refresh.
    const above = middle < viewport.top + viewHeight * .34 - tolerance || row.top < viewport.top + 8 - tolerance;
    const below = middle > viewport.top + viewHeight * .64 + tolerance || row.bottom > viewport.bottom - 8 + tolerance;
    if (center || above || below) {
      // Let the eye travel through a central reading band, then gently return
      // with room to keep reading in that direction. Different trigger/landing
      // positions keep several rows stationary instead of pinning every row.
      // Use the midpoint for the band and the full box only for visibility:
      // a tall formula must not repeatedly trigger just because it is tall.
      // Reading order can jump upwards into the next column. Prefer the key's
      // reading direction over that spatial jump when leaving room to continue.
      const ratio = center || direction > 0 ? .43 : direction < 0 ? .55 : below ? .43 : .55;
      const anchor = clamp(viewHeight * ratio, height / 2 + 8, viewHeight - height / 2 - 8);
      top += middle - viewport.top - anchor;
    }
  }
  if (width <= viewWidth) {
    if (row.left < viewport.left) left += row.left - viewport.left;
    else if (row.right > viewport.right) left += row.right - viewport.right;
  }
  return { top, left };
}

export function createReadingScroll({
  read, write,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
  now = () => performance.now(),
  isValid = () => true,
  reducedMotion = () => false,
  onFrame = () => {},
  onFinish = () => {},
}) {
  let active = false, target = null, frame = null, generation = 0;
  let lastWritten = null, origin, previousTime = 0, elapsed = 0, duration = 0;
  let velocity = { top: 0, left: 0 }, initialVelocity = { top: 0, left: 0 };
  const stopFrame = () => { if (frame !== null) cancelFrame(frame); frame = null; };
  function cancel() {
    const running = active;
    generation++; stopFrame(); active = false; target = null;
    velocity = { top: 0, left: 0 };
    if (running) onFinish(false);
  }
  function finish() {
    stopFrame(); active = false; target = null; velocity = { top: 0, left: 0 };
    onFinish(true);
  }
  function apply(position) {
    write(position.top, position.left);
    // Hosts may round scroll offsets. Expected-position checks use actual values.
    lastWritten = { ...read() };
    onFrame(lastWritten);
  }
  function tick(owner) {
    if (!active || owner !== generation) return;
    frame = null;
    if (!isValid() || !close(read(), lastWritten, 1)) { cancel(); return; }
    const time = now();
    // PDF rasterization can stall the main thread. Resume from the displayed
    // position instead of consuming the entire animation in one late frame.
    elapsed += clamp(time - previousTime, 0, 48); previousTime = time;
    const t = clamp(elapsed / duration, 0, 1);
    const position = {};
    for (const axis of ['top', 'left']) {
      const distance = target[axis] - origin[axis], tangent = initialVelocity[axis] * duration;
      // Cubic Hermite, with continuous starting velocity and a stationary end.
      position[axis] = origin[axis] + distance * (3*t*t - 2*t*t*t) + tangent * (t*t*t - 2*t*t + t);
      velocity[axis] = (distance * (6*t - 6*t*t) + tangent * (3*t*t - 4*t + 1)) / duration;
    }
    apply(t === 1 ? target : position);
    if (owner !== generation || !active) return;
    if (t === 1) finish(); else frame = requestFrame(() => tick(owner));
  }
  function retarget(top, left) {
    if (!Number.isFinite(top) || !Number.isFinite(left)) { cancel(); return; }
    const destination = { top, left }, current = { ...read() };
    if (!isValid()) { cancel(); return; }
    if (active && close(current, lastWritten, 1) && close(destination, target, .01)) return;
    const continuing = active && close(current, lastWritten, 1);
    const priorVelocity = continuing ? velocity : { top: 0, left: 0 };
    const owner = ++generation;
    stopFrame(); origin = current; target = destination; lastWritten = current;
    if (reducedMotion() || close(current, destination)) {
      active = true;
      apply(destination);
      if (owner === generation && active) finish();
      return;
    }
    active = true; previousTime = now(); elapsed = 0;
    duration = clamp(280 + Math.max(Math.abs(top-current.top), Math.abs(left-current.left)) * .30, 300, 480);
    for (const axis of ['top', 'left']) {
      const distance = destination[axis] - current[axis];
      // Reversal starts without an old-direction tail; retargets in the same
      // direction preserve velocity without allowing overshoot.
      initialVelocity[axis] = Math.sign(distance) * clamp(Math.sign(distance) * priorVelocity[axis], 0, 3 * Math.abs(distance) / duration);
    }
    velocity = { ...initialVelocity };
    frame = requestFrame(() => tick(owner));
  }
  return {
    retarget, cancel,
    get active() { return active; },
    get target() { return target && { ...target }; },
    get lastWritten() { return lastWritten && { ...lastWritten }; },
    isExpectedPosition(position) { return lastWritten !== null && close(position, lastWritten, 1); },
  };
}

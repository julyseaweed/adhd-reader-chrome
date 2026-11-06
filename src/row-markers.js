import { readingFrameRect } from './reading-lines.js';

// Numbered instructions retain their row identity even when nesting introduces
// a larger indent than ordinary word spacing. Repeated markers establish the
// list track; proximity alone cannot join unrelated text across a page gutter.
export function rowMarkerLinks(lines) {
  const links = [];
  for (let markerIndex = 0; markerIndex < lines.length; markerIndex++) {
    const marker = lines[markerIndex];
    if (!/^\s*\d{1,3}[:.)]\s*$/.test(marker.text)) continue;
    const angle = marker.angle || 0;
    const sameDirection = row => Math.cos((row.angle || 0) - angle) > .995;
    const box = readingFrameRect(marker, angle);
    const em = marker.fontHeight || box.height;
    const track = lines.filter(row => row !== marker && sameDirection(row)
      && /^\s*\d{1,3}[:.)](?:\s|$)/.test(row.text)).map(row => readingFrameRect(row, angle))
      .filter(other => Math.abs(other.x - box.x) < em * .8 && Math.abs(other.y - box.y) < em * 24);
    if (track.length < 2) continue;
    const candidates = lines.map((row, hostIndex) => ({ row, hostIndex, box: readingFrameRect(row, angle) }))
      .filter(other => other.hostIndex !== markerIndex && sameDirection(other.row)
        && !/^\s*\d{1,3}[:.)](?:\s|$)/.test(other.row.text))
      .filter(other => {
        const localEm = Math.max(em, other.row.fontHeight || other.box.height);
        const gap = other.box.x - box.x - box.width;
        const cy = box.y + box.height / 2;
        return gap >= -localEm * .1 && gap <= localEm * 6
          && cy >= other.box.y && cy <= other.box.y + other.box.height
          && Math.abs(marker.baselineOffset - other.row.baselineOffset) <= localEm * .35;
      }).sort((a, b) => a.box.x - b.box.x);
    if (candidates.length) links.push({ markerIndex, hostIndex: candidates[0].hostIndex });
  }
  return links;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { focusRect, focusLineGroup, hitTestLine, readingLineAtPoint, anchoredLineIndex } from '../src/focus-geometry.js';

const row = (x, y, width = 200, height = 12, extra = {}) => ({ x, y, width, height, fontHeight: 12, angle: 0, ...extra });
const viewport = { width: 612, height: 792 };

test('a tight leading guide contains its text and stops in the whitespace before neighboring text', () => {
  const lines = [row(40, 86), row(45, 100), row(40, 114)];
  const rect = focusRect(lines, 1, 1, viewport);
  assert.ok(rect.y <= 100 && rect.y + rect.height >= 112);
  assert.ok(rect.y >= 98 && rect.y + rect.height <= 114);
  assert.ok(rect.x <= 45 && rect.x + rect.width >= 245);
});

test('neighbor boundaries belong to the same column, not the adjacent reading-order entry', () => {
  const lines = [row(40, 100, 180), row(40, 114, 180), row(330, 99, 190), row(330, 113, 190)];
  const rect = focusRect(lines, 0, 3, viewport);
  assert.ok(rect.x + rect.width < 330);
  assert.ok(rect.y <= 100 && rect.y + rect.height >= 126);
  assert.equal(hitTestLine(lines, 370, 118), 3);
});

test('overlapping text boxes do not make the first extracted row win every click', () => {
  const lines = [row(40, 100), row(40, 108)];
  assert.equal(hitTestLine(lines, 80, 111), 1);
  assert.equal(hitTestLine(lines, 80, 101), 0);
  assert.equal(hitTestLine(lines, 80, 110, 1), 1);
  // An unrelated transparent text span must not override the actual row hit.
  assert.equal(hitTestLine(lines, 80, 119, 0), 1);
});

test('rotated text clips the guide across the text direction and keeps click targets distinct', () => {
  const lines = [row(100, 40, 12, 200, { angle: Math.PI / 2 }), row(114, 40, 12, 200, { angle: Math.PI / 2 })];
  const rect = focusRect(lines, 0, 1, viewport);
  assert.ok(rect.x <= 100 && rect.x + rect.width >= 112);
  assert.ok(rect.x + rect.width <= 114);
  assert.equal(hitTestLine(lines, 120, 100), 1);
});

test('zoom anchors match original text items even if line segmentation changes', () => {
  const previous = { items: [{ index: 48 }, { index: 50 }] };
  const lines = [{ items: [{ index: 11 }] }, { items: [{ index: 30 }] }, { items: [{ index: 48 }, { index: 50 }] }];
  assert.equal(anchoredLineIndex(lines, previous, 0), 2);
  assert.equal(anchoredLineIndex(lines, null, Infinity), 2);
});

test('overlapping formulas can shrink padding but never clip the selected glyphs', () => {
  const lines = [row(40, 80, 200, 30), row(40, 100, 200, 20), row(40, 110, 200, 30)];
  const rect = focusRect(lines, 1, 1, viewport);
  assert.ok(rect.y <= 100);
  assert.ok(rect.y + rect.height >= 120);
});

test('reading hit testing ignores excluded text instead of snapping it to a body line', () => {
  const body = [row(80, 100, 300), row(80, 116, 300)];
  const sideLabel = row(18, 60, 15, 300, { angle: -Math.PI / 2 });
  const layout = { lines: body, excludedLines: [sideLabel], allLines: [...body, sideLabel] };
  assert.equal(readingLineAtPoint(layout, 25, 106), -1);
  assert.equal(readingLineAtPoint(layout, 120, 106), 0);
  assert.equal(readingLineAtPoint(layout, 120, 122), 1);
  assert.equal(layout.allLines.length, 3, 'reading navigation does not delete text available to the editor');
});

test('table cell whitespace is excluded while surrounding captions remain hit targets', () => {
  const lines = [row(40, 70, 400), row(40, 290, 400)];
  const table = { x: 40, y: 100, width: 400, height: 150 };
  const layout = { lines, excludedLines: [], excludedRegions: [table] };
  assert.equal(readingLineAtPoint(layout, 200, 180), -1);
  assert.equal(readingLineAtPoint(layout, 90, 75), 0);
  assert.equal(readingLineAtPoint(layout, 90, 295), 1);
  assert.equal(readingLineAtPoint({ lines, tableRegions: [table] }, 200, 180), -1);
});

test('each requested guide size from one to ten contains exactly that many rows, including both edges', () => {
  const lines = Array.from({ length: 25 }, (_, n) => row(40, 70 + n * 20));
  for (let count = 1; count <= 10; count++) for (const index of [0, 1, 12, 23, 24]) {
    const group = focusLineGroup(lines, index, count);
    assert.equal(group.length, count, `count ${count}, current row ${index}`);
    assert.ok(group.includes(lines[index]));
    const rectangle = focusRect(lines, index, count, viewport);
    const visiblyFocused = lines.filter(line => line.y + line.height / 2 >= rectangle.y
      && line.y + line.height / 2 <= rectangle.y + rectangle.height);
    assert.deepEqual(visiblyFocused, group, 'padding does not introduce an additional visible row');
    for (const line of group) {
      assert.ok(rectangle.y <= line.y && rectangle.y + rectangle.height >= line.y + line.height);
    }
  }
});

test('even-sized guides are biased forward and the window shifts rather than shrinking at run edges', () => {
  const lines = Array.from({ length: 12 }, (_, n) => row(40, 70 + n * 20));
  const indices = (current, count) => focusLineGroup(lines, current, count).map(line => lines.indexOf(line));
  assert.deepEqual(indices(5, 2), [5, 6]);
  assert.deepEqual(indices(5, 4), [4, 5, 6, 7]);
  assert.deepEqual(indices(5, 3), [4, 5, 6]);
  assert.deepEqual(indices(0, 4), [0, 1, 2, 3]);
  assert.deepEqual(indices(11, 4), [8, 9, 10, 11]);
});

test('a large requested guide stops at column transitions and does not jump through another orientation', () => {
  const left = Array.from({ length: 4 }, (_, n) => row(40, 100 + n * 20, 180));
  const right = Array.from({ length: 4 }, (_, n) => row(330, 100 + n * 20, 180));
  const lines = [...left, ...right];
  assert.deepEqual(focusLineGroup(lines, 3, 10), left);
  assert.deepEqual(focusLineGroup(lines, 4, 10), right);
  const mixed = [left[0], row(50, 110, 12, 100, { angle: Math.PI / 2 }), left[1]];
  assert.deepEqual(focusLineGroup(mixed, 0, 10), [left[0]], 'contiguous runs do not skip an intervening text direction');
});

test('a spanning title does not bridge a later column restart even if column bounds slightly overlap', () => {
  const title = row(40, 60, 500, 24, { fontHeight: 24 });
  const left = Array.from({ length: 4 }, (_, n) => row(40, 100 + n * 20, 280));
  const right = Array.from({ length: 4 }, (_, n) => row(300, 100 + n * 20, 220));
  const lines = [title, ...left, ...right];
  assert.deepEqual(focusLineGroup(lines, 4, 10), [title, ...left]);
  assert.deepEqual(focusLineGroup(lines, 5, 10), right);
});

test('exact grouping follows rotated reading progress and preserves every selected glyph', () => {
  const lines = Array.from({ length: 12 }, (_, n) => row(350 - n * 20, 50, 12, 200, { angle: Math.PI / 2 }));
  for (const current of [0, 5, 11]) {
    const group = focusLineGroup(lines, current, 4);
    assert.equal(group.length, 4);
    const rectangle = focusRect(lines, current, 4, viewport);
    for (const line of group) {
      assert.ok(rectangle.x <= line.x && rectangle.x + rectangle.width >= line.x + line.width);
      assert.ok(rectangle.y <= line.y && rectangle.y + rectangle.height >= line.y + line.height);
    }
  }
});

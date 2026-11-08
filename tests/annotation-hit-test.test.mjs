import test from 'node:test';
import assert from 'node:assert/strict';
import {annotationAtPoint, annotationsAlongSegment} from '../src/annotation-hit-test.js';

const rect = (x, y, width, height) => ({x, y, width, height});
const annotation = (key, rects, type = 'highlight') => ({key, type, rects});

test('point hits use viewport geometry and return the topmost overlapping annotation', () => {
  const back = annotation('back', [rect(10, 20, 80, 15)]);
  const front = annotation('front', [rect(30, 25, 20, 2)], 'underline');
  assert.equal(annotationAtPoint([back, front], {x: 40, y: 26}, 0), front);
  assert.equal(annotationAtPoint([back, front], {x: 15, y: 26}, 0), back);
  assert.equal(annotationAtPoint([front, back], {x: 40, y: 26}, 0), back);
});

test('each rectangle is tested independently so a multiline gap stays empty', () => {
  const multi = annotation('multi', [rect(10, 10, 80, 10), rect(10, 50, 35, 10)]);
  assert.equal(annotationAtPoint([multi], {x: 30, y: 35}), null);
  assert.equal(annotationAtPoint([multi], {x: 75, y: 55}), null);
  assert.deepEqual(annotationsAlongSegment([multi], {x: 0, y: 35}, {x: 100, y: 35}), []);
  assert.equal(annotationAtPoint([multi], {x: 20, y: 55}), multi);
});

test('point tolerance expands only real rectangles, includes edges and handles fractional pixels', () => {
  const value = annotation('a', [rect(10.25, 10.5, 5, .125)]);
  assert.equal(annotationAtPoint([value], {x: 7.25, y: 10.5}), value);
  assert.equal(annotationAtPoint([value], {x: 7.249, y: 10.5}), null);
  assert.equal(annotationAtPoint([value], {x: 15.25, y: 10.625}, 0), value);
  assert.equal(annotationAtPoint([value], {x: 9.25, y: 10.5}, .5), null);
});

test('a short gesture or a stationary gesture can hit without a minimum movement threshold', () => {
  const value = annotation('short', [rect(5, 5, 1, 1)]);
  assert.deepEqual(annotationsAlongSegment([value], {x: 4.99, y: 5.5}, {x: 5.01, y: 5.5}, 0), [value]);
  assert.deepEqual(annotationsAlongSegment([value], {x: 5.5, y: 5.5}, {x: 5.5, y: 5.5}, 0), [value]);
  assert.deepEqual(annotationsAlongSegment([value], {x: 4, y: 5.5}, {x: 4, y: 5.5}, 0), []);
});

test('fast vertical and horizontal gestures intersect subpixel lines between their endpoints', () => {
  const underline = annotation('line', [rect(10, 103.141, 100, .01)], 'underline');
  assert.deepEqual(annotationsAlongSegment([underline], {x: 50, y: -10000}, {x: 50, y: 10000}, 0), [underline]);
  assert.deepEqual(annotationsAlongSegment([underline], {x: 50, y: 10000}, {x: 50, y: -10000}, 0), [underline]);
  const narrow = annotation('narrow', [rect(123.456, 10, .001, 20)]);
  assert.deepEqual(annotationsAlongSegment([narrow], {x: -10000, y: 15}, {x: 10000, y: 15}, 0), [narrow]);
});

test('diagonal gestures test the line itself rather than its bounding rectangle', () => {
  const missed = annotation('missed', [rect(80, 10, 5, 5)]);
  const touched = annotation('corner', [rect(50, 50, 10, 10)]);
  assert.deepEqual(annotationsAlongSegment([missed, touched], {x: 0, y: 0}, {x: 100, y: 100}, 0), [touched]);
  assert.deepEqual(annotationsAlongSegment([touched], {x: 0, y: 100}, {x: 50, y: 50}, 0), [touched]);
  assert.deepEqual(annotationsAlongSegment([touched], {x: 0, y: 100}, {x: 49, y: 51}, 0), []);
});

test('segment results are ordered top to bottom, independent of travel direction', () => {
  const left = annotation('left', [rect(10, 10, 10, 10)]);
  const right = annotation('right', [rect(50, 10, 10, 10)]);
  const middle = annotation('middle', [rect(30, 10, 10, 10)]);
  for (const [start, end] of [[{x: 0, y: 15}, {x: 100, y: 15}], [{x: 100, y: 15}, {x: 0, y: 15}]]) {
    assert.deepEqual(annotationsAlongSegment([left, right, middle], start, end, 0), [middle, right, left]);
  }
});

test('a multiline annotation and repeated key produce only one result at their highest hit layer', () => {
  const multi = annotation('multi', [rect(10, 10, 20, 5), rect(10, 30, 20, 5)]);
  const topCopy = {...multi};
  const other = annotation('other', [rect(15, 20, 5, 5)]);
  assert.deepEqual(annotationsAlongSegment([multi, other, topCopy], {x: 17, y: 0}, {x: 17, y: 40}, 0), [topCopy, other]);
});

test('empty space, parallel misses and out-of-segment intersections do not hit', () => {
  const value = annotation('a', [rect(10, 10, 20, 20)]);
  assert.equal(annotationAtPoint([value], {x: 200, y: 200}), null);
  assert.deepEqual(annotationsAlongSegment([value], {x: 0, y: 6}, {x: 100, y: 6}), []);
  assert.deepEqual(annotationsAlongSegment([value], {x: 0, y: 20}, {x: 5, y: 20}, 0), []);
  assert.deepEqual(annotationsAlongSegment([value], {x: 40, y: 20}, {x: 50, y: 20}, 0), []);
  assert.deepEqual(annotationsAlongSegment([value], {x: 0, y: 7}, {x: 100, y: 7}), [value]);
});

test('invalid inputs and rectangles are ignored without hiding other valid geometry', () => {
  const valid = annotation('valid', [null, rect(NaN, 0, 10, 10), rect(0, 0, -1, 5), rect(0, 0, 0, 5),
    rect(0, 0, 5, Infinity), rect(5, 5, 5, 5)]);
  const values = [valid, null, {key: 'bad'}, {key: 'bad-rects', rects: 'invalid'}];
  assert.equal(annotationAtPoint(values, {x: 6, y: 6}), valid);
  assert.deepEqual(annotationsAlongSegment(values, {x: 0, y: 6}, {x: 20, y: 6}), [valid]);
  for (const point of [null, {}, {x: '6', y: 6}, {x: Infinity, y: 6}, {x: 6, y: NaN}]) {
    assert.equal(annotationAtPoint(values, point), null);
    assert.deepEqual(annotationsAlongSegment(values, point, {x: 6, y: 6}), []);
    assert.deepEqual(annotationsAlongSegment(values, {x: 6, y: 6}, point), []);
  }
  for (const input of [null, {}, 'invalid']) {
    assert.equal(annotationAtPoint(input, {x: 0, y: 0}), null);
    assert.deepEqual(annotationsAlongSegment(input, {x: 0, y: 0}, {x: 1, y: 1}), []);
  }
  for (const tolerance of [-2, NaN, Infinity]) assert.equal(annotationAtPoint([valid], {x: 4, y: 6}, tolerance), null);
});

test('input annotations, rectangles and pointer coordinates are never modified', () => {
  const a = Object.freeze(annotation('a', Object.freeze([Object.freeze(rect(1, 2, 3, 4))])));
  const b = Object.freeze(annotation('b', Object.freeze([Object.freeze(rect(8, 2, 3, 4))])));
  const values = Object.freeze([a, b]), start = Object.freeze({x: 0, y: 3}), end = Object.freeze({x: 20, y: 3});
  const before = JSON.stringify({values, start, end});
  assert.equal(annotationAtPoint(values, end), null);
  assert.deepEqual(annotationsAlongSegment(values, start, end), [b, a]);
  assert.equal(JSON.stringify({values, start, end}), before);
});

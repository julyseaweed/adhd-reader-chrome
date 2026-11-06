import test from 'node:test';
import assert from 'node:assert/strict';
import { createWordIndex, wordEndpoints } from '../src/word-selection.js';

function fixture(parts) {
  const nodes = parts.map(part => ({ nodeType: 3, textContent: part.text }));
  const items = parts.map(part => ({ str: part.text, transform: part.transform || [10, 0, 0, 10, part.x || 0, part.y || 100], width: part.width,
    height: 10, dir: part.dir || 'ltr', fontName: 'f', hasEOL: part.eol || false }));
  return { nodes, index: createWordIndex(nodes.map(firstChild => ({ firstChild })), { items, styles: { f: {} } }) };
}

test('word selection owns every drawing run including the separately drawn initial', () => {
  const { nodes, index } = fixture([{ text: 's', x: 0, width: 4 }, { text: 'to', x: 4, width: 7 }, { text: 'chastic', x: 11, width: 32 }]);
  for (let n = 0; n < nodes.length; n++) {
    const result = wordEndpoints(index, nodes[n], 1);
    assert.deepEqual(result, { start: { node: nodes[0], offset: 0 }, end: { node: nodes[2], offset: 7 } });
  }
});

test('a split initial beside a previous word keeps its own boundary', () => {
  const { nodes, index } = fixture([{ text: 'same s', x: 0, width: 28 }, { text: 'tochastic process', x: 28, width: 66 }]);
  assert.deepEqual(wordEndpoints(index, nodes[1], 3), { start: { node: nodes[0], offset: 5 }, end: { node: nodes[1], offset: 9 } });
});

test('whitespace, physical word gaps, newlines and columns are boundaries', () => {
  for (const variant of [
    [{ text: 'other ', x: 0, width: 24 }, { text: 'word', x: 24, width: 20 }],
    [{ text: 'other', x: 0, width: 20 }, { text: 'word', x: 24, width: 20 }],
    [{ text: 'other', x: 0, width: 20, eol: true }, { text: 'word', x: 20, width: 20 }],
    [{ text: 'other', x: 0, y: 115, width: 20 }, { text: 'word', x: 20, width: 20 }],
    [{ text: 'other', x: 0, width: 20 }, { text: 'word', x: 200, width: 20 }],
  ]) {
    const { nodes, index } = fixture(variant);
    assert.deepEqual(wordEndpoints(index, nodes[1], 2), { start: { node: nodes[1], offset: 0 }, end: { node: nodes[1], offset: 4 } });
  }
});

test('rotation does not turn contiguous letters into separate words', () => {
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const { nodes, index } = fixture([{ text: 's', transform: [10*c, 10*s, -10*s, 10*c, 30, 100], width: 4 },
      { text: 'tochastic', transform: [10*c, 10*s, -10*s, 10*c, 30+4*c, 100+4*s], width: 40 }]);
    assert.deepEqual(wordEndpoints(index, nodes[1], 2), { start: { node: nodes[0], offset: 0 }, end: { node: nodes[1], offset: 9 } });
  }
});

test('oppositely rotated runs cannot join just because their baselines overlap', () => {
  const { nodes, index } = fixture([{ text: 's', x: 30, width: 4 },
    { text: 'tochastic', transform: [-10, 0, 0, -10, 34, 100], width: 40 }]);
  assert.deepEqual(wordEndpoints(index, nodes[1], 2), { start: { node: nodes[1], offset: 0 }, end: { node: nodes[1], offset: 9 } });
});

test('Unicode words preserve combining marks and do not absorb adjacent punctuation', () => {
  const { nodes, index } = fixture([{ text: '(e\u0301tude),', width: 35 }]);
  assert.deepEqual(wordEndpoints(index, nodes[0], 4), { start: { node: nodes[0], offset: 1 }, end: { node: nodes[0], offset: 7 } });
  assert.equal(wordEndpoints(index, nodes[0], 0), null);
});

test('right-to-left drawing runs preserve logical Unicode word order', () => {
  const { nodes, index } = fixture([{ text: 'مرح', x: 20, width: 30, dir: 'rtl' }, { text: 'با', x: 0, width: 20, dir: 'rtl' }]);
  assert.deepEqual(wordEndpoints(index, nodes[1], 1), { start: { node: nodes[0], offset: 0 }, end: { node: nodes[1], offset: 2 } });
});

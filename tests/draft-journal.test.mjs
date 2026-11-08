import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftJournal } from '../src/draft-journal.js';

function fixture() {
  const values = new Map(); let sequence = 0;
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  return { values, storage, journal: createDraftJournal(storage, { createToken: () => `snapshot-${++sequence}` }) };
}
const draft = (id = 'document-a', updated = 100) => ({ id, name: `${id}.pdf`, bytes: new Uint8Array([37, 80, 68, 70]),
  annotations: [], deletedAnnotations: [], pageIndex: 1, lineIndex: 2,
  lineAnchor: { pageIndex: 1, lineIndex: 2, items: [{ index: 7 }], text: 'An original sentence.' }, savedSignature: '[]', updated });

test('a synchronous checkpoint restores the latest metadata before a database write', () => {
  const { journal } = fixture(), source = draft(), checkpoint = journal.checkpoint(source);
  const durable = { ...draft('document-a', 90), pageIndex: 0, lineIndex: 0 };
  const restored = journal.merge(durable);
  assert.equal(restored.pageIndex, 1); assert.equal(restored.lineIndex, 2);
  assert.deepEqual(restored.lineAnchor, source.lineAnchor);
  assert.equal(restored.bytes, durable.bytes, 'recovery keeps the original database PDF bytes');
  assert.equal(checkpoint._checkpointToken, 'snapshot-1');
});

test('the journal contains metadata only and snapshots do not change with live state', () => {
  const { values, journal } = fixture(), source = draft();
  const checkpoint = journal.checkpoint(source);
  source.lineAnchor.items[0].index = 99; source.annotations.push({ id: 'later' });
  const serialized = [...values.values()][0];
  assert.equal(serialized.includes('"bytes"'), false);
  assert.equal(journal.read(source.id).metadata.lineAnchor.items[0].index, 7);
  assert.deepEqual(checkpoint.annotations, []);
  assert.equal(checkpoint.bytes, source.bytes);
});

test('an older transaction cannot clear a newer pending edit, even at the same timestamp', () => {
  const { journal } = fixture(), first = journal.checkpoint(draft()), second = journal.checkpoint({ ...draft(), lineIndex: 8 });
  assert.equal(journal.acknowledge(first.id, first._checkpointToken), false);
  assert.equal(journal.merge(draft()).lineIndex, 8);
  assert.equal(journal.acknowledge(second.id, second._checkpointToken), true);
  assert.equal(journal.read(second.id), null);
});

test('different documents and unrelated local settings remain isolated', () => {
  const { storage, journal } = fixture(); storage.setItem('linea-settings', '{"theme":"dark"}');
  const first = journal.checkpoint(draft('first')), second = journal.checkpoint(draft('second', 200));
  journal.acknowledge(first.id, first._checkpointToken);
  assert.deepEqual(journal.entries().map(entry => entry.metadata.id), ['second']);
  assert.equal(journal.read(second.id).token, second._checkpointToken);
  assert.equal(storage.getItem('linea-settings'), '{"theme":"dark"}');
});

test('a stale journal never replaces newer durable metadata', () => {
  const { journal } = fixture(); journal.checkpoint(draft('document-a', 90));
  const durable = { ...draft('document-a', 200), lineIndex: 9 };
  assert.equal(journal.merge(durable), durable);
});

test('corrupt, wrong-document and invalid annotation journals leave durable data readable', () => {
  const { storage, journal } = fixture(), durable = draft();
  for (const raw of ['broken JSON', 'null', JSON.stringify({ version: 2, token: 'x', metadata: draft() }),
    JSON.stringify({ version: 1, token: 'x', metadata: { ...draft(), id: 'another' } }),
    JSON.stringify({ version: 1, token: 'x', metadata: { ...draft(), annotations: [{}] } })]) {
    storage.setItem('linea-draft:document-a', raw);
    assert.equal(journal.merge(durable), durable); assert.deepEqual(journal.entries(), []);
  }
});

test('quota failures propagate and preserve the previous recoverable snapshot', () => {
  const { storage, journal } = fixture(), first = journal.checkpoint(draft());
  storage.setItem = () => { throw Object.assign(new Error('Storage is full'), { name: 'QuotaExceededError' }); };
  assert.throws(() => journal.checkpoint({ ...draft(), lineIndex: 6 }), { name: 'QuotaExceededError' });
  assert.equal(journal.read(first.id).token, first._checkpointToken);
});

test('cleanup or read access failures cannot make an already committed database unreadable', () => {
  const { storage, journal } = fixture(), snapshot = journal.checkpoint(draft());
  storage.removeItem = () => { throw Error('Access denied'); };
  assert.equal(journal.acknowledge(snapshot.id, snapshot._checkpointToken), false);
  storage.getItem = () => { throw Error('Access denied'); };
  const durable = draft(); assert.equal(journal.merge(durable), durable); assert.deepEqual(journal.entries(), []);
});

test('a PDF can recover metadata on reimport even if its original import never committed', () => {
  const { journal } = fixture(); const { bytes, ...metadata } = draft(); journal.checkpoint(draft());
  assert.deepEqual(journal.merge(undefined, metadata.id), metadata);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { deletePdfAnnotations, applyDeletedAnnotationsToDocument } from '../src/annotation-deletions.js';
import { exportAnnotatedPdf, loadPDF, pdfjsLib } from '../src/pdf-engine.js';

const idOf = ref => `${ref.objectNumber}R${ref.generationNumber || ''}`;
const refsOn = (doc, pageIndex) => doc.getPage(pageIndex).node.lookup(PDFName.of('Annots'), PDFArray).asArray().map(idOf);
const dictionary = (doc, id) => {
  const [, num, generation = 0] = /^(\d+)R(\d*)$/.exec(id);
  return doc.context.lookup(PDFRef.of(Number(num), Number(generation)), PDFDict);
};

async function sourceFixture() {
  const doc = await PDFDocument.create(), context = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [doc.addPage([360, 480]), doc.addPage([360, 480])];
  pages.forEach((page, index) => page.drawText(`Selectable original page ${index + 1}`, { x: 30, y: 420, size: 12, font }));
  const entries = [[], []], ids = {};
  const add = (name, pageIndex, subtype, extra = {}, fixedRef) => {
    const value = context.obj({ Type: 'Annot', Subtype: subtype, Rect: [30, 400, 130, 416], P: pages[pageIndex].ref,
      F: 4, NM: PDFHexString.fromText('the-same-name'), Contents: PDFHexString.fromText(name), ...extra });
    const ref = fixedRef || context.register(value);
    if (fixedRef) context.assign(ref, value);
    entries[pageIndex].push(ref); ids[name] = idOf(ref);
    return ref;
  };
  add('highlight', 0, 'Highlight', { C: [1, 1, 0], QuadPoints: [30, 416, 130, 416, 30, 400, 130, 400] });
  add('secondHighlight', 0, 'Highlight', { C: [0, 1, 0], QuadPoints: [30, 386, 130, 386, 30, 370, 130, 370] });
  add('redUnderline', 0, 'Underline', { C: [1, 0, 0], QuadPoints: [30, 416, 130, 416, 30, 400, 130, 400] });
  const note = add('note', 0, 'Text', { Name: 'Comment', Contents: PDFHexString.fromText('保留中文内容的测试评论') });
  const popup = add('popup', 0, 'Popup', { Parent: note });
  context.lookup(note, PDFDict).set(PDFName.of('Popup'), popup);
  const otherNote = add('otherNote', 0, 'Text');
  add('otherPopup', 0, 'Popup', { Parent: otherNote });
  add('link', 0, 'Link', { A: { Type: 'Action', S: 'URI', URI: PDFHexString.fromText('https://example.com/') } });
  add('otherPage', 1, 'Highlight', { C: [1, 1, 0], QuadPoints: [30, 416, 130, 416, 30, 400, 130, 400] });
  add('generationTwo', 1, 'Text', {}, PDFRef.of(90, 2));
  entries.forEach((list, index) => pages[index].node.set(PDFName.of('Annots'), context.obj(list)));
  const field = doc.getForm().createTextField('untouched-field');
  field.setText('form remains usable');
  field.addToPage(pages[0], { x: 30, y: 300, width: 160, height: 24, font });
  return { bytes: await doc.save({ useObjectStreams: false }), ids };
}

test('deletion survives serialization/reopening and respects page/reference, not duplicate names', async () => {
  const { bytes, ids } = await sourceFixture();
  const output = await exportAnnotatedPdf(bytes, [], [
    { pageIndex: 0, id: ids.highlight }, { pageIndex: 0, id: ids.note }, { pageIndex: 1, id: ids.generationTwo },
  ]);
  const source = await PDFDocument.load(bytes), parsed = await PDFDocument.load(output);
  assert.deepEqual(refsOn(parsed, 0), refsOn(source, 0).filter(id => ![ids.highlight, ids.note, ids.popup].includes(id)));
  assert.deepEqual(refsOn(parsed, 1), [ids.otherPage]);
  assert.equal(parsed.getForm().getTextField('untouched-field').getText(), 'form remains usable');
  assert.equal(dictionary(parsed, ids.redUnderline).lookup(PDFName.of('C'), PDFArray).toString(), '[ 1 0 0 ]');
  assert.equal(dictionary(parsed, ids.link).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFHexString).decodeText(), 'https://example.com/');
  const reader = await loadPDF(output);
  try {
    const pageOne = await (await reader.getPage(1)).getAnnotations();
    assert.ok(pageOne.some(a => a.id === ids.secondHighlight));
    assert.ok(pageOne.some(a => a.id === ids.redUnderline));
    assert.ok(pageOne.some(a => a.id === ids.otherNote));
    assert.ok(pageOne.some(a => a.subtype === 'Widget'));
    assert.ok(pageOne.every(a => ![ids.highlight, ids.note, ids.popup].includes(a.id)));
    assert.deepEqual((await (await reader.getPage(2)).getAnnotations()).map(a => a.id), [ids.otherPage]);
  } finally { await reader.destroy(); }
});

test('unknown references, wrong pages and unsupported annotation types fail explicitly before mutation', async () => {
  const { bytes, ids } = await sourceFixture();
  for (const [target, code] of [
    [{ pageIndex: 0, id: 'annot_p0_1' }, 'ANNOTATION_DELETE_INVALID_ID'],
    [{ pageIndex: 0, id: '12R0' }, 'ANNOTATION_DELETE_INVALID_ID'],
    [{ pageIndex: 0, id: '9999R' }, 'ANNOTATION_DELETE_NOT_FOUND'],
    [{ pageIndex: 1, id: ids.highlight }, 'ANNOTATION_DELETE_NOT_FOUND'],
    [{ pageIndex: 2, id: ids.highlight }, 'ANNOTATION_DELETE_INVALID_PAGE'],
    [{ pageIndex: 0, id: ids.link }, 'ANNOTATION_DELETE_UNSUPPORTED_TYPE'],
    [{ pageIndex: 0, id: ids.popup }, 'ANNOTATION_DELETE_UNSUPPORTED_TYPE'],
  ]) {
    const doc = await PDFDocument.load(bytes), before = refsOn(doc, 0);
    assert.throws(() => deletePdfAnnotations(doc, [{ pageIndex: 0, id: ids.highlight }, target]), { code });
    assert.deepEqual(refsOn(doc, 0), before, 'a later invalid target cannot leave partial deletion');
    await assert.rejects(() => exportAnnotatedPdf(bytes, [], [target]), { code });
  }
});

test('PDF.js reference IDs including nonzero generations delete imported underlines and comments', async () => {
  const { bytes, ids } = await sourceFixture();
  const reader = await loadPDF(bytes);
  try {
    const first = await (await reader.getPage(1)).getAnnotations();
    const second = await (await reader.getPage(2)).getAnnotations();
    assert.ok(first.some(item => item.id === ids.redUnderline && item.subtype === 'Underline'));
    assert.ok(second.some(item => item.id === ids.generationTwo && item.subtype === 'Text'));
    assert.match(ids.generationTwo, /R2$/);
    const output = await exportAnnotatedPdf(bytes, [], [
      { pageIndex: 0, id: first.find(item => item.subtype === 'Underline').id },
      { pageIndex: 1, id: second.find(item => item.subtype === 'Text').id },
    ]);
    const parsed = await PDFDocument.load(output);
    assert.ok(!refsOn(parsed, 0).includes(ids.redUnderline));
    assert.ok(!refsOn(parsed, 1).includes(ids.generationTwo));
    assert.ok(refsOn(parsed, 0).includes(ids.highlight));
  } finally { await reader.destroy(); }
});

test('a shared Annots array cannot cause deletion on a different page; ambiguous popups survive', async () => {
  const { bytes, ids } = await sourceFixture();
  const doc = await PDFDocument.load(bytes), context = doc.context;
  const shared = context.register(doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray));
  doc.getPage(0).node.set(PDFName.of('Annots'), shared);
  doc.getPage(1).node.set(PDFName.of('Annots'), shared);
  // The forward reference is inconsistent; its unrelated popup must survive.
  dictionary(doc, ids.note).set(PDFName.of('Popup'), PDFRef.of(Number(ids.otherPopup.slice(0, -1))));
  const beforeOtherPage = refsOn(doc, 1);
  deletePdfAnnotations(doc, [{ pageIndex: 0, id: ids.note }, { pageIndex: 0, id: ids.note }]);
  assert.deepEqual(refsOn(doc, 0), beforeOtherPage.filter(id => id !== ids.note));
  assert.deepEqual(refsOn(doc, 1), beforeOtherPage);
});

test('every newly exported underline is black in color and appearance, leaving native colors intact', async () => {
  const { bytes, ids } = await sourceFixture();
  const output = await exportAnnotatedPdf(bytes, ['#ff0000', '#58a9ee', 'invalid'].map((color, index) => ({
    id: `new-underline-${index}`, pageIndex: 0, type: 'underline', rects: [[30, 350 - index * 20, 130, 366 - index * 20]], color,
  })));
  const parsed = await PDFDocument.load(output);
  assert.equal(dictionary(parsed, ids.redUnderline).lookup(PDFName.of('C'), PDFArray).toString(), '[ 1 0 0 ]');
  for (const id of refsOn(parsed, 0).slice(-3)) {
    const item = dictionary(parsed, id);
    assert.equal(item.lookup(PDFName.of('C'), PDFArray).toString(), '[ 0 0 0 ]');
    const appearance = item.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream);
    const commands = new TextDecoder().decode(decodePDFRawStream(appearance).decode());
    assert.match(commands, /(?:^|\n)0 0 0 RG(?:\n|$)/);
  }
});

test('PDF.js ENABLE_STORAGE removes original appearance operators and restores them on undo', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([360, 480]);
  page.drawText('The underlying page content remains.', { x: 30, y: 420, size: 12 });
  const bytes = await exportAnnotatedPdf(await source.save(), [
    { id: 'a', pageIndex: 0, type: 'highlight', rects: [[30, 415, 120, 431]] },
    { id: 'b', pageIndex: 0, type: 'underline', rects: [[130, 415, 240, 431]] },
    { id: 'c', pageIndex: 0, type: 'comment', rects: [[30, 380, 120, 396]], comment: '中文评论' },
  ]);
  const reader = await loadPDF(bytes);
  try {
    const loaded = await reader.getPage(1), notes = await loaded.getAnnotations();
    const id = notes.find(item => item.subtype === 'Highlight').id;
    const options = { intent: 'display', annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE };
    const appearanceIds = ops => ops.argsArray.filter((args, index) => ops.fnArray[index] === pdfjsLib.OPS.beginAnnotation).map(args => args[0]);
    const before = await loaded.getOperatorList(options);
    assert.equal(appearanceIds(before).length, 3);
    assert.deepEqual(applyDeletedAnnotationsToDocument(reader, [{ pageIndex: 0, id }]), [0]);
    const hidden = await loaded.getOperatorList(options);
    assert.deepEqual(appearanceIds(hidden), appearanceIds(before).filter(value => value !== id));
    assert.ok(hidden.fnArray.includes(pdfjsLib.OPS.showText), 'original selectable page content remains');
    assert.deepEqual(appearanceIds(await loaded.getOperatorList({ ...options, intent: 'print' })), appearanceIds(hidden), 'printing also omits a deleted native appearance');
    assert.deepEqual(applyDeletedAnnotationsToDocument(reader, [{ pageIndex: 0, id }]), [], 'reapplying the same state requires no repaint');
    assert.deepEqual(applyDeletedAnnotationsToDocument(reader, []), [0]);
    assert.deepEqual(appearanceIds(await loaded.getOperatorList(options)), appearanceIds(before));
    assert.equal(reader.annotationStorage.getRawValue(id), undefined);
    const reopened = await loadPDF(await exportAnnotatedPdf(bytes, [], [{ pageIndex: 0, id }]));
    try {
      const actual = await reopened.getPage(1);
      assert.deepEqual(appearanceIds(await actual.getOperatorList(options)), appearanceIds(before).filter(value => value !== id));
    } finally { await reopened.destroy(); }
  } finally { await reader.destroy(); }
});

test('preview undo preserves original visibility and unrelated storage edits, separately for each document', async () => {
  const make = () => {
    const map = new Map();
    return { numPages: 2, annotationStorage: {
      getRawValue: id => map.get(id), remove: id => map.delete(id),
      setValue: (id, value) => map.set(id, Object.assign(map.get(id) || {}, value)),
    } };
  };
  const first = make(), second = make();
  first.annotationStorage.setValue('12R', { noView: false, noPrint: true, value: 'initial' });
  const target = [{ pageIndex: 1, id: '12R' }];
  assert.deepEqual(applyDeletedAnnotationsToDocument(first, target), [1]);
  assert.deepEqual(applyDeletedAnnotationsToDocument(second, target), [1]);
  first.annotationStorage.setValue('12R', { value: 'edited while hidden', extra: 7 });
  assert.deepEqual(applyDeletedAnnotationsToDocument(first, []), [1]);
  assert.deepEqual(first.annotationStorage.getRawValue('12R'), { noView: false, noPrint: true, value: 'edited while hidden', extra: 7 });
  assert.deepEqual(second.annotationStorage.getRawValue('12R'), { noView: true, noPrint: true });
  applyDeletedAnnotationsToDocument(second, []);
  assert.equal(second.annotationStorage.getRawValue('12R'), undefined);
});

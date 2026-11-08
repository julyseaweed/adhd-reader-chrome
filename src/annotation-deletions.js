import { PDFArray, PDFDict, PDFName, PDFRef } from 'pdf-lib';

const editableSubtypes = new Set(['Highlight', 'Underline', 'Text']);
const previewStates = new WeakMap();
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const referenceId = ref => `${ref.objectNumber}R${ref.generationNumber || ''}`;

function deletionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function targetsFor(deletedAnnotations, pageCount) {
  if (!Array.isArray(deletedAnnotations)) {
    throw deletionError('ANNOTATION_DELETE_INVALID_TARGET', '待删除标注列表无效');
  }
  const targets = new Map();
  for (const target of deletedAnnotations) {
    if (!target || !Number.isInteger(target.pageIndex) || target.pageIndex < 0 || target.pageIndex >= pageCount) {
      throw deletionError('ANNOTATION_DELETE_INVALID_PAGE', '待删除标注页码无效');
    }
    const match = typeof target.id === 'string' && /^([1-9]\d*)R(?:([1-9]\d*))?$/.exec(target.id);
    if (!match || !Number.isSafeInteger(Number(match[1])) || (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 65535))) {
      throw deletionError('ANNOTATION_DELETE_INVALID_ID', '此标注缺少可识别的 PDF 对象引用，无法安全删除');
    }
    targets.set(`${target.pageIndex}:${target.id}`, { pageIndex: target.pageIndex, id: target.id });
  }
  return [...targets.values()];
}

/** Detach selected native annotations from exactly the specified page.
 * PDF.js reference IDs identify objects; annotation names (/NM) do not.
 * Detached objects are not a content-redaction mechanism.
 */
export function deletePdfAnnotations(document, deletedAnnotations = []) {
  const pages = document.getPages(), context = document.context;
  const targets = targetsFor(deletedAnnotations, pages.length);
  const removals = new Map();
  // Resolve every target before changing any page, including unsupported IDs.
  for (const target of targets) {
    const annots = pages[target.pageIndex].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const ref = annots?.asArray().find(value => value instanceof PDFRef && referenceId(value) === target.id);
    if (!ref) throw deletionError('ANNOTATION_DELETE_NOT_FOUND', '找不到这条标注，请重新打开 PDF 后再试');
    const annotation = context.lookup(ref);
    const subtype = annotation instanceof PDFDict && annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (!editableSubtypes.has(subtype)) {
      throw deletionError('ANNOTATION_DELETE_UNSUPPORTED_TYPE', '仅支持删除高亮、下划线和评论标注');
    }
    let ids = removals.get(target.pageIndex);
    if (!ids) removals.set(target.pageIndex, ids = new Set());
    ids.add(target.id);
    const popup = annotation.get(PDFName.of('Popup'));
    // Require both links when the parent declares a Popup. Otherwise an exact
    // Popup /Parent reference is sufficient, including older PDF producers.
    for (const entry of annots.asArray()) {
      if (!(entry instanceof PDFRef)) continue;
      const candidate = context.lookup(entry);
      if (!(candidate instanceof PDFDict) || candidate.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Popup') continue;
      const parent = candidate.get(PDFName.of('Parent'));
      if (!(parent instanceof PDFRef) || referenceId(parent) !== target.id) continue;
      if (popup !== undefined && (!(popup instanceof PDFRef) || referenceId(popup) !== referenceId(entry))) continue;
      ids.add(referenceId(entry));
    }
  }
  for (const [pageIndex, ids] of removals) {
    const page = pages[pageIndex], annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    // A malformed/shared Annots array must not make deletion affect another page.
    page.node.set(PDFName.of('Annots'), context.obj(annots.asArray().filter(value =>
      !(value instanceof PDFRef) || !ids.has(referenceId(value)))));
  }
  return [...removals.keys()].sort((a, b) => a - b);
}

/** Apply reversible visibility overrides to a PDF.js document.
 * Render with AnnotationMode.ENABLE_STORAGE so its worker consumes noView and
 * noPrint. Existing annotation appearances stay on the original page canvas.
 * This only updates preview state; export must also call deletePdfAnnotations.
 */
export function applyDeletedAnnotationsToDocument(document, deletedAnnotations = []) {
  const targets = targetsFor(deletedAnnotations, document.numPages);
  const storage = document.annotationStorage;
  if (!storage || typeof storage.getRawValue !== 'function' || typeof storage.setValue !== 'function' || typeof storage.remove !== 'function') {
    throw deletionError('ANNOTATION_DELETE_STORAGE_UNAVAILABLE', '当前 PDF 阅读器无法更新标注显示');
  }
  let previous = previewStates.get(document);
  if (!previous) previewStates.set(document, previous = new Map());
  const next = new Map(targets.map(target => [target.id, target]));
  const affected = new Set();
  for (const [id, state] of previous) {
    const target = next.get(id);
    if (target) {
      if (target.pageIndex !== state.pageIndex) {
        affected.add(state.pageIndex); affected.add(target.pageIndex);
        state.pageIndex = target.pageIndex;
      }
      continue;
    }
    const value = { ...(storage.getRawValue(id) || {}) };
    for (const key of ['noView', 'noPrint']) {
      if (state.fields[key].present) value[key] = state.fields[key].value;
      else delete value[key];
    }
    // setValue merges fields; remove/reinsert is needed to remove our overrides
    // while retaining unrelated values edited since the annotation was hidden.
    storage.remove(id);
    if (Object.keys(value).length) storage.setValue(id, value);
    previous.delete(id);
    affected.add(state.pageIndex);
  }
  for (const [id, target] of next) {
    if (previous.has(id)) continue;
    const original = storage.getRawValue(id) || {};
    const fields = Object.fromEntries(['noView', 'noPrint'].map(key => [key, { present: owns(original, key), value: original[key] }]));
    previous.set(id, { pageIndex: target.pageIndex, fields });
    storage.setValue(id, { noView: true, noPrint: true });
    affected.add(target.pageIndex);
  }
  return [...affected].sort((a, b) => a - b);
}

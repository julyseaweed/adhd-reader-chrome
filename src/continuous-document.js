import { extractReadingLayout, pdfjsLib } from './pdf-engine.js';
import { alignTextLayer } from './text-layer-layout.js';
import { textAdvancesForPage } from './text-advances.js';
import { createWordIndex } from './word-selection.js';

const GAP = 16;
const cancelled = () => Object.assign(new Error('PDF page rendering was cancelled'), { name: 'AbortError' });
const isCancellation = error => ['AbortError', 'AbortException', 'RenderingCancelledException'].includes(error?.name);
const validScale = value => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Invalid PDF scale');
  return value;
};

/** Keeps the whole document's geometry, and rasterizes only requested pages. */
export class ContinuousDocument {
  constructor({ container, onRendered, onVisible, onError }) {
    this.container = container;
    this.onRendered = onRendered;
    this.onVisible = onVisible;
    this.onError = onError;
    this.records = [];
    this.doc = null;
    this.scale = 1;
    this.activeIndex = -1;
    this._generation = 0;
    this._scaleVersion = 0;
    this._jobs = new Map();
    this._visiblePlan = null;
    this._visiblePromise = null;
  }

  async initialize(doc, scale, initialIndex = 0) {
    validScale(scale);
    this.destroy();
    const generation = this._generation;
    this.doc = doc;
    this.scale = scale;
    const pages = [];
    try {
      for (let start = 0; start < doc.numPages; start += 8) {
        const batch = await Promise.all(Array.from({ length: Math.min(8, doc.numPages - start) }, (_, offset) => doc.getPage(start + offset + 1)));
        if (generation !== this._generation || this.doc !== doc) throw cancelled();
        pages.push(...batch);
      }
      const document = this.container.ownerDocument, fragment = document.createDocumentFragment();
      this.records = pages.map((page, index) => {
        const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale });
        const element = document.createElement('div');
        element.className = 'pdf-page';
        element.dataset.pageIndex = String(index);
        element.dataset.ready = 'false';
        element.style.cssText = 'position:relative;box-sizing:border-box;margin-left:auto;margin-right:auto;';
        const content = document.createElement('div');
        content.className = 'pdf-content';
        content.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;';
        content.style.width = viewport.width + 'px';
        content.style.height = viewport.height + 'px';
        element.append(content); fragment.append(element);
        const record = { index, page, base, viewport, element, content, lines: [], layout: null, textLineMap: new WeakMap(), excludedText: new WeakSet(), nativeAnnotations: [], annotationRevision: 0, renderedAnnotationRevision: -1, ready: false, scale, _targetViewport: viewport };
        this._empty(record);
        return record;
      });
      this.container.replaceChildren(fragment);
      this._sizeSlots();
      if (this.records.length) this.activate(Math.max(0, Math.min(this.records.length - 1, Math.trunc(initialIndex) || 0)));
      return this;
    } catch (error) {
      if (generation !== this._generation || this.doc !== doc) throw cancelled();
      if (!isCancellation(error)) this._report(error);
      throw error;
    }
  }

  getRecord(index) { return this.records[index]; }

  setScale(scale) {
    validScale(scale);
    if (scale === this.scale) return;
    this.cancel();
    this.scale = scale;
    this._scaleVersion++;
    for (const record of this.records) {
      record._targetViewport = record.page.getViewport({ scale });
      record.ready = record.ready && record.scale === scale;
      record.element.dataset.ready = String(record.ready);
      record.content.style.transform = record.scale === scale ? '' : `scale(${scale / record.scale})`;
      record.textLayer.style.pointerEvents = record.ready ? '' : 'none';
      record.annotationsLayer.style.pointerEvents = record.ready ? '' : 'none';
    }
    this._sizeSlots();
  }

  _sizeSlots() {
    let height = 0, width = 0;
    for (const record of this.records) {
      const viewport = record._targetViewport;
      const gap = record.index === this.records.length - 1 ? 0 : GAP * this.scale;
      record.element.style.width = viewport.width + 'px';
      record.element.style.height = viewport.height + 'px';
      record.element.style.marginBottom = gap + 'px';
      record.top = height;
      height += viewport.height + gap;
      width = Math.max(width, viewport.width);
    }
    this.container.style.width = width + 'px';
    this.container.style.height = height + 'px';
  }

  _children(viewport) {
    const document = this.container.ownerDocument;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas'; canvas.width = 0; canvas.height = 0;
    canvas.style.cssText = 'display:block;pointer-events:none;';
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    const annotationsLayer = document.createElement('div'); annotationsLayer.className = 'annotations-layer';
    const focusLayer = document.createElement('div'); focusLayer.className = 'focus-layer'; focusLayer.hidden = true;
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const shade = document.createElement('div'); shade.className = 'shade ' + side; focusLayer.append(shade);
    }
    const outline = document.createElement('div'); outline.className = 'line-outline'; focusLayer.append(outline);
    const textLayer = document.createElement('div'); textLayer.className = 'textLayer';
    textLayer.style.setProperty('--total-scale-factor', String(viewport.scale * (viewport.userUnit || 1)));
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    return { canvas, annotationsLayer, focusLayer, outline, textLayer };
  }

  _empty(record) {
    if (record.canvas) { record.canvas.width = 0; record.canvas.height = 0; }
    const children = this._children(record.viewport);
    // Raster eviction must not alter the reading mask. Its lightweight DOM
    // keeps the locked aperture (or full-page shade) while pixels reload.
    if (record.focusLayer) { children.focusLayer = record.focusLayer; children.outline = record.outline; }
    record.content.replaceChildren(children.canvas, children.annotationsLayer, children.focusLayer, children.textLayer);
    Object.assign(record, children, { ready: false, textLineMap: new WeakMap(), excludedText: new WeakSet(), wordIndex: null });
    record.element.dataset.ready = 'false';
  }

  ensure(index) { return this._ensure(index, false); }

  // Keep the current bitmap, text and reading aperture until the replacement is
  // ready. Annotation edits invalidate only their own pages, not the document.
  rerenderAnnotations(indices) {
    const pending = [];
    for (const index of new Set(indices)) {
      const record = this.records[index];
      if (!record) continue;
      record.annotationRevision++;
      const job = this._jobs.get(index);
      if (job) this._cancelJob(job);
      if (record.canvas.width || record.ready) pending.push(this._ensure(index, false).catch(error => {
        if (!isCancellation(error)) throw error;
      }));
    }
    return Promise.all(pending);
  }

  _ensure(index, automatic) {
    const record = this.records[index];
    if (!record || !this.doc) return Promise.reject(new RangeError('PDF page is not available'));
    if (record.ready && record.scale === this.scale && record.renderedAnnotationRevision === record.annotationRevision) return Promise.resolve(record);
    const existing = this._jobs.get(index);
    if (existing && !existing.cancelled && existing.generation === this._generation && existing.scaleVersion === this._scaleVersion && existing.annotationRevision === record.annotationRevision) {
      if (!automatic) existing.automatic = false;
      return existing.promise;
    }
    if (existing) this._cancelJob(existing);
    const job = { index, generation: this._generation, scaleVersion: this._scaleVersion, annotationRevision: record.annotationRevision, annotationOnly: record.ready && record.scale === this.scale, automatic, cancelled: false, renderTask: null, textTask: null, promise: null };
    this._jobs.set(index, job);
    const check = () => {
      if (job.cancelled || job.generation !== this._generation || job.scaleVersion !== this._scaleVersion || job.annotationRevision !== record.annotationRevision || this.records[index] !== record) throw cancelled();
    };
    job.promise = (async () => {
      const viewport = record._targetViewport;
      const children = this._children(viewport);
      try {
        check();
        const ratio = Math.min(this.container.ownerDocument.defaultView?.devicePixelRatio || 1, 2, Math.sqrt(20000000 / (viewport.width * viewport.height)));
        children.canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        children.canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        job.renderTask = record.page.render({ canvasContext: children.canvas.getContext('2d'), viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
        await job.renderTask.promise; check();
        if (job.annotationOnly) {
          // A deletion changes the annotation appearance, not text geometry.
          // Preserve the live Range, word index and guide while swapping pixels.
          const oldCanvas = record.canvas;
          oldCanvas.replaceWith(children.canvas);
          Object.assign(record, { canvas: children.canvas, renderedAnnotationRevision: job.annotationRevision, error: null });
          oldCanvas.width = 0; oldCanvas.height = 0;
          if (this.activeIndex === index) this.activate(index);
          this._notify(this.onRendered, record);
          return record;
        }
        const [textContent, nativeAnnotations] = await Promise.all([record.page.getTextContent(), record.page.getAnnotations({ intent: 'display' })]);
        check();
        const [layout, textAdvances] = await Promise.all([
          extractReadingLayout(record.page, viewport, textContent),
          textAdvancesForPage(record.page, textContent, pdfjsLib.OPS),
        ]);
        check();
        // Generic browser fonts depend on language. PDF.js measures on a canvas
        // using textContent.lang; DOM spans must use that same explicit language,
        // rather than inheriting the reader UI's locale independently.
        const language = textContent.lang || this.container.ownerDocument.documentElement.lang || 'und';
        children.textLayer.lang = language;
        job.textTask = new pdfjsLib.TextLayer({ textContentSource: { ...textContent, lang: language }, container: children.textLayer, viewport });
        await job.textTask.render(); check();
        await alignTextLayer(children.textLayer, job.textTask.textDivs, textContent, viewport, textAdvances, { check });
        const wordIndex = createWordIndex(job.textTask.textDivs, textContent);
        check();
        const textLineMap = new WeakMap(), excludedText = new WeakSet();
        layout.lines.forEach((line, lineIndex) => line.items.forEach(item => {
          const div = job.textTask.textDivs[item.textDivIndex];
          if (div) textLineMap.set(div, lineIndex);
        }));
        layout.excludedLines.forEach(line => line.items.forEach(item => {
          const div = job.textTask.textDivs[item.textDivIndex];
          if (div) excludedText.add(div);
        }));
        check();
        const oldCanvas = record.canvas;
        record.content.replaceChildren(children.canvas, children.annotationsLayer, children.focusLayer, children.textLayer);
        record.content.style.width = viewport.width + 'px'; record.content.style.height = viewport.height + 'px';
        record.content.style.transform = '';
        Object.assign(record, children, { viewport, scale: this.scale, renderedAnnotationRevision: job.annotationRevision, lines: layout.lines, layout, textLineMap, excludedText, wordIndex, nativeAnnotations, ready: true, error: null });
        record.element.dataset.ready = 'true';
        if (oldCanvas) { oldCanvas.width = 0; oldCanvas.height = 0; }
        if (this.activeIndex === index) this.activate(index);
        this._notify(this.onRendered, record);
        return record;
      } catch (error) {
        children.canvas.width = 0; children.canvas.height = 0;
        if (job.cancelled || job.generation !== this._generation || job.scaleVersion !== this._scaleVersion) throw cancelled();
        if (!isCancellation(error)) { record.error = error; this._report(error, record); }
        throw error;
      } finally {
        if (this._jobs.get(index) === job) this._jobs.delete(index);
      }
    })();
    return job.promise;
  }

  activate(index) {
    const record = this.records[index];
    if (!record) return null;
    const aliases = { element: 'page-wrap', canvas: 'pdf-canvas', textLayer: 'text-layer', focusLayer: 'focus-layer', outline: 'line-outline', annotationsLayer: 'annotations-layer' };
    for (const other of this.records) {
      other.element.classList.toggle('active', other === record);
      for (const [field, id] of Object.entries(aliases)) {
        if (other === record) other[field].id = id;
        else other[field].removeAttribute('id');
      }
    }
    this.activeIndex = index;
    return record;
  }

  ensureVisible(area) {
    if (!this.doc || !this.records.length) return Promise.resolve();
    const bounds = area.getBoundingClientRect();
    const top = bounds.top + area.clientTop, bottom = top + area.clientHeight;
    const cursor = top + area.clientHeight * .35;
    const positions = this.records.map(record => ({ record, rect: record.element.getBoundingClientRect() }));
    const distance = item => Math.max(item.rect.top - cursor, cursor - item.rect.bottom, 0);
    const visible = positions.filter(({ rect }) => rect.bottom > top && rect.top < bottom);
    const closest = [...(visible.length ? visible : positions)].sort((a, b) => distance(a) - distance(b) || Math.abs((a.rect.top + a.rect.bottom) / 2 - cursor) - Math.abs((b.rect.top + b.rect.bottom) / 2 - cursor));
    const cursorIndex = closest[0].record.index;
    const wanted = (visible.length ? closest : closest.slice(0, 1)).map(item => item.record.index);
    for (const item of (visible.length ? visible : closest.slice(0, 1))) {
      for (const index of [item.record.index - 1, item.record.index + 1]) if (index >= 0 && index < this.records.length && !wanted.includes(index)) wanted.push(index);
    }
    const visibleIndices=visible.length ? visible.map(item => item.record.index) : [cursorIndex];
    this._visiblePlan = { generation: this._generation, wanted, cursorIndex, visibleIndices, failed: new Set(), notified: false };
    for(const job of this._jobs.values())if(job.automatic&&!wanted.includes(job.index))this._cancelJob(job);
    this._evictFar(visibleIndices);
    this._emitVisible(this._visiblePlan);
    if (!this._visiblePromise) {
      const promise = this._drainVisible(this._generation);
      this._visiblePromise = promise;
      promise.finally(() => { if (this._visiblePromise === promise) this._visiblePromise = null; }).catch(() => {});
    }
    return this._visiblePromise;
  }

  async _drainVisible(generation) {
    while (generation === this._generation) {
      const plan = this._visiblePlan;
      if (!plan || plan.generation !== generation) return;
      const index = plan.wanted.find(index => !plan.failed.has(index) && (!this.records[index].ready || this.records[index].scale !== this.scale || this.records[index].renderedAnnotationRevision !== this.records[index].annotationRevision));
      if (index === undefined) { this._emitVisible(plan); return; }
      try { await this._ensure(index, true); }
      catch (error) {
        if (generation !== this._generation) return;
        if (this._visiblePlan === plan) plan.failed.add(index);
      }
      if (this._visiblePlan) this._emitVisible(this._visiblePlan);
    }
  }

  _emitVisible(plan) {
    const record = this.records[plan.cursorIndex];
    if (plan.notified || !record?.ready || record.scale !== this.scale) return;
    plan.notified = true;
    this._notify(this.onVisible, record.index);
    this._evictFar(plan.visibleIndices);
  }

  _hasSelection(record) {
    const selection = this.container.ownerDocument.getSelection?.();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      try { if (selection.getRangeAt(i).intersectsNode(record.element)) return true; }
      catch { /* A detached range has no page to protect. */ }
    }
    return false;
  }

  _evictFar(visibleIndices) {
    const protectedIndices = [...visibleIndices, this.activeIndex];
    for (const record of this.records) {
      if (protectedIndices.some(index => Math.abs(record.index - index) <= 3) || this._hasSelection(record)) continue;
      const job = this._jobs.get(record.index);
      if (job && !job.automatic) continue;
      if (job) this._cancelJob(job);
      if (record.canvas.width || record.textLayer.childElementCount) this._empty(record);
    }
  }

  _cancelJob(job) {
    job.cancelled = true;
    try { job.renderTask?.cancel(); } catch { /* Already completed. */ }
    try { job.textTask?.cancel(); } catch { /* Already completed. */ }
  }

  cancel(index) {
    if (Number.isInteger(index)) {
      const job = this._jobs.get(index);
      if (job) this._cancelJob(job);
      return;
    }
    this._visiblePlan = null;
    for (const job of this._jobs.values()) this._cancelJob(job);
  }

  destroy() {
    this._generation++;
    this.cancel();
    this._jobs.clear(); this._visiblePromise = null;
    for (const record of this.records) { record.canvas.width = 0; record.canvas.height = 0; }
    this.records = []; this.doc = null; this.activeIndex = -1;
    this.container.replaceChildren();
    this.container.style.width = ''; this.container.style.height = '';
  }

  _notify(callback, ...args) {
    try {
      const result = callback?.(...args);
      if (result?.catch) result.catch(error => this._report(error));
    } catch (error) { this._report(error); }
  }

  _report(error, record) {
    try { this.onError?.(error, record); }
    catch (callbackError) { console.error(callbackError); }
  }
}

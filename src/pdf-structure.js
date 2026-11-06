// Drawing evidence for mathematical layout. This module does not decide whether
// a line is a fraction: page-region and neighboring-text evidence do that.
const IDENTITY = [1, 0, 0, 1, 0, 0];
// Short joins in extensible braces can be wider than fraction strokes. Keep
// elongated painted primitives here; the layout model decides their purpose.
const MIN_RULE_ASPECT = 4;
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const point = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const finite = values => values.every(Number.isFinite);

function pathBuilder() {
  const paths = []; let current;
  return {
    paths,
    move(x, y) { current = { points: [[x, y]], boundsPoints: [[x, y]], curved: false, closed: false }; paths.push(current); },
    line(x, y) { if (!current) this.move(x, y); else { current.points.push([x, y]); current.boundsPoints.push([x, y]); } },
    curve(...values) {
      const end = values.slice(-2);
      if (!current) this.move(...end);
      current.curved = true; current.points.push(end);
      for (let i = 0; i < values.length; i += 2) current.boundsPoints.push(values.slice(i, i + 2));
    },
    close() { if (current) current.closed = true; },
    rectangle(x, y, w, h) { this.move(x, y); this.line(x + w, y); this.line(x + w, y + h); this.line(x, y + h); this.close(); },
  };
}

function drawPath(data) {
  const builder = pathBuilder();
  if (!data || typeof data.length !== 'number') return null;
  for (let i = 0; i < data.length;) {
    const op = data[i++];
    const count = [2, 2, 6, 4, 0][op];
    if (count === undefined || i + count > data.length) return null;
    const values = Array.from(data.slice(i, i + count)); i += count;
    if (!finite(values)) return null;
    if (op === 0) builder.move(...values);
    else if (op === 1) builder.line(...values);
    else if (op === 2 || op === 3) builder.curve(...values);
    else builder.close();
  }
  return builder.paths;
}

function legacyPath(operations, coordinates, ops) {
  const builder = pathBuilder(); let i = 0;
  for (const operation of operations) {
    const count = operation === ops.moveTo || operation === ops.lineTo ? 2
      : operation === ops.curveTo ? 6
      : [ops.curveTo2, ops.curveTo3, ops.rectangle].includes(operation) ? 4
      : operation === ops.closePath ? 0 : -1;
    if (count < 0 || i + count > coordinates.length) return null;
    const values = Array.from(coordinates.slice(i, i + count)); i += count;
    if (!finite(values)) return null;
    if (operation === ops.moveTo) builder.move(...values);
    else if (operation === ops.lineTo) builder.line(...values);
    else if (operation === ops.rectangle) builder.rectangle(...values);
    else if (operation === ops.closePath) builder.close();
    else builder.curve(...values);
  }
  return builder.paths;
}

function straightLine(path) {
  if (path.curved || path.points.length < 2) return null;
  const a = path.points[0];
  const b = path.points.reduce((farthest, p) => length(a, p) > length(a, farthest) ? p : farthest, a);
  const distance = length(a, b); if (!distance) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (path.points.some(p => Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) > distance * 1e-5)) return null;
  return [a, b];
}

function thinRectangle(path) {
  if (path.curved) return null;
  const vertices = [...path.points];
  if (vertices.length === 5 && length(vertices[0], vertices[4]) < 1e-5) vertices.pop();
  if (vertices.length !== 4) return null;
  const [a, b, c, d] = vertices;
  const ab = [b[0] - a[0], b[1] - a[1]], ad = [d[0] - a[0], d[1] - a[1]];
  const width = length(a, b), height = length(a, d);
  if (!width || !height || Math.min(width, height) > Math.max(width, height) / MIN_RULE_ASPECT) return null;
  if (Math.abs(ab[0] * ad[0] + ab[1] * ad[1]) > width * height * 1e-4
    || Math.hypot(c[0] - b[0] - d[0] + a[0], c[1] - b[1] - d[1] + a[1]) > Math.max(width, height) * 1e-4) return null;
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return width >= height ? { ends: [mid(a, d), mid(b, c)], thickness: height }
    : { ends: [mid(a, b), mid(d, c)], thickness: width };
}

/** PDF.js operator-list paths projected through the complete PDF viewport. */
export function extractDrawingStructures(operatorList, OPS, viewport) {
  const rules = [];
  if (!operatorList?.fnArray || !OPS) return { rules, forms: [], groups: [], images: [], graphics: [] };
  const view = viewport?.transform || IDENTITY;
  const pageScale = Math.hypot(view[0], view[1]) || 1;
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(Number.isFinite));
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(Number.isFinite));
  let state = { matrix: [...IDENTITY], width: 1, strokeAlpha: 1, fillAlpha: 1 };
  const stack = []; let pending;
  const save = () => stack.push({ ...state, matrix: [...state.matrix] });
  const restore = () => { if (stack.length) state = stack.pop(); };
  const emit = (paths, paint, index) => {
    // PDF.js can preserve a redundant moveTo before the painted subpath.
    paths = paths?.filter(path => path.points.length > 1);
    // Compound paths often belong to charts/tables, clipping or outlined art.
    if (!paths || paths.length !== 1) return;
    let shape;
    if (fills.has(paint) && state.fillAlpha > 0) shape = thinRectangle(paths[0]);
    if (!shape && strokes.has(paint) && state.strokeAlpha > 0) {
      const ends = straightLine(paths[0]); if (ends) shape = { ends, thickness: Math.abs(state.width) };
    }
    if (!shape) return;
    const matrix = multiply(view, state.matrix);
    const [a, b] = shape.ends.map(p => point(matrix, p));
    const distance = length(a, b), originalLength = length(...shape.ends);
    if (!finite([...a, ...b]) || distance < 2 * pageScale || !originalLength) return;
    // Normal distance under an affine transform, including shear/nonuniform CTM.
    const normalScale = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) * originalLength / distance;
    const thickness = shape.thickness * normalScale;
    if (!Number.isFinite(thickness) || thickness > 4 * pageScale || thickness > distance / MIN_RULE_ASPECT) return;
    rules.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], thickness, id: `path-${index}`, kind: 'rule' });
  };
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], args = operatorList.argsArray[i] || [];
    if (op === OPS.save) save();
    else if (op === OPS.restore) restore();
    else if (op === OPS.transform && args.length >= 6 && finite(Array.from(args).slice(0, 6))) state.matrix = multiply(state.matrix, args);
    else if (op === OPS.setLineWidth && Number.isFinite(args[0])) state.width = args[0];
    else if (op === OPS.setGState) {
      for (const [name, value] of args[0] || []) {
        if (name === 'LW' && Number.isFinite(value)) state.width = value;
        else if (name === 'CA' && Number.isFinite(value)) state.strokeAlpha = value;
        else if (name === 'ca' && Number.isFinite(value)) state.fillAlpha = value;
      }
    } else if (op === OPS.paintFormXObjectBegin) {
      save(); if (args[0]?.length === 6) state.matrix = multiply(state.matrix, args[0]);
      pending = null;
    } else if (op === OPS.paintFormXObjectEnd) { restore(); pending = null; }
    else if (op === OPS.constructPath) {
      if (typeof args[0] === 'number') {
        emit(drawPath(args[1]?.[0]), args[0], i); pending = null;
      } else if (args[0]?.length && args[1]) pending = legacyPath(args[0], args[1], OPS);
    } else if (strokes.has(op) || fills.has(op)) { emit(pending, op, i); pending = null; }
    else if (op === OPS.endPath) pending = null;
  }
  return { rules, ...extractGraphicObjects(operatorList, OPS, viewport) };
}

const boundsFromPoints = points => {
  if (!points.length) return null;
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    if (!finite(p)) return null;
    x = Math.min(x, p[0]); y = Math.min(y, p[1]); right = Math.max(right, p[0]); bottom = Math.max(bottom, p[1]);
  }
  return { x, y, right, bottom, width: right - x, height: bottom - y };
};
const transformBounds = (rect, matrix) => rect?.length === 4 && finite(Array.from(rect))
  ? boundsFromPoints([[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]].map(p => point(matrix, p))) : null;
const intersectBounds = (a, b) => {
  if (!a) return b; if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return { x, y, right: Math.max(x, right), bottom: Math.max(y, bottom), width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
};
const unionBounds = (a, b) => !a ? b : !b ? a : boundsFromPoints([[a.x, a.y], [a.right, a.bottom], [b.x, b.y], [b.right, b.bottom]]);
const clippedSegment = (a,b,clip) => {
  let first=0,last=1;
  if(clip)for(const [start,delta,low,high]of [[a[0],b[0]-a[0],clip.x,clip.right],[a[1],b[1]-a[1],clip.y,clip.bottom]]){
    if(Math.abs(delta)<1e-12){if(start<low||start>high)return null;continue;}
    const t1=(low-start)/delta,t2=(high-start)/delta;
    first=Math.max(first,Math.min(t1,t2));last=Math.min(last,Math.max(t1,t2));
    if(first>=last)return null;
  }
  return {x1:a[0]+(b[0]-a[0])*first,y1:a[1]+(b[1]-a[1])*first,x2:a[0]+(b[0]-a[0])*last,y2:a[1]+(b[1]-a[1])*last};
};
const rgbColor = args => {
  if (typeof args[0] === 'string') return args[0].toLowerCase();
  if (args.length < 3 || !finite(Array.from(args).slice(0, 3))) return null;
  // Numeric RGB operator arguments are already bytes; current lists use CSS hex.
  return `#${Array.from(args).slice(0, 3).map(n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('')}`;
};
const rectanglePath = (path, implicitClose = false) => {
  if (!path || path.curved || (!path.closed && !implicitClose)) return false;
  const p = path.points.slice();
  if (p.length === 5 && length(p[0], p[4]) < 1e-6) p.pop();
  if (p.length !== 4) return false;
  const [a, b, c, d] = p, ab = [b[0] - a[0], b[1] - a[1]], ad = [d[0] - a[0], d[1] - a[1]];
  const product = length(a, b) * length(a, d);
  return product > 0 && Math.abs(ab[0] * ad[0] + ab[1] * ad[1]) <= product * 1e-5
    && Math.hypot(c[0] - b[0] - d[0] + a[0], c[1] - b[1] - d[1] + a[1]) < Math.sqrt(product) * 1e-5;
};

/** Graphics evidence only. Figure/table/formula decisions belong to the layout classifier.
 * Bounds include viewport rotation, CropBox and UserUnit; clips are conservative AABBs.
 * A transparency group's matrix transforms its clip, not its children's drawing CTM.
 */
function extractGraphicObjects(operatorList, OPS, viewport) {
  const forms = [], groups = [], images = [], graphics = [], scopes = new Map();
  const view = viewport?.transform || IDENTITY;
  const pageClip = Number.isFinite(viewport?.width) && Number.isFinite(viewport?.height)
    ? transformBounds([0, 0, viewport.width, viewport.height], IDENTITY) : null;
  let state = { matrix: [...IDENTITY], clip: pageClip, forms: [], groups: [], width: 1,
    fillAlpha: 1, strokeAlpha: 1, fillColor: '#000000', strokeColor: '#000000' };
  const stack = []; let pending, pendingClip = false;
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(Number.isFinite));
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(Number.isFinite));
  const matrix = () => multiply(view, state.matrix);
  const save = (kind = 'save', id) => stack.push({ kind, id, state: { ...state, matrix: [...state.matrix], forms: [...state.forms], groups: [...state.groups] } });
  const restore = index => {
    const entry = stack.pop(); if (!entry) return;
    if (entry.id) scopes.get(entry.id).end = index;
    state = entry.state;
  };
  const register = (entry, collection) => {
    entry.formId = state.forms.at(-1) || null; entry.groupId = state.groups.at(-1) || null;
    collection.push(entry);
    for (const id of [...state.forms, ...state.groups]) {
      const scope = scopes.get(id);
      (entry.kind === 'image' ? scope.imageIds : scope.graphicIds).push(entry.id);
      scope.paintBounds = unionBounds(scope.paintBounds, entry.bounds);
      if (!entry.whiteBackground) scope.inkBounds = unionBounds(scope.inkBounds, entry.bounds);
    }
  };
  const openScope = (kind, index, declaredBounds, transform) => {
    const id = `${kind}-${index}`;
    save(kind, id);
    if (transform) state.matrix = multiply(state.matrix, transform);
    state.clip = intersectBounds(state.clip, declaredBounds);
    const entry = { id, kind, start: index, end: null, parentId: (kind === 'form' ? state.forms : state.groups).at(-1) || null,
      formId: state.forms.at(-1) || null, groupId: state.groups.at(-1) || null,
      bounds: state.clip, declaredBounds, clipBounds: state.clip, paintBounds: null, inkBounds: null, graphicIds: [], imageIds: [] };
    (kind === 'form' ? forms : groups).push(entry); scopes.set(id, entry);
    (kind === 'form' ? state.forms : state.groups).push(id);
  };
  const pathBounds = paths => boundsFromPoints((paths || []).flatMap(p => p.boundsPoints || p.points).map(p => point(matrix(), p)));
  const consume = (paths, paint, index) => {
    const original = pathBounds(paths), fill = fills.has(paint) && state.fillAlpha > 0 && state.fillColor !== 'transparent',
      stroke = strokes.has(paint) && state.strokeAlpha > 0 && state.strokeColor !== 'transparent';
    if (original && (fill || stroke)) {
      let bounds = original;
      if (stroke) {
        const m = matrix(), dx = Math.abs(state.width) * Math.hypot(m[0], m[2]) / 2, dy = Math.abs(state.width) * Math.hypot(m[1], m[3]) / 2;
        bounds = boundsFromPoints([[bounds.x - dx, bounds.y - dy], [bounds.right + dx, bounds.bottom + dy]]);
      }
      bounds = intersectBounds(bounds, state.clip);
      if (bounds.width > 0 && bounds.height > 0) {
        const rectangular = paths.length === 1 && rectanglePath(paths[0], fill);
        register({ id: `graphic-${index}`, kind: 'path', operator: index, bounds, unclippedBounds: original,
          fill, stroke, fillColor: fill ? state.fillColor : null, strokeColor: stroke ? state.strokeColor : null,
          fillAlpha: fill ? state.fillAlpha : 0, strokeAlpha: stroke ? state.strokeAlpha : 0,
          curved: paths.some(p => p.curved), closed: paths.every(p => p.closed), rectangular, pathCount: paths.length,
          // Preserve straight edges even when a table is painted as one compound
          // path. The math rule collector deliberately accepts only single paths.
          segments: paths.flatMap(path => {
            if (path.curved) return [];
            const points = path.points.map(p => point(matrix(), p));
            if (path.closed && points.length > 2) points.push(points[0]);
            return points.slice(1).map((p, n) => clippedSegment(points[n],p,state.clip)).filter(Boolean);
          }),
          whiteBackground: rectangular && fill && state.fillColor === '#ffffff' && (!stroke || state.strokeColor === '#ffffff'),
        }, graphics);
      }
    }
    if (pendingClip && original) state.clip = intersectBounds(state.clip, original);
    pendingClip = false; pending = null;
  };
  const image = (index, ordinal, transform = IDENTITY, mask = false, name = null) => {
    if (state.fillAlpha <= 0 || mask && state.fillColor === 'transparent' || transform?.length !== 6 || !finite(Array.from(transform))) return;
    const unclippedBounds = transformBounds([0, 0, 1, 1], multiply(matrix(), transform));
    const bounds = intersectBounds(unclippedBounds, state.clip);
    if (bounds?.width > 0 && bounds.height > 0) register({ id: `image-${index}-${ordinal}`, kind: 'image', operator: index,
      bounds, unclippedBounds, mask, name, opacity: state.fillAlpha }, images);
  };
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], a = operatorList.argsArray[i] || [];
    if (op === OPS.save) save();
    else if (op === OPS.restore) restore(i);
    else if (op === OPS.transform && a.length >= 6 && finite(Array.from(a).slice(0, 6))) state.matrix = multiply(state.matrix, a);
    else if (op === OPS.setLineWidth && Number.isFinite(a[0])) state.width = a[0];
    else if (op === OPS.setFillRGBColor) state.fillColor = rgbColor(a);
    else if (op === OPS.setStrokeRGBColor) state.strokeColor = rgbColor(a);
    else if (op === OPS.setFillTransparent) state.fillColor = 'transparent';
    else if (op === OPS.setStrokeTransparent) state.strokeColor = 'transparent';
    else if (op === OPS.setFillGray) state.fillColor = rgbColor([a[0] * 255, a[0] * 255, a[0] * 255]);
    else if (op === OPS.setStrokeGray) state.strokeColor = rgbColor([a[0] * 255, a[0] * 255, a[0] * 255]);
    else if (op === OPS.setFillColorN || op === OPS.setFillColor || op === OPS.setFillCMYKColor) state.fillColor = null;
    else if (op === OPS.setStrokeColorN || op === OPS.setStrokeColor || op === OPS.setStrokeCMYKColor) state.strokeColor = null;
    else if (op === OPS.setGState) {
      for (const [name, value] of a[0] || []) {
        if (name === 'LW' && Number.isFinite(value)) state.width = value;
        else if (name === 'CA' && Number.isFinite(value)) state.strokeAlpha = value;
        else if (name === 'ca' && Number.isFinite(value)) state.fillAlpha = value;
      }
    } else if (op === OPS.beginGroup) {
      const group = a[0] || {}, m = group.matrix?.length === 6 ? multiply(matrix(), group.matrix) : matrix();
      openScope('group', i, transformBounds(group.bbox, m));
    } else if (op === OPS.endGroup) { restore(i); pending = null; pendingClip = false; }
    else if (op === OPS.paintFormXObjectBegin) {
      const transform = a[0]?.length === 6 ? a[0] : null, m = transform ? multiply(matrix(), transform) : matrix();
      openScope('form', i, transformBounds(a[1], m), transform);
      pending = null; pendingClip = false;
    } else if (op === OPS.paintFormXObjectEnd) { restore(i); pending = null; pendingClip = false; }
    else if (op === OPS.constructPath) {
      if (typeof a[0] === 'number') consume(drawPath(a[1]?.[0]), a[0], i);
      else if (a[0]?.length && a[1]) pending = legacyPath(a[0], a[1], OPS);
    } else if (op === OPS.clip || op === OPS.eoClip) pendingClip = true;
    else if (strokes.has(op) || fills.has(op) || op === OPS.endPath) consume(pending, op, i);
    else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintImageMaskXObject || op === OPS.paintSolidColorImageMask) {
      image(i, 0, IDENTITY, op === OPS.paintImageMaskXObject || op === OPS.paintSolidColorImageMask, typeof a[0] === 'string' ? a[0] : null);
    } else if (op === OPS.paintImageXObjectRepeat) {
      const positions = a[3] || [];
      for (let j = 0; j + 1 < positions.length; j += 2) image(i, j / 2, [a[1], 0, 0, a[2], positions[j], positions[j + 1]], false, a[0]);
    } else if (op === OPS.paintImageMaskXObjectRepeat) {
      const positions = a[5] || [];
      for (let j = 0; j + 1 < positions.length; j += 2) image(i, j / 2, [a[1], a[2] || 0, a[3] || 0, a[4], positions[j], positions[j + 1]], true);
    } else if (op === OPS.paintInlineImageXObjectGroup || op === OPS.paintImageMaskXObjectGroup) {
      const entries = op === OPS.paintInlineImageXObjectGroup ? a[1] || [] : a[0] || [];
      for (let j = 0; j < entries.length; j++) if (entries[j].transform?.length === 6) image(i, j, entries[j].transform, op === OPS.paintImageMaskXObjectGroup);
    }
  }
  // Unterminated scopes remain reviewable, but never acquire unrelated later pages.
  for (const scope of [...forms, ...groups]) if (scope.end === null) scope.end = operatorList.fnArray.length;
  return { forms, groups, images, graphics };
}

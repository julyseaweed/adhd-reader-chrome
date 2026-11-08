const PREFIX = 'linea-draft:';
const metadataKeys = ['id', 'name', 'annotations', 'deletedAnnotations', 'pageIndex', 'lineIndex', 'lineAnchor', 'savedSignature', 'updated'];
const index = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validMetadata(value) {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string'
    || !Number.isFinite(value.updated) || !index(value.pageIndex) || !index(value.lineIndex)
    || typeof value.savedSignature !== 'string' || !Array.isArray(value.annotations) || !Array.isArray(value.deletedAnnotations)) return false;
  if (!value.annotations.every(annotation => object(annotation) && typeof annotation.id === 'string'
    && ['highlight', 'underline', 'comment'].includes(annotation.type) && index(annotation.pageIndex)
    && Array.isArray(annotation.rects) && annotation.rects.length > 0
    && annotation.rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)))) return false;
  if (!value.deletedAnnotations.every(annotation => object(annotation) && typeof annotation.id === 'string' && index(annotation.pageIndex))) return false;
  const anchor = value.lineAnchor;
  return anchor == null || object(anchor) && index(anchor.pageIndex) && index(anchor.lineIndex)
    && (anchor.items === undefined || Array.isArray(anchor.items) && anchor.items.every(item => object(item) && index(item.index)))
    && (anchor.text === undefined || typeof anchor.text === 'string');
}

function decode(raw, id) {
  try {
    const entry = JSON.parse(raw);
    return entry?.version === 1 && typeof entry.token === 'string' && entry.token
      && validMetadata(entry.metadata) && entry.metadata.id === id && !Object.hasOwn(entry.metadata, 'bytes') ? entry : null;
  } catch { return null; }
}

/** A synchronous metadata journal bridges the time before an IndexedDB commit.
 * Original PDF bytes stay in IndexedDB. Acknowledgements only remove the exact
 * snapshot they committed, so a slower transaction cannot erase a newer edit.
 */
export function createDraftJournal(storage, { createToken = () => globalThis.crypto.randomUUID() } = {}) {
  const key = id => PREFIX + encodeURIComponent(id);
  const read = id => {
    try { return decode(storage.getItem(key(id)), id); } catch { return null; }
  };
  return {
    checkpoint(document) {
      const metadata = Object.fromEntries(metadataKeys.filter(name => document[name] !== undefined).map(name => [name, document[name]]));
      if (!validMetadata(metadata)) throw new TypeError('Invalid draft metadata');
      const token = createToken(), serialized = JSON.stringify({ version: 1, token, metadata });
      // Quota and access failures must reach the caller, which can still try
      // IndexedDB and report an unsaved draft instead of silently losing it.
      storage.setItem(key(metadata.id), serialized);
      return { ...document, ...JSON.parse(serialized).metadata, _checkpointToken: token };
    },
    read,
    entries() {
      const entries = [];
      try {
        for (let position = 0; position < storage.length; position++) {
          const name = storage.key(position);
          if (!name?.startsWith(PREFIX)) continue;
          let id; try { id = decodeURIComponent(name.slice(PREFIX.length)); } catch { continue; }
          const entry = read(id); if (entry) entries.push(entry);
        }
      } catch { /* An unavailable journal leaves the durable database readable. */ }
      return entries;
    },
    acknowledge(id, token) {
      if (!token || read(id)?.token !== token) return false;
      try { storage.removeItem(key(id)); return true; } catch { return false; }
    },
    merge(document, id = document?.id) {
      const checkpoint = id && read(id)?.metadata;
      if (!checkpoint || document && checkpoint.updated < document.updated) return document;
      return { ...document, ...checkpoint };
    },
  };
}

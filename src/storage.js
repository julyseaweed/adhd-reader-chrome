import { createDraftJournal } from './draft-journal.js';

let dbPromise;
const RECENT_DOCUMENT_LIMIT = 5;
const journal = () => createDraftJournal(globalThis.localStorage);
const restoreDraft = (record, id = record?.id) => { try { return journal().merge(record, id); } catch { return record; } };

export function checkpointDocument(document) { return journal().checkpoint(document); }

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('linea', 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      const documents = database.objectStoreNames.contains('documents')
        ? transaction.objectStore('documents')
        : database.createObjectStore('documents', { keyPath: 'id' });
      if (!documents.indexNames.contains('updated')) documents.createIndex('updated', 'updated');
      const files = database.objectStoreNames.contains('files')
        ? transaction.objectStore('files')
        : database.createObjectStore('files', { keyPath: 'id' });
      // Moving original PDFs and preserving their drafts is one atomic upgrade.
      const cursor = documents.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const { bytes, ...metadata } = entry.value;
        if (bytes) { files.put({ id: metadata.id, bytes }); entry.update(metadata); }
        entry.continue();
      };
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); dbPromise = undefined; };
      resolve(database);
    };
    request.onerror = () => { dbPromise = undefined; reject(request.error); };
  });
  return dbPromise;
}

export async function putDocument(document) {
  const database = await db();
  const { bytes, _checkpointToken, ...metadata } = document;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['documents', 'files'], 'readwrite');
    transaction.objectStore('documents').put(metadata);
    const files = transaction.objectStore('files');
    const existing = files.getKey(document.id);
    existing.onsuccess = () => {
      if (existing.result === undefined) {
        if (!bytes) { transaction.abort(); return; }
        files.put({ id: document.id, bytes });
      }
    };
    transaction.oncomplete = () => {
      try { journal().acknowledge(document.id, _checkpointToken); } catch { /* The committed database is already durable. */ }
      resolve();
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('原文件未保存'));
  });
}

export async function getDocument(id, includeBytes = false) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(includeBytes ? ['documents', 'files'] : ['documents']);
    const metadataRequest = transaction.objectStore('documents').get(id);
    const fileRequest = includeBytes ? transaction.objectStore('files').get(id) : null;
    transaction.oncomplete = () => {
      const metadata = restoreDraft(metadataRequest.result, id);
      if (!metadata) { resolve(undefined); return; }
      resolve(includeBytes ? { ...metadata, bytes: fileRequest.result?.bytes } : metadata);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function recentDocuments() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const records = new Map(), transaction = database.transaction('documents'), documents = transaction.objectStore('documents');
    const request = documents.index('updated').openCursor(null, 'prev');
    let cursorCount = 0;
    request.onsuccess = () => {
      const entry = request.result;
      if (!entry || cursorCount === RECENT_DOCUMENT_LIMIT) return;
      records.set(entry.value.id, entry.value); cursorCount++;
      entry.continue();
    };
    // A recent edit may still have the old database timestamp. Include those
    // document IDs before applying the five-item view, without scanning all PDFs.
    let checkpoints = []; try { checkpoints = journal().entries(); } catch { /* Use the database alone. */ }
    for (const { metadata } of checkpoints) {
      const pending = documents.get(metadata.id);
      pending.onsuccess = () => { if (pending.result) records.set(metadata.id, pending.result); };
    }
    transaction.oncomplete = () => resolve([...records.values()].map(record => restoreDraft(record))
      .sort((first, second) => second.updated - first.updated).slice(0, RECENT_DOCUMENT_LIMIT));
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export async function fingerprint(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeEnglishWord(input) {
  const word = String(input || '').normalize('NFKC').trim().toLowerCase().replace(/[’‘]/gu, "'").replace(/[‐‑–]/gu, '-');
  return /^[a-z]+(?:[-'][a-z]+)*$/u.test(word) ? word : null;
}

export const dictionaryShard = word => word.slice(0, 2).replace(/[^a-z]/gu, '_').padEnd(2, '_');
function checkCancelled(signal) {
  if (signal?.aborted) { const error = new Error('Dictionary lookup cancelled'); error.name = 'AbortError'; throw error; }
}
function waitForShard(promise, signal) {
  if (!signal) return promise;
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { try { checkCancelled(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

// A shard load is shared, but cancellation belongs to a lookup, never to the
// shared resource. Cancelling one selected word cannot cancel a newer lookup.
export function createDictionary({ loadShard, maxCachedShards = 8 }) {
  const cache = new Map();
  const load = async (word, signal) => {
    const key = dictionaryShard(word);
    let promise = cache.get(key);
    if (promise) { cache.delete(key); cache.set(key, promise); }
    else {
      promise = Promise.resolve().then(() => loadShard(key)).then(data => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid dictionary shard');
        return data;
      }).catch(error => { if (cache.get(key) === promise) cache.delete(key); throw error; });
      cache.set(key, promise);
      if (cache.size > Math.max(1, maxCachedShards)) cache.delete(cache.keys().next().value);
    }
    const data = await waitForShard(promise, signal);
    const entry = Object.hasOwn(data, word) ? data[word] : null;
    return Array.isArray(entry) && entry.length >= 3 && entry.every(value => typeof value === 'string') ? entry : null;
  };
  return async function lookup(input, { signal } = {}) {
    checkCancelled(signal);
    const word = normalizeEnglishWord(input);
    if (!word) return null;
    try {
      const entry = await load(word, signal); checkCancelled(signal);
      if (!entry) return null;
      let [translation, pos, lemma] = entry;
      const visited = new Set([word]);
      let target = normalizeEnglishWord(lemma);
      // Explicit dictionary inflections only; never guess a stem by deleting
      // letters from an unknown or accidentally truncated selection.
      for (let depth = 0; target && !visited.has(target) && depth < 3; depth++) {
        visited.add(target);
        const base = await load(target, signal); checkCancelled(signal);
        if (!base) break;
        if (base[0]) {
          if (!translation) translation = base[0];
          else if (!base[0].split('\n').every(line => translation.includes(line))) translation += `\n\n${target}\n${base[0]}`;
          pos ||= base[1];
          break;
        }
        target = normalizeEnglishWord(base[2]);
      }
      if (!/\p{Script=Han}/u.test(translation)) return null;
      return { word, lemma: lemma || null, translation: translation.trim(), pos, source: 'ECDICT' };
    } catch (error) {
      checkCancelled(signal);
      if (error.name === 'AbortError') throw error;
      return null;
    }
  };
}

let localDictionary;
export async function lookupEnglishWord(input, options = {}) {
  // Non-browser integrations supply their own local-file loader to the factory.
  if (typeof location === 'undefined') return null;
  localDictionary ||= createDictionary({ loadShard: async shard => {
    const response = await fetch(new URL(`./dictionary/${shard}.json`, location.href), { credentials: 'omit' });
    if (response.status === 404) return {};
    if (!response.ok) throw Error('Dictionary unavailable');
    return response.json();
  } });
  return localDictionary(input, options);
}

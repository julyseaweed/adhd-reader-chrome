import { francAll } from 'franc';
import { iso6393To1 } from 'iso-639-3';
export { validateTranslationResponse } from './translation-response.js';
export { createDictionary, lookupEnglishWord } from './dictionary.js';

// Context stays on this device. Only the selected words go to the translator.
const aliases = { cmn: 'zh', zho: 'zh', arb: 'ar', pes: 'fa', zlm: 'ms', uzn: 'uz', azj: 'az', swh: 'sw', ekk: 'et', pbu: 'ps', npi: 'ne', qug: 'qu', nob: 'nb', nno: 'nn', fil: 'tl', iw: 'he', in: 'id', ji: 'yi' };
const iso1 = new Set(Object.values(iso6393To1));
const scriptCodes = { Latin: 'Latn', Cyrillic: 'Cyrl', Arabic: 'Arab', Han: 'Hani', Hiragana: 'Jpan', Katakana: 'Jpan', Hangul: 'Kore', Devanagari: 'Deva', Bengali: 'Beng', Greek: 'Grek', Hebrew: 'Hebr', Thai: 'Thai', Tamil: 'Taml', Telugu: 'Telu', Kannada: 'Knda', Malayalam: 'Mlym', Gujarati: 'Gujr', Gurmukhi: 'Guru', Armenian: 'Armn', Georgian: 'Geor', Ethiopic: 'Ethi', Khmer: 'Khmr', Lao: 'Laoo', Myanmar: 'Mymr', Sinhala: 'Sinh', Tibetan: 'Tibt' };
const scriptPatterns = Object.keys(scriptCodes).map(script => [script, new RegExp(`\\p{Script=${script}}`, 'u')]);
const unambiguousScripts = { Hiragana: 'ja', Katakana: 'ja', Hangul: 'ko', Greek: 'el', Thai: 'th', Armenian: 'hy', Georgian: 'ka', Tamil: 'ta', Telugu: 'te', Kannada: 'kn', Malayalam: 'ml', Gujarati: 'gu', Gurmukhi: 'pa', Khmer: 'km', Lao: 'lo', Sinhala: 'si' };
const detectionCache = new Map();

export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/_/g, '-').toLowerCase(), base = raw.split('-')[0];
  if (!base || ['auto', 'und', 'mul', 'zxx'].includes(base)) return null;
  const language = aliases[base] || iso6393To1[base] || (iso1.has(base) ? base : null);
  if (!language) return null;
  if (language === 'zh') return /-(tw|hk|mo|hant)(-|$)/.test(raw) ? 'zh-TW' : 'zh-CN';
  return language;
}

function scriptCounts(text) {
  const counts = new Map();
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const match = scriptPatterns.find(([, pattern]) => pattern.test(char));
    if (match) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function compatible(language, counts) {
  if (!counts.length) return true;
  const leading = counts[0][0];
  if (['Hiragana', 'Katakana'].includes(leading)) return language === 'ja';
  if (leading === 'Han') return /^(zh|ja|ko)(-|$)/.test(language);
  if (leading === 'Hangul') return language === 'ko';
  try { return new Intl.Locale(language).maximize().script === scriptCodes[leading]; }
  catch { return false; }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) { const error = new Error('Translation cancelled'); error.name = 'AbortError'; throw error; }
}

function localContext(text, context) {
  const value = String(context || '').replace(/\s+/gu, ' ').trim();
  const index = value.toLocaleLowerCase().indexOf(text.toLocaleLowerCase());
  return index < 0 ? value.slice(0, 3200) : value.slice(Math.max(0, index - 1400), index + text.length + 1800);
}

async function browserDetection(sample, detector, signal) {
  if (!detector) return null;
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => detector(sample)), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
    abortIfNeeded(signal);
    const first = result?.languages?.filter(entry => normalizeLanguage(entry.language)).sort((a, b) => b.percentage - a.percentage)[0];
    if (!result?.isReliable || !first || first.percentage < 70) return null;
    return { language: normalizeLanguage(first.language), engine: 'browser', confidence: first.percentage / 100 };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return null;
  } finally { clearTimeout(timer); }
}

async function identify(sample, detector, signal) {
  const letters = (sample.match(/\p{L}/gu) || []).length;
  if (letters < 20) return null;
  const native = await browserDetection(sample, detector, signal);
  if (native) return native;
  if (letters < 40) return null;
  const [first, second] = francAll(sample, { minLength: 40 });
  const language = normalizeLanguage(first?.[0]);
  // These scores are distances, not probabilities; reject close alternatives.
  if (!language || first[0] === 'und' || second && first[1] - second[1] < (letters >= 100 ? .005 : .025)) return null;
  return { language, engine: 'franc', confidence: null };
}

export async function detectSourceLanguage(text, options = {}) {
  const { context = '', documentLanguage, signal } = options;
  text = String(text || '').replace(/\s+/gu, ' ').trim();
  abortIfNeeded(signal);
  if (!text || !/\p{L}/u.test(text)) return { language: null, evidence: 'undetermined', engine: null };
  const counts = scriptCounts(text);
  const unique = counts.find(([script]) => ['Hiragana', 'Katakana', 'Hangul'].includes(script))?.[0] || (counts.length === 1 ? counts[0][0] : null);
  if (unambiguousScripts[unique]) return { language: unambiguousScripts[unique], evidence: 'selection', engine: 'script', confidence: 1 };
  const api = globalThis.browser?.i18n || globalThis.chrome?.i18n;
  const detector = options.nativeDetector === null ? null : options.nativeDetector || (api?.detectLanguage ? api.detectLanguage.bind(api) : null);
  const nearby = localContext(text, context), metadata = normalizeLanguage(documentLanguage);
  const cacheKey = `${metadata || ''}\0${text}\0${nearby}`;
  if (detectionCache.has(cacheKey)) return { ...detectionCache.get(cacheKey) };
  const remember = result => {
    detectionCache.set(cacheKey, result);
    if (detectionCache.size > 200) detectionCache.delete(detectionCache.keys().next().value);
    return result;
  };
  const selection = await identify(text, detector, signal);
  abortIfNeeded(signal);
  if (selection && compatible(selection.language, counts)) return remember({ ...selection, evidence: 'selection' });
  const surrounding = nearby && nearby !== text ? await identify(nearby, detector, signal) : null;
  abortIfNeeded(signal);
  if (surrounding && compatible(surrounding.language, counts)) return remember({ ...surrounding, evidence: 'context' });
  if (metadata && compatible(metadata, counts)) return remember({ language: metadata, evidence: 'document', engine: 'metadata', confidence: null });
  return { language: null, evidence: 'undetermined', engine: null };
}

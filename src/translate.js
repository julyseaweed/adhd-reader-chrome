import { detectSourceLanguage } from './language-detection.js';
import { validateTranslationResponse } from './translation-response.js';
import { lookupEnglishWord } from './dictionary.js';

const cache = new Map();
let pending;
export function cancelTranslation() { pending?.abort(); }

export async function translate(input, options = {}) {
  pending?.abort();
  const controller = pending = new AbortController();
  const text = String(input || '').trim();
  if (!text) return '';
  if (new TextEncoder().encode(text).length > 500) throw Error('请选择更短的文字');
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const detected = await detectSourceLanguage(text, { ...options, signal: controller.signal });
    if (controller.signal.aborted) { const error = new Error('Translation cancelled'); error.name = 'AbortError'; throw error; }
    const source = detected.language;
    if (!source) throw Error('无法确定语言，请多选几个词');
    if (source.startsWith('zh')) return text;
    if (source === 'en') {
      const entry = await (options.dictionary || lookupEnglishWord)(text, { signal: controller.signal });
      if (controller.signal.aborted) { const error = new Error('Translation cancelled'); error.name = 'AbortError'; throw error; }
      if (entry) return entry.translation;
    }
    const key = source + ':' + text;
    if (cache.has(key)) return cache.get(key);
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', source + '|zh-CN');
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (response.status === 429) throw Error('今日免费翻译额度已用完');
    if (!response.ok) throw Error('翻译暂时不可用');
    const data = await response.json();
    if (controller.signal.aborted) { const error = new Error('Translation cancelled'); error.name = 'AbortError'; throw error; }
    const decoded = validateTranslationResponse(data, text, source);
    cache.set(key, decoded);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return decoded;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw Error('连接失败，请检查网络');
    if (error instanceof SyntaxError) throw Error('翻译服务返回异常，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
    if (pending === controller) pending = null;
  }
}

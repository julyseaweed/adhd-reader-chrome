const comparable = value => value.normalize('NFKC').replace(/[\p{Cf}\s]+/gu, ' ').trim().toLocaleLowerCase();
const languageBase = value => typeof value === 'string' ? value.toLowerCase().split(/[-_]/u)[0] : '';

function decodedText(value) {
  if (typeof value !== 'string') return '';
  if (typeof DOMParser !== 'undefined') return new DOMParser().parseFromString(value, 'text/html').documentElement.textContent.trim();
  // The Node/native path needs the same entity handling as the browser.
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/<[^>]*>/gu, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (match, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }).trim();
}

// A successful HTTP/API status only means the lookup completed. MyMemory may
// return the original word when neither its memory nor MT has a translation.
export function validateTranslationResponse(data, sourceText, sourceLanguage) {
  if (data?.quotaFinished || Number(data?.responseStatus) === 429) throw Error('今日免费翻译额度已用完');
  if (Number(data?.responseStatus) !== 200) throw Error('暂未找到译文');
  const original = comparable(String(sourceText || ''));
  const usable = value => {
    const decoded = decodedText(value);
    return /\p{Script=Han}/u.test(decoded) && comparable(decoded) !== original ? decoded : '';
  };
  const primary = usable(data.responseData?.translatedText);
  if (primary) return primary;
  // Only a translation of the same complete text can replace an unusable best
  // result. Similar-looking words and matches in another language are excluded.
  const source = languageBase(sourceLanguage);
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const alternatives = matches.filter(match => typeof match?.segment === 'string'
    && comparable(decodedText(match.segment)) === original && source
    && languageBase(match.source) === source && languageBase(match.target) === 'zh')
    .sort((a, b) => (Number(b.match) || 0) - (Number(a.match) || 0) || (Number(b.quality) || 0) - (Number(a.quality) || 0));
  for (const match of alternatives) {
    const translation = usable(match.translation);
    if (translation) return translation;
  }
  throw Error('暂未找到中文释义');
}

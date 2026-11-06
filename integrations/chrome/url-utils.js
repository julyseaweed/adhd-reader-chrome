const PDF_VIEWER_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

export function normalizeSource(rawURL) {
  let url;
  try { url = new URL(rawURL); } catch { return null; }
  if (url.protocol === 'chrome-extension:' && url.hostname === PDF_VIEWER_ID) {
    const nested = url.searchParams.get('file');
    if (!nested) return null;
    try { url = new URL(nested); } catch { return null; }
  }
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url;
}

export function looksLikePDF(rawURL, title = '') {
  const url = normalizeSource(rawURL);
  if (!url) return false;
  return /\.pdf$/i.test(url.pathname) || /\.pdf(?:\b|$)/i.test(title) || /(?:format|type|output)=pdf(?:&|$)/i.test(url.search.slice(1));
}

export function readerTarget(rawURL, force = false) {
  const url = normalizeSource(rawURL);
  if (!url || (!force && !looksLikePDF(rawURL))) return '';
  if (url.protocol === 'file:') return '?local=1';
  return '?url=' + encodeURIComponent(url.href);
}

export function hostPattern(url) {
  // Chrome match patterns intentionally have no port component.
  return url.protocol + '//' + url.hostname + '/*';
}

export function pdfName(responseURL, disposition = '') {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  const bare = disposition.match(/filename=([^;]+)/i)?.[1];
  let name = encoded || quoted || bare || '';
  if (!name) {
    try { name = new URL(responseURL).pathname.split('/').pop() || ''; } catch { /* fallback below */ }
  }
  try { name = decodeURIComponent(name); } catch { /* keep original spelling */ }
  name = name.replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').trim();
  if (!name || !/\.pdf$/i.test(name)) name = 'document.pdf';
  return name;
}

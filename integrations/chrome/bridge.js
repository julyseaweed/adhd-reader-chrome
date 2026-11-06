import { normalizeSource, hostPattern, pdfName } from './url-utils.js';

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function remoteURL(rawURL) {
  const url = normalizeSource(rawURL);
  if (!url) throw fail('UNSUPPORTED_URL', '这个链接无法直接打开。请导入 PDF 文件。');
  if (url.protocol === 'file:') throw fail('LOCAL_FILE', '请将本地 PDF 拖入阅读器。');
  return url;
}

/** Invoke directly from a button click, before any await, to retain user activation. */
export function requestAccess(rawURL) {
  const url = remoteURL(rawURL);
  return chrome.permissions.request({ origins: [hostPattern(url)] });
}

/** Returns PDF bytes locally; document contents never go through a server. */
export async function fetchPDF(rawURL, { signal } = {}) {
  const url = remoteURL(rawURL);
  const origin = hostPattern(url);
  let response;
  try {
    response = await fetch(url.href, { credentials: 'include', signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    const allowed = await chrome.permissions.contains({ origins: [origin] });
    if (!allowed) throw fail('HOST_PERMISSION_REQUIRED', '允许读取此网站的 PDF', { origin, url: url.href });
    throw fail('FETCH_FAILED', '链接未能打开。可以下载 PDF 后拖入阅读器。', { cause: error });
  }
  if (!response.ok) throw fail('FETCH_FAILED', `无法打开 PDF（${response.status}）。请下载后导入。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // PDFs may have a small preamble; reject login/HTML pages even if their URL ends in .pdf.
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!header.includes('%PDF-')) throw fail('NOT_PDF', '链接返回的不是 PDF。请下载 PDF 后导入。');
  return { bytes, name: pdfName(response.url || url.href, response.headers.get('Content-Disposition') || '') };
}

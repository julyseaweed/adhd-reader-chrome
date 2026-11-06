import { readerTarget, looksLikePDF } from './url-utils.js';

const LINK_MENU = 'linea-open-pdf-link';
const PAGE_MENU = 'linea-open-pdf-page';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: LINK_MENU, title: '用 ADHD Reader 阅读此 PDF', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'] });
    chrome.contextMenus.create({ id: PAGE_MENU, title: '用 ADHD Reader 阅读此 PDF', contexts: ['page'], documentUrlPatterns: ['http://*/*.pdf*', 'https://*/*.pdf*', 'file:///*.pdf*'] });
  });
});

function openReader(rawURL = '', force = false) {
  const target = readerTarget(rawURL, force);
  return chrome.tabs.create({ url: chrome.runtime.getURL('reader/index.html') + target });
}

chrome.action.onClicked.addListener((tab) => {
  openReader(tab.url || '', looksLikePDF(tab.url || '', tab.title || ''));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === LINK_MENU) openReader(info.linkUrl || '', true);
  if (info.menuItemId === PAGE_MENU) openReader(info.pageUrl || tab?.url || '', true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSourceLanguage, normalizeLanguage, validateTranslationResponse } from '../src/language-detection.js';
import { translate, cancelTranslation } from '../src/translate.js';

const passages = {
  en: ['attention', 'Reading with intention means choosing one small idea at a time. Bring your attention back to the sentence and read without rushing.'],
  fr: ['attention', 'La lecture de ce document demande une attention particulière. Les lecteurs peuvent comprendre les idées en lisant chaque phrase avec soin.'],
  de: ['Aufmerksamkeit', 'Beim Lesen dieses Dokuments ist besondere Aufmerksamkeit erforderlich. Die einzelnen Absätze erklären die wichtigsten Ideen mit klaren Beispielen.'],
  es: ['lectura', 'La lectura de este documento requiere atención y paciencia. Cada persona puede comprender las ideas principales al leer las frases con cuidado.'],
  it: ['lettura', 'La lettura di questo documento richiede attenzione e pazienza. Ogni persona può comprendere le idee principali leggendo con calma e cura.'],
  pt: ['leitura', 'A leitura deste documento exige atenção e paciência. Cada pessoa pode compreender as ideias principais ao ler as frases com cuidado.'],
  nl: ['aandacht', 'Bij het lezen van dit document is bijzondere aandacht nodig. De verschillende hoofdstukken leggen de belangrijkste ideeën uit met duidelijke voorbeelden.'],
  ru: ['внимание', 'При чтении этого документа необходимо особое внимание. Каждый читатель может понять основные идеи, внимательно изучая отдельные предложения.'],
  ar: ['القراءة', 'تتطلب القراءة في هذا المستند اهتمامًا خاصًا وصبرًا. يمكن لكل قارئ فهم الأفكار الرئيسية من خلال قراءة الجمل بعناية وهدوء.'],
  hi: ['पढ़ने', 'इस दस्तावेज़ को पढ़ने के लिए विशेष ध्यान और धैर्य की आवश्यकता है। प्रत्येक पाठक वाक्यों को ध्यान से पढ़कर मुख्य विचारों को समझ सकता है।'],
  ja: ['注意', 'この文章を読むときには注意が必要です。それぞれの文をゆっくり読めば、主要な考え方を理解することができます。'],
  'zh-CN': ['注意', '阅读这份文件需要耐心和注意。每位读者都可以通过仔细阅读每个句子来理解其中的主要观点。'],
};

test('offline detection identifies short selections from local context across twelve languages', async () => {
  for (const [language, [text, context]] of Object.entries(passages)) {
    const detected = await detectSourceLanguage(text, { context, nativeDetector: null });
    assert.equal(detected.language, language, language);
    assert.equal(detected.evidence, 'context');
  }
});

test('the same ambiguous spelling follows its surrounding language, not an English default', async () => {
  const french = await detectSourceLanguage('attention', { context: passages.fr[1], nativeDetector: null });
  const english = await detectSourceLanguage('attention', { context: passages.en[1], nativeDetector: null });
  assert.equal(french.language, 'fr'); assert.equal(english.language, 'en');
  assert.equal((await detectSourceLanguage('gift', { nativeDetector: null })).language, null);
  assert.equal((await detectSourceLanguage('1234 +-=', { documentLanguage: 'en', nativeDetector: null })).language, null);
});

test('nearby prose determines short words in PDF paragraphs containing formulas and numbers', async () => {
  const mathematics = '(2.1) 0 ≤ t ≤ 1, x_t ∈ R^d, dx_t = v_t(x_t) dt. 128 256 512. ';
  for (const language of ['en', 'fr', 'de']) {
    const [word, prose] = passages[language];
    const detected = await detectSourceLanguage(word, { context: mathematics + prose + mathematics, documentLanguage: language === 'fr' ? 'en' : undefined, nativeDetector: null });
    assert.equal(detected.language, language);
    assert.equal(detected.evidence, 'context', 'nearby prose takes precedence over document-wide metadata');
  }
  const unknown = await detectSourceLanguage('attention', { context: 'x_t = y_t + sigma dW_t; 0 <= t <= 1; R^d; (3.4) '.repeat(12), nativeDetector: null });
  assert.equal(unknown.language, null);
});

test('selection scripts and document language provide local evidence without using UI locale', async () => {
  assert.equal((await detectSourceLanguage('こんにちは', { context: passages.en[1], documentLanguage: 'en' })).language, 'ja');
  assert.equal((await detectSourceLanguage('안녕하세요', { context: passages.en[1] })).language, 'ko');
  assert.equal((await detectSourceLanguage('gift', { documentLanguage: 'de-DE', nativeDetector: null })).language, 'de');
  assert.equal((await detectSourceLanguage('внимание', { context: passages.en[1], documentLanguage: 'en', nativeDetector: null })).language, null);
  assert.equal(normalizeLanguage('por'), 'pt'); assert.equal(normalizeLanguage('ZH_hant'), 'zh-TW');
  assert.equal(normalizeLanguage('auto'), null); assert.equal(normalizeLanguage('xx'), null);
});

test('Chrome CLD is used locally when available, and unreliable results fall back offline', async () => {
  const context = 'Deze plaatselijke testtekst bevat voldoende woorden voor betrouwbare herkenning van de Nederlandse taal.';
  let sample;
  const detected = await detectSourceLanguage('plaatselijke', { context, nativeDetector: async text => { sample = text; return { isReliable: true, languages: [{ language: 'nl', percentage: 99 }] }; } });
  assert.equal(sample, context); assert.equal(detected.engine, 'browser'); assert.equal(detected.language, 'nl');
  const fallback = await detectSourceLanguage('attentivement', { context: passages.fr[1] + ' attentivement', nativeDetector: async () => ({ isReliable: false, languages: [{ language: 'en', percentage: 40 }] }) });
  assert.equal(fallback.language, 'fr'); assert.equal(fallback.engine, 'franc');
});

test('translation sends only the selection and detected source, never PDF context', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url: new URL(url), options }); return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: '注意' } }) }; });
  const result = await translate('attention', { context: passages.fr[1], nativeDetector: null });
  assert.equal(result, '注意'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('q'), 'attention');
  assert.equal(requests[0].url.searchParams.get('langpair'), 'fr|zh-CN');
  assert.deepEqual([...requests[0].url.searchParams.keys()].sort(), ['langpair', 'q']);
  assert.equal(requests[0].options.credentials, 'omit');
  await translate('attention', { context: passages.en[1], nativeDetector: null });
  assert.equal(requests[1].url.searchParams.get('langpair'), 'en|zh-CN', 'cache is separated by detected language');
  await translate('attention', { context: passages.fr[1], nativeDetector: null });
  assert.equal(requests.length, 2);
});

test('unknown, oversized and already-Chinese selections do not send a request', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected request'); });
  await assert.rejects(translate('gift', { nativeDetector: null }), /无法确定语言/);
  await assert.rejects(translate('中'.repeat(167)), /更短/);
  assert.equal(await translate('注意', { context: passages['zh-CN'][1], nativeDetector: null }), '注意');
  assert.equal(calls, 0);
});

test('cancelling during language detection prevents a later network request', async t => {
  let release, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected request'); });
  const pending = translate('cancelled-word', { context: 'A deliberately delayed paragraph provides enough context for this language detection test.', nativeDetector: () => new Promise(resolve => { release = resolve; }) });
  for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
  cancelTranslation(); release({ isReliable: true, languages: [{ language: 'en', percentage: 99 }] });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls, 0);
});

test('a cache hit aborts an older network request before returning', async t => {
  let activeSignal;
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (new URL(url).searchParams.get('q') === 'cached-local') return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: '已缓存' } }) };
    activeSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }));
  });
  await translate('cached-local', { documentLanguage: 'en', nativeDetector: null });
  const older = translate('pending-local', { documentLanguage: 'en', nativeDetector: null });
  for (let i = 0; i < 10 && !activeSignal; i++) await Promise.resolve();
  assert.equal(await translate('cached-local', { documentLanguage: 'en', nativeDetector: null }), '已缓存');
  await assert.rejects(older, error => error.name === 'AbortError');
  assert.equal(activeSignal.aborted, true);
});

test('the complete stochastic selection reaches the provider unchanged; an echoed fragment is never cached', async t => {
  const queries = [];
  const context = 'A stochastic differential equation describes a random process. The Brownian motion adds randomness to the evolution of each sample over time.';
  assert.equal((await detectSourceLanguage('stochastic', { context, nativeDetector: null })).language, 'en');
  t.mock.method(globalThis, 'fetch', async url => {
    const request = new URL(url), word = request.searchParams.get('q'); queries.push(word);
    assert.equal(request.searchParams.get('langpair'), 'en|zh-CN');
    // Captured shapes from the live provider: both requests return API status 200.
    return { ok: true, json: async () => ({ responseStatus: 200, quotaFinished: false,
      responseData: { translatedText: word === 'stochastic' ? '随机指标' : 'tochastic', match: word === 'stochastic' ? .98 : .85 } }) };
  });
  assert.equal(await translate('stochastic', { context, nativeDetector: null }), '随机指标');
  assert.equal(await translate('stochastic', { context, nativeDetector: null }), '随机指标');
  for (let i = 0; i < 2; i++) await assert.rejects(translate('tochastic', { context, nativeDetector: null }), /暂未找到中文释义/);
  assert.deepEqual(queries, ['stochastic', 'tochastic', 'tochastic']);
});

test('a provider success status cannot turn missing, wrong-language or echoed text into a Chinese translation', () => {
  for (const translatedText of ['', '  ', null, {}, 'Stochastic', 'ＳＴＯＣＨＡＳＴＩＣ', 'stochastic\u200b', 'No translation found']) {
    assert.throws(() => validateTranslationResponse({ responseStatus: 200, responseData: { translatedText } }, 'stochastic', 'en'), /暂未找到中文释义/);
  }
  assert.throws(() => validateTranslationResponse({ responseStatus: 429 }, 'word', 'en'), /额度/);
  assert.throws(() => validateTranslationResponse({ responseStatus: 200, quotaFinished: true }, 'word', 'en'), /额度/);
  assert.throws(() => validateTranslationResponse(null, 'word', 'en'), /暂未找到译文/);
  assert.equal(validateTranslationResponse({ responseStatus: 200, responseData: { translatedText: ' &#x968f;&#26426; &amp; 概率 ' } }, 'random and probability', 'en'), '随机 & 概率');
});

test('only an exact same-language Chinese memory match may replace an unusable primary result', () => {
  const data = { responseStatus: 200, responseData: { translatedText: 'randomized' }, matches: [
    { segment: 'randomization', translation: '错误的相似词', source: 'en', target: 'zh-CN', match: 1 },
    { segment: 'randomized', translation: '错误的源语言', source: 'fr', target: 'zh-CN', match: 1 },
    { segment: 'randomized', translation: '日文候选', source: 'en', target: 'ja', match: 1 },
    { segment: 'randomized', translation: 'randomized', source: 'en', target: 'zh-CN', match: 1 },
    { segment: 'Randomized', translation: '随机化的', source: 'en-GB', target: 'zh-CN', match: .98 },
  ] };
  assert.equal(validateTranslationResponse(data, 'randomized', 'en'), '随机化的');
  assert.throws(() => validateTranslationResponse({ ...data, matches: data.matches.slice(0, -1) }, 'randomized', 'en'), /暂未找到中文释义/);
});

test('cancelled response-body work cannot return or cache a late translation', async t => {
  let release, bodyStarted, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: () => { bodyStarted = true; return new Promise(resolve => { release = resolve; }); } };
  });
  const old = translate('late-response-body', { documentLanguage: 'en', nativeDetector: null });
  for (let i = 0; i < 10 && !bodyStarted; i++) await Promise.resolve();
  cancelTranslation(); release({ responseStatus: 200, responseData: { translatedText: '过期译文' } });
  await assert.rejects(old, error => error.name === 'AbortError');
  bodyStarted = false;
  const retry = translate('late-response-body', { documentLanguage: 'en', nativeDetector: null });
  for (let i = 0; i < 10 && !bodyStarted; i++) await Promise.resolve();
  release({ responseStatus: 200, responseData: { translatedText: '重新查询的译文' } });
  assert.equal(await retry, '重新查询的译文'); assert.equal(calls, 2);
});

test('network, HTTP quota and invalid JSON failures stay actionable and retryable', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new TypeError('Failed to fetch');
    if (calls === 2) return { ok: false, status: 429 };
    if (calls === 3) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
    return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: '恢复连接' } }) };
  });
  const options = { documentLanguage: 'en', nativeDetector: null };
  await assert.rejects(translate('provider-retry', options), /连接失败/);
  await assert.rejects(translate('provider-retry', options), /额度/);
  await assert.rejects(translate('provider-retry', options), /返回异常/);
  assert.equal(await translate('provider-retry', options), '恢复连接'); assert.equal(calls, 4);
});

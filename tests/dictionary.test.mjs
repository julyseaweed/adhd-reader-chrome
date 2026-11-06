import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDictionary, normalizeEnglishWord, dictionaryShard } from '../src/dictionary.js';
import { translate } from '../src/translate.js';

const dataURL = new URL('../public/dictionary/', import.meta.url);
const loadShard = async shard => JSON.parse(await fs.readFile(new URL(`${shard}.json`, dataURL), 'utf8'));

test('bundled ECDICT covers ordinary and scientific English with original multi-sense Chinese definitions', async () => {
  const dictionary = createDictionary({ loadShard });
  assert.equal((await dictionary('stochastic')).translation, 'a. 随机的\n[计] 随机的');
  for (const [word, expected] of [['diffusion', '扩散'], ['theorem', '定理'], ['eigenvalue', '特征值'], ['molecular', '分子'], ['attention', '注意'], ['random', '随机'], ['convergence', '收敛']]) {
    const result = await dictionary(word); assert.ok(result.translation.includes(expected), word);
    assert.equal(result.source, 'ECDICT');
  }
  const set = await dictionary('set');
  assert.match(set.translation, /^n\./); assert.match(set.translation, /\nvt\./); assert.match(set.translation, /\nvi\./);
  assert.equal(await dictionary('tochastic'), null, 'an unknown fragment must never be autocorrected to a different word');
});

test('exact words normalize case and apostrophes; phrases, numbers and other scripts never load a shard', async () => {
  let reads = 0;
  const dictionary = createDictionary({ loadShard: async shard => { reads++; return loadShard(shard); } });
  assert.equal((await dictionary('  STOCHASTIC  ')).word, 'stochastic');
  assert.equal(normalizeEnglishWord('can’t'), "can't"); assert.equal(dictionaryShard('a'), 'a_');
  const before = reads;
  for (const value of ['stochastic process', 'x + y', '3.14', '注意', '', '../../secret']) assert.equal(await dictionary(value), null);
  assert.equal(reads, before);
});

test('explicit inflections retain their own meaning and resolve their dictionary lemma', async () => {
  const dictionary = createDictionary({ loadShard });
  for (const [word, lemma, meaning] of [['ran', 'run', '跑'], ['went', 'go', '去'], ['models', 'model', '模型']]) {
    const result = await dictionary(word);
    assert.equal(result.lemma, lemma); assert.match(result.translation, new RegExp(meaning));
  }
});

test('cancelling a lookup does not cancel or poison a concurrent lookup sharing the shard', async () => {
  let reads = 0, release;
  const dictionary = createDictionary({ loadShard: () => { reads++; return new Promise(resolve => { release = resolve; }); } });
  const first = new AbortController();
  const old = dictionary('stochastic', { signal: first.signal });
  const newer = dictionary('steady');
  await Promise.resolve(); first.abort();
  // Cancellation must finish even if the local shard has not responded; the
  // newer lookup must still be able to use that shared load when it completes.
  await assert.rejects(old, error => error.name === 'AbortError');
  release({ stochastic: ['a. 随机的', 'a', ''], steady: ['a. 稳定的', 'a', ''] });
  assert.equal((await newer).translation, 'a. 稳定的');
  assert.equal((await dictionary('stochastic')).translation, 'a. 随机的'); assert.equal(reads, 1);
});

test('failed shards can retry and the local shard cache stays bounded', async () => {
  const calls = [];
  const dictionary = createDictionary({ maxCachedShards: 2, loadShard: async shard => {
    calls.push(shard);
    if (calls.length === 1) throw Error('temporary local read error');
    return { stochastic: ['a. 随机的', '', ''], apple: ['n. 苹果', '', ''], banana: ['n. 香蕉', '', ''] };
  } });
  assert.equal(await dictionary('stochastic'), null);
  assert.equal((await dictionary('stochastic')).translation, 'a. 随机的');
  await dictionary('apple'); await dictionary('banana'); await dictionary('stochastic');
  assert.deepEqual(calls, ['st', 'st', 'ap', 'ba', 'st']);
});

test('English dictionary hits work without network; phrases, unknown words and other languages retain online translation', async t => {
  const dictionary = createDictionary({ loadShard }), requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(new URL(url));
    return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: '在线释义' } }) };
  });
  const en = { documentLanguage: 'en', nativeDetector: null, dictionary };
  assert.equal(await translate('stochastic', en), 'a. 随机的\n[计] 随机的');
  assert.equal(requested.length, 0);
  assert.equal(await translate('stochastic process', en), '在线释义');
  assert.equal(await translate('unlisted-local-word', en), '在线释义');
  assert.equal(await translate('attention', { documentLanguage: 'fr', nativeDetector: null, dictionary }), '在线释义');
  assert.deepEqual(requested.map(url => [url.searchParams.get('q'), url.searchParams.get('langpair')]), [
    ['stochastic process', 'en|zh-CN'], ['unlisted-local-word', 'en|zh-CN'], ['attention', 'fr|zh-CN'],
  ]);
});

test('the shipped data is pinned, licensed, and contains no source CSV or separately licensed lemma corpus', async () => {
  const index = JSON.parse(await fs.readFile(new URL('index.json', dataURL), 'utf8'));
  assert.equal(index.revision, '39cfb9672c0906b63569e0453c2e6abfb9ab182a');
  assert.ok(index.entries > 390000); assert.ok(index.bytes < 26e6);
  assert.match(await fs.readFile(new URL('LICENSE.txt', dataURL), 'utf8'), /MIT License/);
  const names = await fs.readdir(dataURL); assert.ok(!names.some(name => name.endsWith('.csv') || name === 'lemma.en.txt'));
  let entries = 0, bytes = 0;
  for (const [shard, expectedBytes] of Object.entries(index.shards)) {
    const data = await fs.readFile(new URL(`${shard}.json`, dataURL)); bytes += data.length;
    assert.equal(data.length, expectedBytes);
    for (const [word, entry] of Object.entries(JSON.parse(data))) {
      entries++; assert.equal(dictionaryShard(word), shard);
      assert.equal(normalizeEnglishWord(word), word); assert.equal(entry.length, 3);
      assert.ok(entry.every(field => typeof field === 'string'));
    }
  }
  assert.equal(entries, index.entries); assert.equal(bytes, index.bytes);
});

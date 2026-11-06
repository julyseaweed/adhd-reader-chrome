"""Build the bundled English/Chinese word dictionary from pinned MIT ECDICT.

Source CSV stays outside the bundled public resources; shipped data is small JSON shards.
Run: python -X utf8 scripts/import-dictionary.py [--download]
"""
from pathlib import Path
import argparse
import csv
import hashlib
import io
import json
import re
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REVISION = '39cfb9672c0906b63569e0453c2e6abfb9ab182a'
BASE = f'https://raw.githubusercontent.com/skywind3000/ECDICT/{REVISION}/'
BLOBS = {'ecdict.csv': '0e527e22e0e0d22f012b0ed251a8dddd5891773b',
         'LICENSE': '594da8a1009c6a9b96d0fe8d1689aa192cf187fe'}
WORD = re.compile(r"[a-z]+(?:[-'][a-z]+)*\Z")
HAN = re.compile(r'[\u3400-\u9fff]')


def normalize(value):
    value = value.strip().lower().replace('’', "'").replace('–', '-').replace('‐', '-')
    return value if WORD.fullmatch(value) else None


def shard_for(word):
    return re.sub('[^a-z]', '_', word[:2]).ljust(2, '_')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'dictionary-source')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'public' / 'dictionary')
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    args.source_dir.mkdir(parents=True, exist_ok=True)
    for name, expected in BLOBS.items():
        target = args.source_dir / name
        if args.download and not target.exists():
            with urllib.request.urlopen(BASE + name, timeout=120) as response:
                target.write_bytes(response.read())
        data = target.read_bytes()
        actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if actual != expected:
            raise ValueError(f'{name}: source differs from pinned revision {REVISION}')

    entries, aliases, source_count = {}, [], 0
    with (args.source_dir / 'ecdict.csv').open(encoding='utf-8-sig', newline='') as stream:
        for row in csv.DictReader(stream):
            source_count += 1
            word = normalize(row['word'])
            if not word:
                continue
            translation = row['translation'].replace('\\n', '\n').replace('\\r', '').strip()
            if not HAN.search(translation):
                translation = ''
            forms = dict(part.split(':', 1) for part in row['exchange'].split('/') if ':' in part)
            lemma = normalize(forms.get('0', ''))
            if lemma == word:
                lemma = None
            pos = '/'.join(dict.fromkeys(part.split(':', 1)[0] for part in row['pos'].split('/') if part))
            if translation or lemma:
                old = entries.get(word)
                if old and old[0] and translation and old[0] != translation:
                    translation = '\n'.join(dict.fromkeys(old[0].splitlines() + translation.splitlines()))
                entries[word] = [translation or (old[0] if old else ''), pos or (old[1] if old else ''), lemma or (old[2] if old else '')]
            for kind, value in forms.items():
                form = normalize(value)
                if kind in {'p', 'd', 'i', '3', 'r', 't', 's'} and form and form != word:
                    aliases.append((form, word))
    for form, lemma in aliases:
        if form not in entries and entries.get(lemma, [''])[0]:
            entries[form] = ['', '', lemma]
    entries = {word: value for word, value in entries.items()
               if value[0] or entries.get(value[2], [''])[0]}
    shards = {}
    for word, value in sorted(entries.items()):
        shards.setdefault(shard_for(word), {})[word] = value
    args.output_dir.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for shard, values in shards.items():
        encoded = json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        (args.output_dir / f'{shard}.json').write_bytes(encoded)
        sizes[shard] = len(encoded)
    metadata = {'format': 1, 'name': 'ECDICT', 'license': 'MIT',
                'source': 'https://github.com/skywind3000/ECDICT', 'revision': REVISION,
                'sourceBlob': BLOBS['ecdict.csv'], 'sourceEntries': source_count,
                'entries': len(entries), 'shards': sizes, 'bytes': sum(sizes.values()),
                'entryFormat': ['Chinese definitions (with part of speech)', 'part of speech', 'lemma'],
                'selection': 'English single words and hyphenated/apostrophe forms; Chinese meanings and explicit CSV exchange inflections only.'}
    (args.output_dir / 'index.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    shutil.copyfile(args.source_dir / 'LICENSE', args.output_dir / 'LICENSE.txt')
    (args.output_dir / 'README.txt').write_text(
        f'ECDICT English-Chinese dictionary\nSource: {metadata["source"]}\nRevision: {REVISION}\n'
        'License: MIT (see LICENSE.txt).\nGenerated with scripts/import-dictionary.py.\n'
        'The original CSV and the separately licensed lemma.en.txt are not bundled.\n', encoding='utf-8')
    compressed = io.BytesIO()
    with zipfile.ZipFile(compressed, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in args.output_dir.glob('*'):
            archive.write(file, file.name)
    print(json.dumps({'sourceEntries': source_count, 'entries': len(entries), 'shards': len(shards),
                      'jsonBytes': sum(sizes.values()), 'zipBytes': len(compressed.getvalue()),
                      'largestShardBytes': max(sizes.values())}, indent=2))


if __name__ == '__main__':
    main()

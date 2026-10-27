"""Retain character CER and add a toned Cantonese syllable comparison for ASR homophones."""
import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import unicodedata

import ToJyutping


def syllables(text, expected=False):
    result = []
    characters = ToJyutping.get_jyutping_list(unicodedata.normalize('NFKC', text))
    for index, (character, pronunciation) in enumerate(characters):
        if pronunciation:
            values = pronunciation.split()
            if expected and character == '枱' and index+1 < len(characters) and characters[index+1][0] == '面':
                result.append({'toi2', 'toi4'})
            else:
                result.extend({value} if expected else value for value in values)
        elif unicodedata.category(character)[0] in 'LMN':
            value = 'unknown:' + character.casefold()
            result.append({value} if expected else value)
    return result


def score(expected, actual):
    left, right = syllables(expected, True), syllables(actual)
    row = list(range(len(right)+1))
    for i, alternatives in enumerate(left, 1):
        current = [i]
        for j, value in enumerate(right, 1):
            current.append(min(current[-1]+1, row[j]+1, row[j-1]+(value not in alternatives)))
        row = current
    return dict(metric='jyutping-syllable-error', converter='ToJyutping 3.2.0',
                expected=[sorted(values) for values in left], actual=right,
                edits=row[-1], errorRate=row[-1]/max(1, len(left)),
                toneHandling='Tones retained. Both dictionary-attested readings of 枱面 (toi2/toi4) are accepted.',
                variantSource='https://cantowords.com/dictionary/%E6%9E%B1')


if __name__ == '__main__':
    assert version('ToJyutping') == '3.2.0'
    assert score('故仔', '古仔')['edits'] == 0
    assert score('枱面', '台面')['edits'] == 0
    assert score('本', '半')['edits'] == 1
    assert score('一本書', '一本書abc')['edits'] == 3
    assert score('今日我哋讀一個短故仔。本書放喺枱面。', '今天我們讀一個小故事輸在桌子上')['errorRate'] > .1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+', type=Path)
    args = parser.parse_args()
    for path in args.reports:
        report = json.loads(path.read_text(encoding='utf8'))
        rows = [row for row in report['results'] if row['language'].startswith('yue_')]
        for row in rows:
            row['phonetic'] = score(row['text'], row['transcript'])
        report['phoneticScorerSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        temporary.replace(path)
        print(json.dumps(dict(path=str(path), cantoneseRows=len(rows), phoneticPasses=sum(row['phonetic']['errorRate'] <= .1 for row in rows))))

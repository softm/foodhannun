#!/usr/bin/env python3
"""Validate every compressed shard, unique food code and index pointer."""
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def read_checked(base, descriptor):
    path = base / descriptor['path']
    raw = path.read_bytes()
    assert len(raw) == descriptor['bytes'], f'{path}: byte size mismatch'
    assert hashlib.sha256(raw).hexdigest() == descriptor['sha256'], f'{path}: SHA-256 mismatch'
    return json.loads(gzip.decompress(raw))

def main():
    base = ROOT / 'data/nutrition'
    manifest = json.loads((base / 'manifest.json').read_text())
    total = 0
    for dataset in manifest['datasets']:
        index = read_checked(base, dataset['index'])['rows']
        assert len(index) == dataset['count'] == dataset['sourceTotal']
        codes = set()
        offset = 0
        for i, descriptor in enumerate(dataset['chunks']):
            chunk = read_checked(base, descriptor)
            assert len(chunk['rows']) == descriptor['count']
            assert len(chunk['columns']) == dataset['columnCount']
            code_pos, name_pos = chunk['columns'].index('식품코드'), chunk['columns'].index('식품명')
            basis_pos = next((chunk['columns'].index(name) for name in ['영양성분함량기준량', '영양성분제공단위량'] if name in chunk['columns']), None)
            for j, row in enumerate(chunk['rows']):
                code = str(row[str(code_pos)]).strip()
                assert code and code not in codes
                codes.add(code)
                item = index[offset]
                assert item[0] == code and item[1] == str(row[str(name_pos)]).strip()
                assert item[4:6] == [i,j], f'{code}: wrong detail pointer'
                assert item[6] == row.get(str(basis_pos), '')
                assert all(0 <= int(key) < dataset['columnCount'] for key in row)
                offset += 1
        assert offset == dataset['count'] == len(codes) == dataset['uniqueIds']
        total += offset
        print(f"{dataset['id']}: {offset:,} records, all checksums / unique codes / pointers valid")
    assert total == manifest['count']
    print(f'Validated {total:,} nutrition records.')
if __name__ == '__main__':
    main()

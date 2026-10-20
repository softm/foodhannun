#!/usr/bin/env python3
"""Validate complete API snapshots, including every raw shard and its row count."""
import argparse,gzip,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def validate(directory):
    status=json.loads((directory/'status.json').read_text())
    if status['status']!='complete': return False
    chunks=status.get('chunks')
    if chunks is None and status.get('path'):
        chunks=[{'path':status['path'],'sha256':status['sha256'],'bytes':status['bytes'],'count':status['count']}]
    total=0
    for item in chunks or []:
        p=directory/item['path'];assert p.parent==directory
        assert p.stat().st_size==item['bytes']
        assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==item['sha256']
        count=0
        with gzip.open(p,'rt',encoding='utf-8') as file:
            for line in file:
                row=json.loads(line);assert isinstance(row,dict) and row
                if status.get('sourceFields'): assert set(row).intersection(status['sourceFields']), 'API/전체파일 열 이름 불일치'
                count+=1
        assert count==item['count'];total+=count
    assert total==status['count']==status['sourceTotal']
    assert 0<=status['uniqueRecords']<=total
    print(f'{status["id"]}: verified {total:,} rows / {len(chunks or [])} complete shards')
    return True
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--service');args=parser.parse_args()
    paths=[ROOT/'data/collection'/args.service] if args.service else [p.parent for p in (ROOT/'data/collection').glob('*/status.json')]
    for path in paths: validate(path)

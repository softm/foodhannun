#!/usr/bin/env python3
"""Collect complete additional FoodSafety services with the existing secret.

Downloads never print credential-bearing URLs. Large initial snapshots use the
documented bulk file endpoint rather than exceeding the 100 requests/hour limit.
Partial responses are retained as partial and never advertised as complete.
"""
from __future__ import annotations
import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

SERVICES = {
    'I1020': '식품원재료 정보', 'I2520': '식품원재료코드',
    'I1250': '식품 품목제조보고', 'C002': '품목제조보고 원재료',
    'I0490': '회수·판매중지 정보', 'I0580': 'HACCP 적용업소 지정 현황',
    'C005': '바코드 연계제품 정보 (2018년 이후 갱신 중단)',
}
API_ROOT = 'https://openapi.foodsafetykorea.go.kr/api/'

class CollectionError(Exception):
    pass

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def open_api(url):
    try:
        return urlopen(Request(url, headers={'User-Agent': 'foodhannun/1.1'}), timeout=240)
    except HTTPError as exc:
        raise CollectionError(f'공식 API HTTP {exc.code}') from None
    except (URLError, TimeoutError, OSError):
        raise CollectionError('공식 API 연결 실패 또는 응답 시간 초과') from None

def fetch_page(service, key, start, end):
    url = API_ROOT + quote(key, safe='') + f'/{service}/json/{start}/{end}'
    with open_api(url) as response:
        raw = response.read(50 * 1024 * 1024)
    if key.encode() in raw:
        raise CollectionError('응답에 인증정보가 포함되어 저장을 중단했습니다.')
    try:
        payload = json.loads(raw.decode('utf-8-sig'))
        body = payload.get(service, payload)
        result = body.get('RESULT', payload.get('RESULT', {}))
        code = str(result.get('CODE', ''))
        if code != 'INFO-000':
            safe_code = code if re.fullmatch('[A-Z0-9-]{1,32}', code) else 'UNKNOWN'
            raise CollectionError(f'공식 API 응답 {safe_code}')
        rows, total = body.get('row', []), int(body['total_count'])
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise ValueError()
        return rows, total
    except CollectionError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise CollectionError('공식 API JSON 형식 확인 필요') from None

def file_rows(path):
    with path.open('rb') as file:
        prefix = file.read(1000).lstrip()
    if prefix.startswith(b'PK'):
        with zipfile.ZipFile(path) as archive:
            members = [info for info in archive.infolist() if not info.is_dir() and not info.filename.startswith('__MACOSX/')]
            for i, member in enumerate(members):
                if member.file_size > 3 * 1024**3:
                    raise CollectionError('압축 원본 크기 제한 초과')
                temporary = path.with_name(f'bulk-member-{i}.tmp')
                with archive.open(member) as source, temporary.open('wb') as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                try:
                    yield from file_rows(temporary)
                finally:
                    temporary.unlink(missing_ok=True)
    elif prefix.startswith(b'<'):
        count = 0
        for _, element in ET.iterparse(path, events=['end']):
            if element.tag.split('}')[-1].lower() in ('row', 'item'):
                yield {child.tag.split('}')[-1]: child.text or '' for child in element}
                element.clear()
                count += 1
        if not count:
            raise CollectionError('전체 파일 XML에 데이터 행이 없습니다.')
    elif prefix.startswith((b'{', b'[')):
        if path.stat().st_size > 400 * 1024**2:
            raise CollectionError('대용량 JSON 원본의 스트리밍 변환이 필요합니다.')
        with path.open(encoding='utf-8-sig') as file:
            payload = json.load(file)
        if isinstance(payload, list):
            rows = payload
        else:
            body = next((value for value in payload.values() if isinstance(value, dict) and 'row' in value), payload)
            rows = body.get('row')
        if not isinstance(rows, list):
            raise CollectionError('전체 파일 API가 다운로드 대신 오류/안내를 반환했습니다.')
        yield from rows
    else:
        with path.open('rb') as file:
            sample = file.read(65536)
        encoding = 'utf-8-sig'
        try:
            sample.decode(encoding)
        except UnicodeError:
            encoding = 'cp949'
        with path.open(encoding=encoding, newline='') as file:
            sample_text = file.read(65536)
            file.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample_text, delimiters=',\t|')
            except csv.Error:
                dialect = csv.excel
            reader = csv.DictReader(file, dialect=dialect)
            if not reader.fieldnames or len(reader.fieldnames) < 2:
                raise CollectionError('전체 파일 CSV 형식 확인 필요')
            for row in reader:
                if None in row:
                    raise CollectionError('전체 파일 CSV 열 개수 불일치')
                yield row

def collect(service, output):
    output.mkdir(parents=True, exist_ok=True)
    status = {'id': service, 'name': SERVICES[service], 'status': 'not-collected', 'count': 0, 'sourceUrl': f'https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no={service}', 'attemptedAt': now()}
    if service == 'C005':
        status['freshnessNote'] = '공식 안내상 2018년 이후 최신화 중단. 현재 바코드 제품 DB로 취급하지 않습니다.'
    key = os.environ.get('FOODSAFETY_API_KEY', '').strip()
    try:
        if not key:
            raise CollectionError('FOODSAFETY_API_KEY 설정 필요')
        first, expected = fetch_page(service, key, 1, 1000)
        status['sourceTotal'] = expected
        if expected > 95000:
            # One documented full-file request, at most 10/day per service.
            bulk = output / 'source.bulk'
            with open_api(API_ROOT + quote(key, safe='') + f'/{service}/file') as response, bulk.open('wb') as file:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 2 * 1024**3:
                        raise CollectionError('전체 원본 2GiB 크기 제한 초과')
                    if key.encode() in chunk:
                        raise CollectionError('원본 인증정보 탐지')
                    file.write(chunk)
            rows = file_rows(bulk)
            status['method'] = 'official-bulk-file'
        else:
            def pages():
                yield from first
                count = len(first)
                while count < expected:
                    page, total = fetch_page(service, key, count + 1, min(count + 1000, expected))
                    if total != expected or not page:
                        raise CollectionError('수집 중 전체 건수 변동 또는 빈 페이지')
                    yield from page
                    count += len(page)
                    time.sleep(0.3)
            rows = pages()
            status['method'] = 'official-paginated-full'
        count, fingerprints = 0, set()
        partial = output / 'records.partial.jsonl.gz'
        with partial.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
            for row in rows:
                encoded = json.dumps(row, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')
                if key.encode() in encoded:
                    raise CollectionError('정규화 결과 인증정보 탐지')
                compressed.write(encoded + b'\n')
                fingerprints.add(hashlib.sha256(encoded).digest())
                count += 1
                status['count'] = count
        if count != expected:
            raise CollectionError(f'원본 {expected:,}건 / 수집 {count:,}건 불일치')
        final = output / 'records.jsonl.gz'
        partial.replace(final)
        status.update(status='complete', fetchedAt=now(), uniqueRecords=len(fingerprints), path=final.name, bytes=final.stat().st_size)
        status['sha256'] = hashlib.file_digest(final.open('rb'), 'sha256').hexdigest()
        (output / 'source.bulk').unlink(missing_ok=True)
    except Exception as exc:
        status['status'] = 'partial' if status['count'] else 'blocked'
        # Unknown exceptions may embed credential-bearing URLs. Never print them.
        status['reason'] = str(exc) if isinstance(exc, CollectionError) else '원본 응답 형식 또는 변환 오류 (기존 수집본 보존)'
        if key:
            status['reason'] = status['reason'].replace(key, '[redacted]')
    (output / 'status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in status.items() if key not in ('sourceUrl',)}, ensure_ascii=False))
    return status['status'] == 'complete'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', choices=SERVICES, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.exit(0 if collect(args.service, args.output) else 1)

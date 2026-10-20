#!/usr/bin/env python3
"""Collect complete additional FoodSafety services with the existing secret.

Downloads never print credential-bearing URLs. Large initial snapshots use the
documented bulk file endpoint rather than exceeding the 100 requests/hour limit.
Partial responses are retained as partial and never advertised as complete.
"""
from __future__ import annotations
import argparse
import csv
import codecs
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import sqlite3
import tempfile
import shutil
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
BULK_THRESHOLD = 1000

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

def fetch_page_once(service, key, start, end):
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
        if code == 'INFO-200':
            return [], 0
        if code != 'INFO-000':
            safe_code = code if re.fullmatch('[A-Z0-9-]{1,32}', code) else 'UNKNOWN'
            explanation = ': 기존 키의 해당 서비스 활용신청 필요' if safe_code == 'INFO-110' else ''
            raise CollectionError(f'공식 API 응답 {safe_code}{explanation}')
        rows, total = body.get('row', []), int(body['total_count'])
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise ValueError()
        return rows, total
    except CollectionError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise CollectionError('공식 API JSON 형식 확인 필요') from None

def fetch_page(service, key, start, end):
    for attempt in range(7):
        try:
            return fetch_page_once(service, key, start, end)
        except CollectionError as exc:
            transient = any(code in str(exc) for code in ('INFO-500','HTTP 500','HTTP 502','HTTP 503','HTTP 504','연결 실패'))
            if not transient or attempt == 6:
                raise
            delay = min(5 * (attempt + 1), 30)
            print(f'{service}: 일시 응답으로 {delay}초 후 재시도', flush=True)
            time.sleep(delay)

def file_rows(path):
    with path.open('rb') as file:
        prefix = file.read(1000).lstrip()
        if prefix.startswith(codecs.BOM_UTF8): prefix=prefix[3:].lstrip()
    if prefix.startswith(b'\x1f\x8b'):
        temporary = path.with_name('bulk-uncompressed.tmp')
        try:
            with gzip.open(path,'rb') as source, temporary.open('wb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            yield from file_rows(temporary)
        finally:
            temporary.unlink(missing_ok=True)
    elif prefix.startswith(b'PK'):
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
        encoding = 'utf-16' if sample.startswith((codecs.BOM_UTF16_LE,codecs.BOM_UTF16_BE)) else 'utf-8-sig'
        try:
            codecs.getincrementaldecoder(encoding)().decode(sample, final=False)
        except UnicodeError:
            encoding = 'cp949'
        csv.field_size_limit(16 * 1024 * 1024)
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
    previous = None
    if (output / 'status.json').exists():
        try:
            candidate = json.loads((output / 'status.json').read_text(encoding='utf-8'))
            if candidate.get('status') == 'complete':
                previous = candidate
        except (ValueError, OSError):
            pass
    status = {'id':service,'name':SERVICES[service],'status':'not-collected','count':0,'sourceUrl':f'https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no={service}','attemptedAt':now()}
    if service == 'C005': status['freshnessNote'] = '공식 안내상 2018년 이후 최신화 중단. 현재 바코드 제품 DB로 취급하지 않습니다.'
    key = os.environ.get('FOODSAFETY_API_KEY','').strip()
    try:
        if not key: raise CollectionError('FOODSAFETY_API_KEY 설정 필요')
        first, expected = fetch_page(service,key,1,1000)
        status['sourceTotal'] = expected
        status['sourceFields'] = sorted({field for row in first for field in row})
        print(f'{service}: 공식 총 {expected:,}건 / 활용신청 정상 확인',flush=True)
        with tempfile.TemporaryDirectory(dir=output.parent,prefix=f'.{service}-stage-') as directory:
            stage=Path(directory)
            if expected > BULK_THRESHOLD:
                bulk=stage/'source.bulk'
                time.sleep(3)
                with open_api(API_ROOT+quote(key,safe='')+f'/{service}/file') as response, bulk.open('wb') as file:
                    status['bulkContentType']=response.headers.get('Content-Type','')
                    size=0
                    while chunk:=response.read(1024*1024):
                        size+=len(chunk)
                        if size>3*1024**3: raise CollectionError('전체 원본 3GiB 크기 제한 초과')
                        if key.encode() in chunk: raise CollectionError('원본 인증정보 탐지')
                        file.write(chunk)
                status['bulkBytes']=bulk.stat().st_size
                with bulk.open('rb') as file: status['bulkPrefixHex']=file.read(16).hex()
                rows=file_rows(bulk)
                status['method']='official-bulk-file'
            else:
                def pages():
                    yield from first
                    count=len(first)
                    while count<expected:
                        time.sleep(1)
                        page,total=fetch_page(service,key,count+1,min(count+1000,expected))
                        if total!=expected or not page: raise CollectionError('수집 중 전체 건수 변동 또는 빈 페이지')
                        yield from page
                        count+=len(page)
                rows=pages()
                status['method']='official-paginated-full'
            count=0; chunks=[]; batch=[]
            db=sqlite3.connect(stage/'fingerprints.sqlite')
            db.execute('CREATE TABLE fingerprints (digest BLOB PRIMARY KEY) WITHOUT ROWID')
            def flush():
                if not batch: return
                name=f'records-{len(chunks):04d}.jsonl.gz'; path=stage/name
                with path.open('wb') as raw, gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as compressed:
                    compressed.write(b'\n'.join(batch)+b'\n')
                if path.stat().st_size>90*1024**2: raise CollectionError('단일 압축 파일 90MiB 제한 초과')
                with path.open('rb') as file: digest=hashlib.file_digest(file,'sha256').hexdigest()
                chunks.append({'path':name,'count':len(batch),'bytes':path.stat().st_size,'sha256':digest})
                batch.clear();db.commit()
            for row in rows:
                if not isinstance(row,dict): raise CollectionError('원본 행의 형식 확인 필요')
                if status['sourceFields'] and not set(row).intersection(status['sourceFields']): raise CollectionError('공식 전체파일과 API의 열 이름 불일치')
                encoded=json.dumps(row,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode()
                if key.encode() in encoded: raise CollectionError('정규화 결과 인증정보 탐지')
                batch.append(encoded)
                db.execute('INSERT OR IGNORE INTO fingerprints VALUES (?)',(hashlib.sha256(encoded).digest(),))
                count+=1;status['count']=count
                if len(batch)>=10000: flush()
                if count%50000==0: print(f'{service}: {count:,}/{expected:,}건 변환',flush=True)
            flush()
            unique=db.execute('SELECT count(*) FROM fingerprints').fetchone()[0];db.close()
            if count!=expected: raise CollectionError(f'원본 {expected:,}건 / 수집 {count:,}건 불일치')
            for path in output.glob('records*.jsonl.gz'): path.unlink()
            for descriptor in chunks: (stage/descriptor['path']).replace(output/descriptor['path'])
            status.update(status='complete',fetchedAt=now(),uniqueRecords=unique,chunks=chunks,bytes=sum(c['bytes'] for c in chunks))
    except Exception as exc:
        status['status']='partial' if status['count'] else 'blocked'
        status['errorType']=type(exc).__name__
        status['reason']=str(exc) if isinstance(exc,CollectionError) else f'원본 응답 형식 또는 변환 오류 ({type(exc).__name__}, 기존 수집본 보존)'
        if key: status['reason']=status['reason'].replace(key,'[redacted]')
        if previous:
            (output/'status-last-attempt.json').write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
            previous.update(lastAttemptAt=status['attemptedAt'],lastAttemptStatus=status['status'],lastAttemptReason=status['reason'])
            (output/'status.json').write_text(json.dumps(previous,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(status,ensure_ascii=False),flush=True)
            return False
    (output/'status.json').write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in status.items() if k not in ('sourceUrl','chunks','sourceFields')},ensure_ascii=False),flush=True)
    return status['status']=='complete'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', choices=SERVICES, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.exit(0 if collect(args.service, args.output) else 1)

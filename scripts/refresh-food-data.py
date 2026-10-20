#!/usr/bin/env python3
"""Run one scheduled collection transaction, preserving the last valid generation."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OFFICIAL = ['I0490', 'I1250', 'C002', 'I0580', 'I1020', 'I2520']

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)

def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

def select_mode(config, mode='', schedule=''):
    if schedule:
        matches = [key for key, value in config['jobs'].items() if value['cronUtc'] == schedule]
        if len(matches) != 1:
            raise ValueError('Unknown collection schedule')
        return matches[0]
    if not mode:
        return 'recalls'  # A code-change push exercises the complete hourly pipeline.
    if mode not in (*config['jobs'], 'official-all'):
        raise ValueError('Unknown collection mode')
    return mode

def check_count(previous, current):
    """Do not publish empty/truncated responses over a populated snapshot."""
    old, new = previous.get('count', 0), current.get('count', 0)
    if old and new < old * 0.5:
        raise ValueError('이전 정상본의 50% 미만으로 감소하여 기존 수집본 보존')

def link_copy(source, target):
    """Staging files are read-only until replaced; never modify shared inodes."""
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return str(target)

def promote(root, stage, paths):
    """Replace a validated file set, rolling back every path on a local failure."""
    with tempfile.TemporaryDirectory(dir=root / '.cache', prefix='publish-backup-') as directory:
        backup = Path(directory)
        moved, replaced = [], []
        try:
            for relative in paths:
                source, target, old = stage / relative, root / relative, backup / relative
                if not source.exists():
                    raise ValueError('Missing validated output: ' + relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    old.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(target, old)
                    moved.append(relative)
                os.replace(source, target)
                replaced.append(relative)
        except Exception:
            for relative in reversed(replaced):
                target = root / relative
                if target.is_dir(): shutil.rmtree(target)
                else: target.unlink(missing_ok=True)
            for relative in reversed(moved):
                os.replace(backup / relative, root / relative)
            raise

def fail_service(directory, previous, reason):
    attempt = {'attemptedAt': now(), 'status': 'failed', 'reason': reason}
    write(directory / 'status-last-attempt.json', attempt)
    preserved = dict(previous)
    preserved.update(lastAttemptAt=attempt['attemptedAt'], lastAttemptStatus='failed', lastAttemptReason=reason)
    write(directory / 'status.json', preserved)

def collect_service(collector, validator, root, stage, service):
    previous = read(stage / 'data/collection' / service / 'status.json', {})
    if previous.get('status') != 'complete':
        raise ValueError('Automation requires an existing verified source: ' + service)
    fallback = False
    with tempfile.TemporaryDirectory(dir=stage, prefix='attempt-') as directory:
        attempt = Path(directory) / service
        attempt.mkdir()
        write(attempt / 'status.json', previous)
        success = collector.collect(service, attempt, prefer_pages=service == 'I0490')
        if not success and service == 'I0490':
            page_reason = read(attempt / 'status-last-attempt.json', {}).get('reason', '실시간 API 전체 건수 대조 실패')
            print('I0490: 실시간 대조 실패로 공식 전체파일을 확인합니다.', flush=True)
            success = collector.collect(service, attempt)
            if success:
                fallback = True
                status = read(attempt / 'status.json')
                status['apiPageAttemptStatus'] = 'failed'
                status['apiPageAttemptReason'] = page_reason
                status['freshnessNote'] = '실시간 API 전체 건수 대조 실패로 공식 전체파일 기준 조회. ' + page_reason
                write(attempt / 'status.json', status)
        destination = stage / 'data/collection' / service
        if success:
            try:
                current = read(attempt / 'status.json')
                check_count(previous, current)
                assert validator.validate(attempt)
            except Exception as error:
                fail_service(destination, previous, str(error) if isinstance(error, ValueError) else '원문 전수 검증 실패')
                return False, fallback
            # The failure record from an earlier page attempt does not describe a failed final snapshot.
            (attempt / 'status-last-attempt.json').unlink(missing_ok=True)
            shutil.rmtree(destination)
            os.replace(attempt, destination)
            return True, fallback
        failed = read(attempt / 'status-last-attempt.json', read(attempt / 'status.json', {}))
        fail_service(destination, previous, failed.get('reason', '수집 실패'))
        return False, fallback

def run_script(root, name, *args):
    subprocess.run([sys.executable, str(root / 'scripts' / name), *args], cwd=root, check=True)

def refresh_official(root, stage, services):
    (stage / 'data').mkdir()
    shutil.copytree(root / 'data/collection', stage / 'data/collection', copy_function=link_copy)
    shutil.copytree(root / 'data/food-safety', stage / 'data/food-safety', copy_function=link_copy)
    collector, validator = module('collect-foodsafety'), module('validate-foodsafety')
    failed, fallback = [], []
    for service in services:
        good, used_fallback = collect_service(collector, validator, root, stage, service)
        if not good: failed.append(service)
        if used_fallback: fallback.append(service)
        time.sleep(3)
    run_script(root, 'build-foodsafety-index.py', '--root', str(stage))
    run_script(root, 'validate-foodsafety-index.py', '--root', str(stage))
    promote(root, stage, ['data/collection/' + service for service in services] + ['data/food-safety'])
    return failed, fallback

def validate_recipes(root):
    data = read(root / 'data/recipes.json')
    rows, meta = data['recipes'], data['meta']
    assert meta['datasetMode'] == 'official-full'
    assert len(rows) == meta['count'] == meta['totalAvailable'] > 0
    assert len({str(row['id']) for row in rows}) == len(rows)
    raw = read(root / 'data/raw-full.json')['COOKRCP01']
    assert len(raw['row']) == int(raw['total_count']) == len(rows)
    browser = (root / 'assets/data.js').read_text().split('window.FOOD_DATA =', 1)[1].strip().removesuffix(';')
    assert json.loads(browser) == data

def refresh_recipes_or_nutrition(root, stage, mode):
    shutil.copytree(root / 'scripts', stage / 'scripts')
    (stage / 'data').mkdir()
    shutil.copy2(root / 'data/recipes.json', stage / 'data/recipes.json')
    shutil.copytree(root / 'data/nutrition', stage / 'data/nutrition')
    if mode == 'recipes':
        (stage / 'assets').mkdir()
        if (root / 'assets/images').exists():
            shutil.copytree(root / 'assets/images', stage / 'assets/images')
        run_script(stage, 'sync-recipes.py', '--full')
        validate_recipes(stage)
        check_count({'count': len(read(root / 'data/recipes.json')['recipes'])}, {'count': len(read(stage / 'data/recipes.json')['recipes'])})
        paths = ['data/recipes.json', 'data/raw-full.json', 'assets/data.js']
    else:
        run_script(stage, 'sync-nutrition.py')
        run_script(stage, 'validate-food-data.py')
        previous = {item['id']: item for item in read(root / 'data/nutrition/manifest.json')['datasets']}
        for current in read(stage / 'data/nutrition/manifest.json')['datasets']:
            check_count(previous.get(current['id'], {}), current)
        paths = ['data/nutrition']
    run_script(stage, 'build-food-links.py')
    run_script(stage, 'validate-food-links.py')
    promote(root, stage, paths + ['data/food-links.json.gz', 'data/integration-status.json'])
    return [], []

def refresh(root, mode, config):
    started = now()
    services = OFFICIAL if mode == 'official-all' else config['jobs'][mode]['services']
    failed, fallback, error = [], [], None
    (root / '.cache').mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(dir=root / '.cache', prefix='data-generation-') as directory:
            stage = Path(directory)
            if mode in ('recipes', 'nutrition'):
                failed, fallback = refresh_recipes_or_nutrition(root, stage, mode)
            else:
                failed, fallback = refresh_official(root, stage, services)
    except Exception as exc:
        # Credential-bearing urllib/subprocess exceptions must never be serialized.
        error = '검증·변환 실패: ' + type(exc).__name__ + '. 마지막 정상 수집본을 유지합니다.'
        failed = services
        print(error, flush=True)
    status = 'failed' if error else 'partial' if failed else 'warning' if fallback else 'success'
    entry = {'mode': mode, 'status': status, 'startedAt': started, 'completedAt': now(), 'services': services, 'failedServices': failed, 'bulkFallbackServices': fallback, 'error': error, 'runId': os.environ.get('GITHUB_RUN_ID'), 'runUrl': os.environ.get('GITHUB_SERVER_URL', 'https://github.com') + '/' + os.environ.get('GITHUB_REPOSITORY', 'softm/foodhannun') + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', '')}
    journal = read(root / 'data/collection-runs.json', {'schemaVersion': 1, 'runs': {}})
    journal['runs'][mode] = entry
    if status in ('success', 'warning'):
        journal['runs'][mode]['lastSuccessAt'] = entry['completedAt']
    elif previous := read(root / 'data/collection-runs.json', {}).get('runs', {}).get(mode, {}).get('lastSuccessAt'):
        journal['runs'][mode]['lastSuccessAt'] = previous
    write(root / 'data/collection-runs.json', journal)
    run_script(root, 'build-data-status.py')
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a') as stream:
            stream.write('collection_failed=' + str(bool(failed)).lower() + '\n')
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a') as stream:
            stream.write(f'## 데이터 자동 갱신: {mode}\n\n상태: {status}\n\n대상: {", ".join(services)}\n\n실패 시 이전 정상본을 보존합니다. 상세: data-status.html\n')
    print(json.dumps(entry, ensure_ascii=False), flush=True)
    return entry

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='')
    parser.add_argument('--schedule', default='')
    parser.add_argument('--resolve-only', action='store_true')
    args = parser.parse_args()
    config = read(ROOT / 'config/collection-schedules.json')
    selected = select_mode(config, args.mode, args.schedule)
    if args.resolve_only: print(selected)
    else: refresh(ROOT, selected, config)

if __name__ == '__main__':
    main()

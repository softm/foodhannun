#!/usr/bin/env python3
"""Exercise scheduled selection, isolated failure recovery and identifier reindexing."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

sync = load('refresh-food-data')
builder = load('build-foodsafety-index')
publisher = load('publish-food-data')

def source(root, service, rows, fetched='2026-10-20T00:00:00Z'):
    directory = root / 'data/collection' / service
    directory.mkdir(parents=True, exist_ok=True)
    blob = gzip.compress(('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\n').encode(), mtime=0)
    name = 'records-0000.jsonl.gz'
    (directory / name).write_bytes(blob)
    status = {'id': service, 'name': service, 'status': 'complete', 'count': len(rows), 'sourceTotal': len(rows), 'uniqueRecords': len(rows), 'sourceFields': list(rows[0]) if rows else [], 'fetchedAt': fetched, 'sourceUrl': 'https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=' + service, 'chunks': [{'path': name, 'count': len(rows), 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}]}
    (directory / 'status.json').write_text(json.dumps(status))
    return status

def compile_root(root):
    with patch.object(sys, 'argv', ['builder', '--root', str(root)]), contextlib.redirect_stdout(io.StringIO()):
        builder.main()
    return json.loads((root / 'data/food-safety/manifest.json').read_text())

class AutomationTests(unittest.TestCase):
    def test_recipe_validation_checks_the_actual_api_envelope_and_browser_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);(root / 'data').mkdir();(root / 'assets').mkdir()
            data = {'meta': {'datasetMode': 'official-full', 'count': 1, 'totalAvailable': 1}, 'recipes': [{'id': '1'}]}
            sync.write(root / 'data/recipes.json', data)
            sync.write(root / 'data/raw-full.json', {'COOKRCP01': {'total_count': '1', 'row': [{'RCP_SEQ': '1'}]}})
            (root / 'assets/data.js').write_text('window.FOOD_DATA = ' + json.dumps(data) + ';\n')
            sync.validate_recipes(root)
            (root / 'assets/data.js').write_text('window.FOOD_DATA = {};\n')
            with self.assertRaises(AssertionError): sync.validate_recipes(root)

    def test_recall_bulk_fallback_is_explicit_and_preserves_the_live_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = source(root, 'I0490', [{'PRDTNM': '기존 공고'}])
            stage = root / 'stage';stage.mkdir();shutil.copytree(root / 'data', stage / 'data', copy_function=sync.link_copy)
            def collect(service, attempt, prefer_pages=False):
                if prefer_pages:
                    sync.fail_service(attempt, previous, 'API 총건수 불일치')
                    return False
                shutil.copy2(root / 'data/collection/I0490/records-0000.jsonl.gz', attempt / 'records-0000.jsonl.gz')
                sync.write(attempt / 'status.json', {**previous, 'method': 'official-bulk-file'})
                return True
            with contextlib.redirect_stdout(io.StringIO()):
                success, fallback = sync.collect_service(Mock(collect=collect), Mock(validate=Mock(return_value=True)), root, stage, 'I0490')
            self.assertTrue(success);self.assertTrue(fallback)
            status = sync.read(stage / 'data/collection/I0490/status.json')
            self.assertEqual(status['apiPageAttemptReason'], 'API 총건수 불일치')
            self.assertEqual(sync.read(root / 'data/collection/I0490/status.json'), previous)

    def test_every_schedule_has_one_owner_and_no_legacy_schedule(self):
        config = json.loads((sync.ROOT / 'config/collection-schedules.json').read_text())
        workflow = (sync.ROOT / '.github/workflows/sync-food-data.yml').read_text()
        for mode, schedule in config['jobs'].items():
            self.assertEqual(sync.select_mode(config, schedule=schedule['cronUtc']), mode)
            self.assertEqual(workflow.count("cron: '" + schedule['cronUtc'] + "'"), 1)
            self.assertNotIn('C005', schedule['services'])
        for old in ['sync-recipes.yml', 'collect-nutrition.yml', 'collect-additional-data.yml']:
            self.assertNotIn('\n  schedule:', (sync.ROOT / '.github/workflows' / old).read_text())
        self.assertNotIn('C005', sync.OFFICIAL)
        with self.assertRaises(ValueError): sync.select_mode(config, schedule='unknown')
        with self.assertRaises(ValueError): sync.select_mode(config, mode='untrusted-input')

    def test_empty_and_truncated_sources_cannot_replace_a_populated_source(self):
        for count in (0, 1, 49):
            with self.assertRaises(ValueError): sync.check_count({'count': 100}, {'count': count})
        sync.check_count({'count': 100}, {'count': 99})

    def test_failed_download_cannot_modify_linked_original_or_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = source(root, 'I1250', [{'PRDLST_REPORT_NO': '2015063158335'}])
            folder = root / 'data/collection/I1250'
            (folder / 'source-original.gz').write_bytes(b'last-good-original')
            stage = root / 'stage';stage.mkdir()
            shutil.copytree(root / 'data', stage / 'data', copy_function=sync.link_copy)
            def fail(service, target, **kwargs):
                (target / 'source-original.gz').write_bytes(b'bad-download')
                sync.fail_service(target, original, 'test failure')
                return False
            success, _ = sync.collect_service(Mock(collect=fail), Mock(), root, stage, 'I1250')
            self.assertFalse(success)
            self.assertEqual((folder / 'source-original.gz').read_bytes(), b'last-good-original')
            self.assertEqual(json.loads((folder / 'status.json').read_text()), original)
            self.assertEqual(json.loads((stage / 'data/collection/I1250/status.json').read_text())['lastAttemptStatus'], 'failed')

    def test_zero_row_success_is_rejected_before_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);old = source(root, 'I1250', [{'PRDLST_REPORT_NO': '2015063158335'}])
            stage = root / 'stage';stage.mkdir();shutil.copytree(root / 'data', stage / 'data', copy_function=sync.link_copy)
            def empty(service, target, **kwargs):
                sync.write(target / 'status.json', {**old, 'count': 0, 'sourceTotal': 0})
                return True
            success, _ = sync.collect_service(Mock(collect=empty), Mock(), root, stage, 'I1250')
            self.assertFalse(success)
            self.assertEqual(json.loads((root / 'data/collection/I1250/status.json').read_text())['count'], 1)

    def test_promotion_rolls_back_the_whole_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);(root / '.cache').mkdir();stage = root / 'stage';stage.mkdir()
            for name in ['a', 'b']:
                (root / name).write_text('old-' + name);(stage / name).write_text('new-' + name)
            replace = os.replace
            def interrupted(source, target):
                if source == stage / 'b': raise OSError('simulated disk failure')
                return replace(source, target)
            with patch.object(sync.os, 'replace', side_effect=interrupted), self.assertRaises(OSError):
                sync.promote(root, stage, ['a', 'b'])
            self.assertEqual((root / 'a').read_text(), 'old-a')
            self.assertEqual((root / 'b').read_text(), 'old-b')

    def test_incremental_recall_offsets_match_full_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source(root, 'I1250', [{'PRDLST_REPORT_NO': '2015063158335', 'LCNS_NO': '20150631583', 'PRDLST_NM': '제품'}])
            source(root, 'I0490', [{'PRDLST_REPORT_NO': '2015063158335', 'PRDTNM': '기존 공고'}])
            old = compile_root(root)
            source(root, 'I0490', [{'PRDLST_REPORT_NO': '202504053896', 'PRDTNM': '새 공고'}, {'PRDLST_REPORT_NO': '2015063158335', 'PRDTNM': '기존 공고'}])
            rows_for = builder.rows_for
            def selected_only(collection, status):
                if status['id'] == 'I1250': raise AssertionError('Unchanged million-row source was reread')
                return rows_for(collection, status)
            with patch.object(builder, 'rows_for', side_effect=selected_only): incremental = compile_root(root)
            self.assertEqual(old['services']['I1250']['index'], incremental['services']['I1250']['index'])
            shutil.rmtree(root / 'data/food-safety')
            full = compile_root(root)
            self.assertEqual(incremental['counts'], full['counts'])
            self.assertEqual(incremental['lookupFiles'], full['lookupFiles'])
            self.assertEqual(incremental['services'], full['services'])

    def test_unchanged_data_updates_freshness_without_reading_raw_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);rows = [{'PRDLST_REPORT_NO': '2015063158335'}]
            source(root, 'I1250', rows);old = compile_root(root)
            source(root, 'I1250', rows, fetched='2026-10-21T00:00:00Z')
            with patch.object(builder, 'rows_for', side_effect=AssertionError('Unnecessary rebuild')): new = compile_root(root)
            self.assertEqual(old['lookupFiles'], new['lookupFiles'])
            self.assertEqual(new['services']['I1250']['fetchedAt'], '2026-10-21T00:00:00Z')

    def test_replacing_a_linked_index_does_not_modify_the_live_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);live = root / 'live.gz';staged = root / 'staged.gz'
            live.write_bytes(b'old-index');os.link(live, staged)
            builder.gzip_json(staged, {'rows': []})
            self.assertEqual(live.read_bytes(), b'old-index')

    def test_failed_job_keeps_last_success_and_redacts_exception_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);(root / 'data').mkdir()
            sync.write(root / 'data/collection-runs.json', {'runs': {'recalls': {'lastSuccessAt': '2026-10-20T00:00:00Z'}}})
            with patch.object(sync, 'refresh_official', side_effect=RuntimeError('secret-url-value')), patch.object(sync, 'run_script'), contextlib.redirect_stdout(io.StringIO()):
                entry = sync.refresh(root, 'recalls', {'jobs': {'recalls': {'services': ['I0490']}}})
            self.assertEqual(entry['status'], 'failed')
            saved = (root / 'data/collection-runs.json').read_text()
            self.assertNotIn('secret-url-value', saved)
            self.assertIn('2026-10-20T00:00:00Z', saved)

    def test_rebase_conflict_never_pushes_or_requests_deployment(self):
        calls = []
        def git(*args, **kwargs):
            calls.append(args)
            if args[0] == 'diff': return 'data/collection-status.json'
            if args[0] == 'rebase': raise subprocess.CalledProcessError(1, ['git', 'rebase'])
        with patch.object(publisher, 'git', side_effect=git), patch.object(publisher, 'api') as api, self.assertRaises(subprocess.CalledProcessError):
            publisher.publish('recalls')
        self.assertFalse(any(args[0] == 'push' for args in calls));api.assert_not_called()

if __name__ == '__main__':
    unittest.main()

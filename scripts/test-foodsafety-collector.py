#!/usr/bin/env python3
import contextlib,gzip,importlib.util,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect-foodsafety.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class CollectorTests(unittest.TestCase):
    def test_transient_key_lock_is_retried(self):
        with patch.object(module,'fetch_page_once',side_effect=[module.CollectionError('공식 API 응답 INFO-500'),([{'a':'b'}],1)]),patch.object(module.time,'sleep') as sleep,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.fetch_page('I2520','not-a-real-key',1,1000)[1],1);sleep.assert_called_once()
    def test_utf8_sample_can_end_mid_character(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'bulk.csv';p.write_text('A,B\n'+('가'*50000)+',값\n',encoding='utf-8')
            rows=list(module.file_rows(p));self.assertEqual(rows[0]['B'],'값')
    def test_gzip_bulk(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'bulk';p.write_bytes(gzip.compress(b'A,B\nx,y\n'));self.assertEqual(list(module.file_rows(p)),[{'A':'x','B':'y'}])
    def test_complete_shards_and_failed_retry_preserves_previous(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'FOODSAFETY_API_KEY':'dummy-private-key'}),patch.object(module.time,'sleep'),patch.object(module,'BULK_THRESHOLD',95000),contextlib.redirect_stdout(io.StringIO()):
            p=Path(d)/'I2520';rows=[{'CODE':str(i)} for i in range(10001)]
            with patch.object(module,'fetch_page',side_effect=[(rows[:1000],10001)]+[(rows[i:i+1000],10001) for i in range(1000,10001,1000)]):
                self.assertTrue(module.collect('I2520',p))
            old=json.loads((p/'status.json').read_text());self.assertEqual(len(old['chunks']),2);self.assertEqual(old['uniqueRecords'],10001)
            raw=(p/old['chunks'][0]['path']).read_bytes()
            with patch.object(module,'fetch_page',side_effect=module.CollectionError('공식 API 응답 INFO-500')):
                self.assertFalse(module.collect('I2520',p))
            latest=json.loads((p/'status.json').read_text());self.assertEqual(latest['count'],10001);self.assertEqual(latest['status'],'complete');self.assertEqual((p/old['chunks'][0]['path']).read_bytes(),raw)
            self.assertNotIn('dummy-private-key',(p/'status.json').read_text())
    def test_mismatched_count_is_partial(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'FOODSAFETY_API_KEY':'dummy-key'}),patch.object(module.time,'sleep'),contextlib.redirect_stdout(io.StringIO()):
            p=Path(d)/'I2520'
            with patch.object(module,'fetch_page',side_effect=[([{'CODE':'1'}],2),([],2)]):self.assertFalse(module.collect('I2520',p))
            self.assertEqual(json.loads((p/'status.json').read_text())['status'],'partial');self.assertFalse(list(p.glob('records*.gz')))
if __name__=='__main__':unittest.main()

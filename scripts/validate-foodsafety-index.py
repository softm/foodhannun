#!/usr/bin/env python3
import argparse,gzip,hashlib,json
from pathlib import Path

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=parser.parse_args()
 base=args.root/'data/food-safety';manifest=json.loads((base/'manifest.json').read_text());total=0
 def read(item):
  raw=(base/item['path']).read_bytes();assert len(raw)==item['bytes'];assert hashlib.sha256(raw).hexdigest()==item['sha256'];return json.loads(gzip.decompress(raw))
 for service,source in manifest['services'].items():
  if source['status']!='complete':continue
  index=read(source['index'])['rows'];assert len(index)==source['count']==source['sourceTotal']
  for item in index:
   chunk=source.get('chunks',[{'count':source['count']}])[item[4]]
   assert 0<=item[5]<chunk['count']
  total+=len(index);print(service,len(index),'search pointers valid',flush=True)
 refs=0
 for descriptor in manifest['lookupFiles'].values():
  for key,pointers in read(descriptor).items():
   assert key.split(':',1)[0] in ('report','barcode','license','raw','name')
   for service,part,offset in pointers:
    source=manifest['services'][service];assert source['status']=='complete'
    assert 0<=offset<source['chunks'][part]['count'];refs+=1
 assert refs==manifest['counts']['lookupPointers'];assert total==manifest['counts']['indexedRecords']
 print(f'Validated {total:,} source records and {refs:,} exact identifier pointers.')
if __name__=='__main__':main()

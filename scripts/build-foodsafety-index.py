#!/usr/bin/env python3
"""Build source search indexes and exact identifier lookups; preserve raw API rows."""
import argparse,gzip,hashlib,json,sqlite3,tempfile,os
from pathlib import Path
import re,unicodedata

ALIASES={
 'name':['PRDLST_NM','PRDTNM','PRDUCT','PRDUCT_NM','RPRSNT_RAWMTRL_NM','RAWMTRL_NM','KOR_NM','KOR_FOOD_NM','FOOD_NM'],
 'type':['PRDLST_DCNM','PRDLST_CD_NM','PRDLST_TYPE','RAWMTRL_MLSFC_NM','MLSFC_NM','LCLAS_NM','INDUTY_CD_NM','BIZ_TYPE_NM'],
 'maker':['BSSH_NM','BSSHNM','BSSH_NM1','COMPANY','ENTRPS','BIZ_NM'],
 'report':['PRDLST_REPORT_NO','PRDLST_REPORT_NUM','PRDLSTREPORTNO'],
 'license':['LCNS_NO','LCNSNO','LICENSE_NO'],
 'barcode':['BRCD_NO','BRCDNO','BAR_CD','BARCODE','BAR_CD_NO'],
 'raw':['RAWMTRL_CD','RAWMTRL_CODE','FOOD_CD'],
 'alias':['RAWMTRL_NCKNM','NCKNM','ENG_NM','SCNM'],
}
def first(row,kind):
 return next((str(row[k]).strip() for k in ALIASES[kind] if row.get(k) not in (None,'')), '')
def normalize(value):return re.sub(r'[\s·ㆍ,()[\]#&:_-]','',unicodedata.normalize('NFC',str(value))).lower()
def number(value):
 value=str(value).strip()
 return value if re.fullmatch(r'\d{8,25}',value) else ''
def bucket(value):
 result=2166136261
 for byte in value.encode('utf-8'):result=((result^byte)*16777619)&0xffffffff
 return result%256

def gzip_json(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 raw=gzip.compress(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode(),mtime=0)
 temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_bytes(raw);os.replace(temporary,path)
 return {'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
def rows_for(root,status):
 chunks=status.get('chunks') or ([{'path':status['path'],'count':status['count']}] if status.get('path') else [])
 for i,chunk in enumerate(chunks):
  with gzip.open(root/status['id']/chunk['path'],'rt',encoding='utf-8') as f:
   for j,line in enumerate(f):yield i,j,json.loads(line)

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=parser.parse_args()
 root=args.root.resolve();collection=root/'data/collection';output=root/'data/food-safety';output.mkdir(exist_ok=True)
 services={p.parent.name:json.loads(p.read_text()) for p in sorted(collection.glob('*/status.json'))}
 previous_path=output/'manifest.json'
 previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
 changed=set(previous.get('services',{}))-set(services)
 def signature(status):
  return (status.get('status'),status.get('count'),status.get('sourceTotal'),[(p.get('path'),p.get('count'),p.get('sha256')) for p in status.get('chunks',[])])
 manifest={'schemaVersion':1,'services':{},'lookupBuckets':256,'lookupPath':'lookup/{bucket}.json.gz'}
 stats={'sourceRecords':0,'indexedRecords':0,'lookupPointers':0}
 with tempfile.TemporaryDirectory() as directory:
  db=sqlite3.connect(Path(directory)/'joins.sqlite');db.execute('CREATE TABLE refs(bucket INTEGER,key TEXT,service TEXT,part INTEGER,offset INTEGER)')
  for service,status in services.items():
   info={k:v for k,v in status.items() if k not in ('sourceFields','bulkPrefixHex')};manifest['services'][service]=info
   if status['status']!='complete':
    if service in previous.get('services',{}):changed.add(service)
    continue
   old=previous.get('services',{}).get(service,{})
   descriptor=old.get('index')
   if descriptor and signature(old)==signature(status) and (output/descriptor['path']).is_file():
    raw=(output/descriptor['path']).read_bytes()
    if len(raw)==descriptor['bytes'] and hashlib.sha256(raw).hexdigest()==descriptor['sha256']:
     info['index']=descriptor;stats['sourceRecords']+=status['count'];stats['indexedRecords']+=status['count']
     print(f'{service}: reused verified {status["count"]:,} search pointers',flush=True);continue
   changed.add(service)
   index=[];batch=[];count=0
   for part,offset,row in rows_for(collection,status):
    name,kind,maker=first(row,'name'),first(row,'type'),first(row,'maker')
    report,license,barcode,raw=number(first(row,'report')),number(first(row,'license')),number(first(row,'barcode')),first(row,'raw')
    identifier=report or barcode or raw or str(row.get('RTRVLDSUSE_SEQ') or row.get('HACCP_APPN_NO') or row.get('HACCP_CERTI_NO') or count+1)
    index.append([identifier,name or maker or identifier,kind,maker,part,offset,'',report,license,barcode,raw,first(row,'alias')])
    keys=[]
    if report:keys.append('report:'+report)
    if barcode:keys.append('barcode:'+barcode)
    if service=='I0580' and license:keys.append('license:'+license)
    if service in ('I1020','I2520'):
     if raw:keys.append('raw:'+raw)
     for field in ['RPRSNT_RAWMTRL_NM','RAWMTRL_NM','KOR_NM']:
      if row.get(field):keys.append('name:'+normalize(row[field]))
     for alias in re.split(r'[,;\n]',str(row.get('RAWMTRL_NCKNM') or '')):
      if alias.strip():keys.append('name:'+normalize(alias))
    for key in set(keys):batch.append((bucket(key),key,service,part,offset))
    count+=1
    if len(batch)>10000:db.executemany('INSERT INTO refs VALUES (?,?,?,?,?)',batch);db.commit();stats['lookupPointers']+=len(batch);batch.clear()
   if batch:db.executemany('INSERT INTO refs VALUES (?,?,?,?,?)',batch);db.commit();stats['lookupPointers']+=len(batch)
   assert count==status['count']==status['sourceTotal']
   descriptor=gzip_json(output/service/'index.json.gz',{'rows':index})
   descriptor['path']=str(Path(descriptor['path']).relative_to(output));info['index']=descriptor
   stats['sourceRecords']+=count;stats['indexedRecords']+=len(index)
   print(f'{service}: indexed {count:,} records',flush=True)
  db.execute('CREATE INDEX refs_by_bucket ON refs(bucket,key)');db.commit()
  descriptors={}
  for i in range(256):
   name=f'{i:02x}'
   old_file=previous.get('lookupFiles',{}).get(name)
   if not changed and old_file:
    descriptors[name]=old_file;continue
   records={}
   if old_file:
    blob=(output/old_file['path']).read_bytes()
    assert hashlib.sha256(blob).hexdigest()==old_file['sha256'],'Existing lookup hash mismatch'
    for key,pointers in json.loads(gzip.decompress(blob)).items():
     kept=[p for p in pointers if p[0] not in changed]
     if kept:records[key]=kept
   for key,service,part,offset in db.execute('SELECT key,service,part,offset FROM refs WHERE bucket=? ORDER BY key,service,part,offset',(i,)):
    records.setdefault(key,[]).append([service,part,offset])
   records={key:sorted(pointers) for key,pointers in sorted(records.items())}
   descriptor=gzip_json(output/'lookup'/f'{name}.json.gz',records)
   descriptor['path']=str(Path(descriptor['path']).relative_to(output));descriptors[name]=descriptor
  db.close();manifest['lookupFiles']=descriptors
  if not changed and previous.get('lookupFiles'):
   stats['lookupPointers']=previous['counts']['lookupPointers']
  else:
   stats['lookupPointers']=sum(len(pointers) for descriptor in descriptors.values() for pointers in json.loads(gzip.decompress((output/descriptor['path']).read_bytes())).values())
 manifest['counts']=stats
 temporary=output/'manifest.json.tmp';temporary.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')));os.replace(temporary,output/'manifest.json')
 print(json.dumps(stats,ensure_ascii=False))
if __name__=='__main__':main()

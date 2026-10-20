#!/usr/bin/env python3
"""Build explainable name candidates; never join nutrient values or assert identity."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
def normalize(value):
    return re.sub(r'[\s·ㆍ,()[\]#&:_-]', '', unicodedata.normalize('NFC', str(value))).lower()
def identity(value):
    return normalize(value).replace('계란', '달걀').replace('북엇국', '북어국')
def relation(recipe_name, food_name):
    if normalize(recipe_name) == normalize(food_name):
        return {'kind':'name-exact','term':food_name,'label':'음식명 일치'}
    if identity(recipe_name) == identity(food_name):
        return {'kind':'alias-exact','term':food_name,'label':'별칭 일치'}
    family = food_name.split('_')[0].strip()
    if len(identity(family)) >= 3 and identity(family) in identity(recipe_name):
        return {'kind':'name-in-title','term':family,'label':'음식명 포함 후보'}
    return None

def build():
    recipes_path = ROOT / 'data/recipes.json'
    manifest_path = ROOT / 'data/nutrition/manifest.json'
    recipes = json.loads(recipes_path.read_text())['recipes']
    manifest = json.loads(manifest_path.read_text())
    dataset = next(d for d in manifest['datasets'] if d['id'] == 'foods')
    index_path = ROOT / 'data/nutrition' / dataset['index']['path']
    assert hashlib.sha256(index_path.read_bytes()).hexdigest() == dataset['index']['sha256']
    rows = json.loads(gzip.decompress(index_path.read_bytes()))['rows']
    families = {}
    for row in rows:
        families.setdefault(identity(row[1].split('_')[0]), []).append(row)
    links, counts = {}, {'recipes':len(recipes), 'withNameMatch':0, 'withRelatedCandidates':0, 'withoutCandidates':0, 'shownCandidates':0}
    for recipe in recipes:
        candidates = []
        title = identity(recipe['name'])
        for family, items in families.items():
            if family != title and (len(family) < 3 or family not in title):
                continue
            for row in items:
                evidence = relation(recipe['name'], row[1])
                if evidence:
                    candidates.append({'group':'foods', 'source':dataset['name'], 'row':row, 'evidence':evidence})
        rank = {'name-exact':0,'alias-exact':1,'name-in-title':2}
        candidates.sort(key=lambda c:(rank[c['evidence']['kind']], -len(identity(c['evidence']['term']))))
        # Only show the most specific family, while keeping all exact/alias name matches.
        best = max((len(identity(c['evidence']['term'])) for c in candidates if c['evidence']['kind'] == 'name-in-title'),default=0)
        candidates = [c for c in candidates if c['evidence']['kind'] != 'name-in-title' or len(identity(c['evidence']['term'])) == best]
        shown = candidates[:6]
        links[str(recipe['id'])] = {'name':recipe['name'],'total':len(candidates),'foods':shown}
        if any(c['evidence']['kind'] in ('name-exact','alias-exact') for c in candidates): counts['withNameMatch'] += 1
        elif candidates: counts['withRelatedCandidates'] += 1
        else: counts['withoutCandidates'] += 1
        counts['shownCandidates'] += len(shown)
    result = {'schemaVersion':1,'recipeSha256':hashlib.sha256(recipes_path.read_bytes()).hexdigest(),'foodIndexSha256':dataset['index']['sha256'],'counts':counts,'recipes':links}
    encoded = json.dumps(result,ensure_ascii=False,separators=(',',':')).encode()
    (ROOT / 'data/food-links.json.gz').write_bytes(gzip.compress(encoded,mtime=0))
    audit = {'schemaVersion':1, 'counts':counts, 'recipeSha256':result['recipeSha256'], 'foodIndexSha256':result['foodIndexSha256'], 'rules':['이름 일치·별칭 일치·가장 구체적인 음식명 포함 후보를 구분','계란/달걀, 북엇국/북어국만 연결용 별칭으로 취급','공통 식별키 없음: 동일 레시피 또는 영양값 동등성을 보증하지 않음','제품은 제품명·제조사 검색 결과이며 재료 함유·안전·인증을 추정하지 않음','건강기능식품은 일반 음식·가공식품과 별도 분류'], 'linksPath':'data/food-links.json.gz'}
    (ROOT / 'data/integration-status.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(counts,ensure_ascii=False))
if __name__ == '__main__': build()

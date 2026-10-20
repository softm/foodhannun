#!/usr/bin/env python3
"""Check every recipe-food candidate against the published search index."""
import gzip
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    links=json.loads(gzip.decompress((ROOT/'data/food-links.json.gz').read_bytes()))
    recipes=json.loads((ROOT/'data/recipes.json').read_text())['recipes']
    manifest=json.loads((ROOT/'data/nutrition/manifest.json').read_text())
    dataset=next(d for d in manifest['datasets'] if d['id']=='foods')
    rows=json.loads(gzip.decompress((ROOT/'data/nutrition'/dataset['index']['path']).read_bytes()))['rows']
    by_code={row[0]:row for row in rows}
    assert links['foodIndexSha256']==dataset['index']['sha256']
    assert links['recipeSha256']==hashlib.sha256((ROOT/'data/recipes.json').read_bytes()).hexdigest()
    assert set(links['recipes'])=={str(r['id']) for r in recipes}
    shown=0
    for recipe in recipes:
        link=links['recipes'][str(recipe['id'])]
        assert link['name']==recipe['name'] and len(link['foods'])<=6
        assert link['total']>=len(link['foods'])
        seen=set()
        for item in link['foods']:
            assert item['group']=='foods' and item['row']==by_code[item['row'][0]]
            assert item['row'][0] not in seen
            seen.add(item['row'][0])
            assert item['evidence']['kind'] in ('name-exact','alias-exact','name-in-title')
            assert item['evidence']['term']
            shown+=1
    counts=links['counts']
    assert counts['recipes']==len(recipes)
    assert counts['shownCandidates']==shown
    assert counts['withNameMatch']+counts['withRelatedCandidates']+counts['withoutCandidates']==len(recipes)
    print(f'Validated {len(recipes):,} recipe entries / {shown:,} candidate pointers; no product or supplement nutrient joins.')
if __name__=='__main__': main()

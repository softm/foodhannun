#!/usr/bin/env python3
"""Build an offline-readable collection inventory from actual snapshots only."""
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def main():
    recipes = json.loads((ROOT / 'data/recipes.json').read_text())
    nutrition = json.loads((ROOT / 'data/nutrition/manifest.json').read_text())
    datasets = [{
        'id':'COOKRCP01', 'name':'조리식품 레시피', 'status':'complete',
        'count':len(recipes['recipes']), 'sourceTotal':recipes['meta'].get('totalAvailable'),
        'fetchedAt':recipes['meta'].get('fetchedAt'),
        'sourceUrl':'https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=COOKRCP01',
        'path':'data/recipes.json',
    }, *nutrition['datasets']]
    for path in sorted((ROOT / 'data/collection').glob('*/status.json')):
        item = json.loads(path.read_text())
        item.setdefault('sourceUrl', f"https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no={item['id']}")
        if item.get('reason', '').endswith('INFO-110'):
            item['reason'] = 'INFO-110: 기존 인증키는 유효하지만 이 서비스의 활용신청 내역이 없습니다.'
        datasets.append(item)
    datasets.extend([
        {'id':'rda', 'name':'농촌진흥청 국가표준식품성분표', 'status':'not-collected', 'count':0, 'reason':'공식 원재료성 식품 전체 파일을 별도로 확보해야 합니다.', 'sourceUrl':'https://koreanfood.rda.go.kr/kfi/fct/fctIntro/list?menuId=PS03562'},
        {'id':'nifs', 'name':'국립수산과학원 수산식품 성분표', 'status':'not-collected', 'count':0, 'reason':'기계 판독 가능한 공식 원재료성 식품 전체 파일을 별도로 확보해야 합니다.', 'sourceUrl':'https://www.nifs.go.kr/sfms/userIngredient/userIngredientList.do'},
        {'id':'shopping', 'name':'실시간 쇼핑 가격·재고', 'status':'not-connected', 'count':0, 'reason':'사업자별 제휴/API 연동 필요. 현재 구매처 검색 링크만 제공합니다.'},
        {'id':'reviews', 'name':'사용자 리뷰·평점', 'status':'not-connected', 'count':0, 'reason':'자체 사용자 데이터 수집 또는 이용 권한이 확보된 리뷰 API가 필요합니다.'},
    ])
    completed = [d for d in datasets if d['status'] == 'complete']
    summary = {'generatedAt':datetime.now(timezone.utc).isoformat(timespec='seconds'), 'totalCollectedRecords':sum(d['count'] for d in completed), 'completeDatasets':len(completed), 'nutritionRecords':nutrition['count'], 'datasets':datasets}
    (ROOT / 'data/collection-status.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    labels = {'complete':'전체 수집 완료', 'blocked':'활용신청 필요', 'partial':'일부 수집', 'not-collected':'미수집', 'not-connected':'미연동'}
    rows = []
    for d in datasets:
        name = escape(d['name'])
        if d.get('sourceUrl'):
            name = f'<a href="{escape(d["sourceUrl"])}" target="_blank" rel="noopener">{name} ↗</a>'
        note = d.get('reason') or f"원본 {d.get('sourceTotal',d['count']):,}건 대조 완료"
        if d.get('columnCount'):
            note += f" · 원본 {d['columnCount']}개 열 보존"
        if d.get('freshnessNote'):
            note += ' · ' + d['freshnessNote']
        date = d.get('version') or d.get('fetchedAt') or d.get('attemptedAt') or '—'
        rows.append(f'<tr><th scope="row">{name}<small>{escape(d["id"])}</small></th><td><span class="badge {d["status"]}">{labels.get(d["status"],d["status"])}</span></td><td class="num">{d["count"]:,}</td><td>{escape(date)}</td><td>{escape(note)}</td></tr>')
    page = '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>데이터 수집 현황 · 음식한눈</title><link rel="stylesheet" href="assets/data-browser.css"><body><main class="data-page"><nav><a href="./">← 음식한눈</a><a href="food-data.html">영양·제품 검색 →</a></nav><p class="eyebrow">DATA COLLECTION</p><h1>데이터 수집 현황</h1><p>확보한 공식 원본과 검증된 실제 수집 건수입니다. 데이터 종류별 레코드 합계이며, 서로 다른 DB의 동일 음식이 중복될 수 있습니다.</p><div class="metrics"><div><span>레시피</span><strong>RECIPE_COUNT</strong></div><div><span>추가 영양·제품 데이터</span><strong>NUTRITION_COUNT</strong></div><div><span>전체 수집 완료 데이터셋</span><strong>COMPLETE_COUNT종</strong></div></div><p class="notice">영양·제품 데이터는 별도 검색에서 확인할 수 있습니다. 영양값은 각 원본의 ‘영양성분함량기준량’에 따라 표시하며 레시피 영양값을 덮어쓰지 않습니다.</p><div class="table-scroll"><table><thead><tr><th>데이터</th><th>상태</th><th>수집 건수</th><th>버전 / 수집·시도 시각(UTC)</th><th>검증 결과·남은 조건</th></tr></thead><tbody>TABLE_ROWS</tbody></table></div><p class="notice">INFO-110은 새 인증키 발급이 필요한 오류가 아닙니다. 식품안전나라 로그인 후 해당 서비스의 OpenAPI 이용신청을 추가한 다음 수집을 다시 실행해야 합니다.</p><p><a href="data/collection-status.json">전체 수집 상태 JSON</a> · <a href="data/nutrition/manifest.json">영양 데이터 구성·검증값</a></p><footer>식품영양성분 데이터베이스 (K-FCDB), 식품의약품안전처 · 식품안전나라 COOKRCP01<br>음식한눈은 정부기관이 운영하는 공식 서비스가 아닙니다.</footer></main></body></html>'''
    page = page.replace('RECIPE_COUNT',f"{len(recipes['recipes']):,}").replace('NUTRITION_COUNT', f"{nutrition['count']:,}").replace('COMPLETE_COUNT',str(len(completed))).replace('TABLE_ROWS',''.join(rows))
    (ROOT / 'data-status.html').write_text(page, encoding='utf-8')
    print(f"수집 현황: {len(completed)}종 / {summary['totalCollectedRecords']:,}개 레코드")
if __name__ == '__main__':
    main()

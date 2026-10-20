#!/usr/bin/env python3
"""Build an offline-readable collection inventory from actual snapshots only."""
from datetime import datetime, timezone
from html import escape
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get('FOODHANNUN_ROOT', Path(__file__).resolve().parents[1]))
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
    integration_path = ROOT / 'data/integration-status.json'
    integration = json.loads(integration_path.read_text()) if integration_path.exists() else None
    safety_path = ROOT / 'data/food-safety/manifest.json'
    safety = json.loads(safety_path.read_text()) if safety_path.exists() else None
    schedule_path = ROOT / 'config/collection-schedules.json'
    schedules = json.loads(schedule_path.read_text()) if schedule_path.exists() else {'jobs':{}}
    runs_path = ROOT / 'data/collection-runs.json'
    runs = json.loads(runs_path.read_text()).get('runs',{}) if runs_path.exists() else {}
    automation = {'timeZone':'Asia/Seoul','schedules':schedules.get('jobs',{}),'historical':schedules.get('historical',[]),'runs':runs}
    completed = [d for d in datasets if d['status'] == 'complete']
    summary = {'generatedAt':datetime.now(timezone.utc).isoformat(timespec='seconds'), 'totalCollectedRecords':sum(d['count'] for d in completed), 'completeDatasets':len(completed), 'nutritionRecords':nutrition['count'], 'datasets':datasets, 'integration':integration, 'officialSourceIntegration':safety.get('counts') if safety else None, 'automation':automation}
    (ROOT / 'data/collection-status.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    labels = {'complete':'전체 수집 완료', 'blocked':'수집 재시도 필요', 'partial':'일부 수집', 'not-collected':'미수집', 'not-connected':'미연동'}
    rows = []
    for d in datasets:
        name = escape(d['name'])
        if d.get('sourceUrl'):
            name = f'<a href="{escape(d["sourceUrl"])}" target="_blank" rel="noopener">{name} ↗</a>'
        note = d.get('reason') or f"원본 {d.get('sourceTotal',d['count']):,}건 대조 완료"
        if d.get('countBasis') == 'official-file-row-count':
            note = f"공식 전체파일 {d['count']:,}행 변환·전수 검증 완료"
            if d.get('countNote'): note += ' · ' + d['countNote']
        if d.get('columnCount'):
            note += f" · 원본 {d['columnCount']}개 열 보존"
        if d.get('freshnessNote'):
            note += ' · ' + d['freshnessNote']
        if d.get('lastAttemptReason'):
            note += ' · 최근 갱신 실패, 기존 정상본 유지: ' + d['lastAttemptReason'] + ' (' + d.get('lastAttemptAt','') + ')'
        date = d.get('version') or d.get('fetchedAt') or d.get('attemptedAt') or '—'
        label = '활용신청 필요' if d['status'] == 'blocked' and 'INFO-110' in d.get('reason','') else labels.get(d['status'],d['status'])
        rows.append(f'<tr><th scope="row">{name}<small>{escape(d["id"])}</small></th><td><span class="badge {d["status"]}">{label}</span></td><td class="num">{d["count"]:,}</td><td>{escape(date)}</td><td>{escape(note)}</td></tr>')
    page = '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>데이터 수집 현황 · 음식한눈</title><link rel="stylesheet" href="assets/data-browser.css"><body><main class="data-page"><nav><a href="./">← 음식한눈</a><a href="food-data.html">영양·제품 검색 →</a></nav><p class="eyebrow">DATA COLLECTION</p><h1>데이터 수집 현황</h1><p>확보한 공식 원본과 검증된 실제 수집 건수입니다. 데이터 종류별 레코드 합계이며, 서로 다른 DB의 동일 음식이 중복될 수 있습니다.</p><div class="metrics"><div><span>레시피</span><strong>RECIPE_COUNT</strong></div><div><span>추가 영양·제품 데이터</span><strong>NUTRITION_COUNT</strong></div><div><span>전체 수집 완료 데이터셋</span><strong>COMPLETE_COUNT종</strong></div></div><p class="notice">메인 통합검색에서 레시피·음식 영양·가공식품·건강기능식품을 함께 찾을 수 있습니다. 영양값은 원본의 함량기준량 또는 제공단위량에 따라 표시합니다. 이름 기반 연결 후보를 레시피의 영양값으로 합산하지 않습니다.</p>INTEGRATION_SECTION<div class="table-scroll"><table><thead><tr><th>데이터</th><th>상태</th><th>수집 건수</th><th>버전 / 수집·시도 시각(UTC)</th><th>검증 결과·남은 조건</th></tr></thead><tbody>TABLE_ROWS</tbody></table></div><p class="notice">INFO-110은 새 인증키 발급이 필요한 오류가 아닙니다. 식품안전나라 로그인 후 해당 서비스의 OpenAPI 이용신청을 추가한 다음 수집을 다시 실행해야 합니다.</p><p><a href="data/collection-status.json">전체 수집 상태 JSON</a> · <a href="data/nutrition/manifest.json">영양 데이터 구성·검증값</a></p><footer>식품영양성분 데이터베이스 (K-FCDB), 식품의약품안전처 · 식품안전나라 COOKRCP01<br>음식한눈은 정부기관이 운영하는 공식 서비스가 아닙니다.</footer></main></body></html>'''
    page = page.replace('RECIPE_COUNT',f"{len(recipes['recipes']):,}").replace('NUTRITION_COUNT', f"{nutrition['count']:,}").replace('COMPLETE_COUNT',str(len(completed))).replace('TABLE_ROWS',''.join(rows))
    def kst(value):
        if not value:return '아직 실행 기록 없음'
        from datetime import timedelta
        return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=9))).strftime('%Y-%m-%d %H:%M:%S')
    automation_rows=[]
    outcome_labels={'success':'수집·검증 성공','warning':'전체파일 대체 사용','partial':'일부 갱신 실패 · 정상본 보존','failed':'갱신 실패 · 정상본 보존'}
    for key,schedule in schedules.get('jobs',{}).items():
        attempt=runs.get(key,{})
        label=outcome_labels.get(attempt.get('status'),'첫 정기 실행 대기')
        result=escape(label)
        if attempt.get('runUrl'):result=f'<a href="{escape(attempt["runUrl"])}" target="_blank" rel="noopener">{result} ↗</a>'
        automation_rows.append(f'<tr><th scope="row">{escape(schedule["name"])}</th><td>{escape(schedule["scheduleKst"])}</td><td>{escape(kst(attempt.get("completedAt")))}</td><td>{result}</td><td>검증 후 자동 반영</td></tr>')
    automation_section='<section><h2>정기 자동 수집·운영 반영</h2><p>한국 시간(KST) 기준 예약입니다. 각 수집 그룹은 원문 검증·연결 인덱스 확인 후 함께 반영하고 Pages 배포를 명시적으로 요청합니다. 최근 결과는 수집·검증 상태이며 배포 결과는 연결된 실행 이력에서 확인하세요.</p><div class="table-scroll"><table><thead><tr><th>수집 그룹</th><th>주기(KST)</th><th>최근 시도 완료(KST)</th><th>최근 수집·검증</th><th>운영 반영</th></tr></thead><tbody>'+''.join(automation_rows)+'</tbody></table></div><p class="source-note">C005는 2018년 이후 갱신 중단 자료로 기존 검증본을 보존합니다. 회수 API 전체 건수 대조 실패 시 공식 전체파일로 대체하고 해당 제한을 표시합니다.</p><p><a href="https://github.com/softm/foodhannun/actions/workflows/sync-food-data.yml" target="_blank" rel="noopener">자동 수집·배포 실행 이력 →</a></p></section>' if automation_rows else ''
    connected = automation_section
    if integration:
        c = integration['counts']
        connected += f'<section><h2>수집 데이터 연결 현황</h2><p>레시피 {c["recipes"]:,}개 중 음식명·별칭 일치 {c["withNameMatch"]:,}개, 음식명 포함 후보 {c["withRelatedCandidates"]:,}개, 연결 후보 없음 {c["withoutCandidates"]:,}개입니다. 이는 공식 동일 식품 식별자에 의한 결합이 아닌 이름 기반 탐색입니다.</p><p>레시피 상세의 영양 탭에서 근거와 기준량을 확인하고, 재료·장보기 또는 관련 제품 탭에서 재료명으로 가공식품을 탐색할 수 있습니다. 제품 원재료·회수·HACCP의 연결 상태는 아래 공식 번호 연결 현황을 확인하세요.</p><p><a href="./?q=김치찌개">통합검색 예시 →</a> · <a href="data/integration-status.json">연결 기준·검증 현황 JSON</a></p></section>'
    if safety:
        connected += f'<section><h2>공식 번호 연결 현황</h2><p>공식 API {safety["counts"]["indexedRecords"]:,}건의 검색 포인터와 {safety["counts"]["lookupPointers"]:,}개 번호·원료명 조회 포인터를 검증했습니다. 제품은 품목제조번호, 제조업소 HACCP는 인허가번호, 원료 자료는 원료코드·공식 이름으로 연결합니다.</p><p>회수 공고는 제조일·소비기한을 확인하고, HACCP는 적용 업소·품목·유효기간을 확인해야 합니다. C005는 2018년 이후 갱신 중단 자료입니다.</p><p><a href="food-safety.html">공식 원재료·안전 자료 검색 →</a></p></section>'
    if not any('INFO-110' in d.get('reason','') for d in datasets):
        page = page.replace('INFO-110은 새 인증키 발급이 필요한 오류가 아닙니다. 식품안전나라 로그인 후 해당 서비스의 OpenAPI 이용신청을 추가한 다음 수집을 다시 실행해야 합니다.', '공식 API 원본은 검증된 전체 수집본만 연결합니다. 수집 실패·일부 수집은 별도로 표시하며 마지막 정상 수집본을 보존합니다.')
    page = page.replace('INTEGRATION_SECTION', connected)
    (ROOT / 'data-status.html').write_text(page, encoding='utf-8')
    print(f"수집 현황: {len(completed)}종 / {summary['totalCollectedRecords']:,}개 레코드")
if __name__ == '__main__':
    main()

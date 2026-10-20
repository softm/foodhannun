(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let requestId = 0, limit = 50, matches = [], worker, returnFocus, detailRequest = 0;
  const chunks = new Map();
  const manifest = fetch('data/nutrition/manifest.json').then(response => {
    if (!response.ok) throw new Error('수집 현황을 불러오지 못했습니다.');
    return response.json();
  });
  // Share one rejection handler even if the user never opens a result.
  manifest.catch(error => { $('#data-message').textContent = error.message; });
  function search(reset = true) {
    if (!worker) return;
    if (reset) limit = 50;
    const query = $('#data-query').value.slice(0, 100), group = $('#data-group').value;
    $('#food-data-results').setAttribute('aria-busy','true');
    $('#food-data-results').innerHTML = '';
    $('#data-more').hidden = true;
    $('#data-message').textContent = '공식 수집본에서 검색합니다…';
    worker.postMessage({requestId:++requestId, query, group, limit});
    const url = new URL(location.href);
    if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
    url.searchParams.set('group', group);
    history.replaceState(null, '', url);
  }
  async function openDetail(index, button) {
    const match = matches[index];
    if (!match) return;
    const token = ++detailRequest;
    returnFocus = button;
    const dialog = $('#food-data-dialog');
    $('#food-data-detail').innerHTML = '<p role="status">선택한 식품의 원문을 불러옵니다…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await manifest;
      const dataset = data.datasets.find(item => item.id === match.group);
      const path = 'data/nutrition/' + dataset.chunks[match.row[4]].path;
      if (!chunks.has(path)) {
        const promise = (async () => {
          const response = await fetch(path);
          if (!response.ok) throw new Error('원문 상세를 불러오지 못했습니다.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          const text = bytes[0] === 31 && bytes[1] === 139 ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(bytes);
          return JSON.parse(text);
        })();
        chunks.set(path, promise);
        promise.catch(() => chunks.delete(path));
        if (chunks.size > 8) chunks.delete(chunks.keys().next().value);
      }
      const chunk = await chunks.get(path);
      if (token !== detailRequest || !dialog.open) return;
      const row = chunk.rows[match.row[5]];
      if (!row || row[chunk.columns.indexOf('식품코드')] !== match.row[0]) throw new Error('선택한 식품과 상세 데이터의 코드가 일치하지 않습니다.');
      const value = name => row[chunk.columns.indexOf(name)];
      const basis = value('영양성분함량기준량') || value('영양성분제공단위량');
      const basic = ['에너지(kcal)','탄수화물(g)','단백질(g)','지방(g)','당류(g)','나트륨(mg)'];
      const nutrients = basic.map(name => `<div><span>${escape(name)}</span><strong>${escape(value(name) ?? '미제공')}</strong></div>`).join('');
      const sourceRows = Object.entries(row).map(([column, content]) => `<tr><th scope="row">${escape(chunk.columns[Number(column)])}</th><td>${escape(content)}</td></tr>`).join('');
      $('#food-data-detail').innerHTML = `<p class="eyebrow">${escape(dataset.name)}</p><h2 id="food-data-title">${escape(match.row[1])}</h2><p>${escape(match.row[0])} · ${escape(value('제조사명') || value('출처명') || '')}</p><p class="notice">영양 기준량: <strong>${escape(basis || '원문 미제공')}</strong> · 식품중량: ${escape(value('식품중량') || value('식품중량/부피') || '원문 미제공')}<br>원본 기준량 그대로 표시합니다. 1회 섭취참고량: ${escape(value('1회 섭취참고량') || '원문 미제공')}</p><div class="metrics nutrition-metrics">${nutrients}</div><details open><summary>제공된 원문 전체 항목</summary><div class="table-scroll"><table><tbody>${sourceRows}</tbody></table></div></details><footer>${escape(dataset.sourceAttribution)} · 원본 버전 ${escape(dataset.version)}<br><a href="${escape(dataset.sourceUrl)}" target="_blank" rel="noopener">공식 원본 다운로드</a></footer>`;
      dialog.setAttribute('aria-labelledby','food-data-title');
      dialog.scrollTop = 0;
    } catch (error) {
      if (token === detailRequest && dialog.open) $('#food-data-detail').textContent = error.message || '상세를 불러오지 못했습니다.';
    }
  }
  $('#food-data-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('#data-group').addEventListener('change', () => search());
  $('#data-more').addEventListener('click', () => { limit += 50; search(false); });
  $('#food-data-results').addEventListener('click', event => { const button = event.target.closest('[data-result]'); if (button) openDetail(Number(button.dataset.result),button); });
  $('#food-data-dialog .dialog-close').addEventListener('click', () => $('#food-data-dialog').close());
  $('#food-data-dialog').addEventListener('close', () => { ++detailRequest; returnFocus?.focus({preventScroll:true}); });
  try {
    worker = new Worker('assets/food-data-worker.js');
    worker.onmessage = event => {
      if (event.data.requestId !== requestId) return;
      $('#food-data-results').setAttribute('aria-busy','false');
      if (event.data.error) { $('#data-message').textContent = event.data.error; return; }
      matches = event.data.matches;
      $('#data-message').textContent = `검색 결과 ${event.data.total.toLocaleString('ko-KR')}건 중 ${matches.length.toLocaleString('ko-KR')}건 표시`;
      $('#food-data-results').innerHTML = matches.map((item, index) => `<button type="button" data-result="${index}" class="data-result" aria-haspopup="dialog"><span class="badge complete">${escape(item.source)}</span><strong>${escape(item.row[1])}</strong><span>${escape(item.row[2])}${item.row[3] ? ' · '+escape(item.row[3]) : ''}</span><small>${escape(item.row[0])} · 영양 기준량 ${escape(item.row[6] || '미제공')}</small></button>`).join('');
      $('#data-more').hidden = matches.length >= event.data.total;
    };
    worker.onerror = () => { $('#food-data-results').setAttribute('aria-busy','false'); $('#data-message').textContent = '검색 기능을 시작하지 못했습니다. 웹 서버 또는 배포된 주소에서 열어 주세요.'; };
    const params = new URL(location.href).searchParams;
    $('#data-query').value = (params.get('q') || '').slice(0,100);
    if ([...$('#data-group').options].some(option => option.value === params.get('group'))) $('#data-group').value = params.get('group');
    search();
  } catch {
    $('#food-data-results').setAttribute('aria-busy','false');
    $('#data-message').textContent = '영양 데이터 검색은 웹 서버 또는 배포된 주소에서 이용해 주세요.';
  }
})();

/* Shared official record browser for the home search, recipe details and data page. */
(() => {
  'use strict';
  const base = new URL('../', document.currentScript.src);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pending = new Map(), chunks = new Map(), searches = new Map();
  let worker, sequence = 0, detailSequence = 0, returnFocus, manifestPromise, linksPromise;
  async function json(path, compressed = false) {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error('수집 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    if (!compressed) return response.json();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = bytes[0] === 31 && bytes[1] === 139 ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(bytes);
    return JSON.parse(text);
  }
  function manifest() {
    if (!manifestPromise) manifestPromise = json('data/nutrition/manifest.json').catch(error => { manifestPromise = null; throw error; });
    return manifestPromise;
  }
  function search(options) {
    const key = JSON.stringify(options);
    if (!searches.has(key)) {
      const promise = runSearch(options);
      searches.set(key,promise);
      promise.catch(() => searches.delete(key));
      if (searches.size > 8) searches.delete(searches.keys().next().value);
    }
    return searches.get(key);
  }
  function runSearch(options) {
    try {
      if (!worker) {
        worker = new Worker(new URL('assets/food-data-worker.js', base));
        worker.onmessage = ({data}) => {
          const request = pending.get(data.requestId);
          if (!request) return;
          clearTimeout(request.timer); pending.delete(data.requestId);
          if (data.error) request.reject(new Error(data.error)); else request.resolve(data);
        };
        worker.onerror = () => {
          for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('검색을 시작하지 못했습니다. 새로고침 후 다시 시도해 주세요.')); }
          pending.clear(); worker.terminate(); worker = null;
        };
      }
      return new Promise((resolve,reject) => {
        const requestId = ++sequence;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('검색 응답이 늦어지고 있습니다. 다시 검색해 주세요.')); },45000);
        pending.set(requestId,{resolve,reject,timer});
        worker.postMessage({...options, requestId});
      });
    } catch (error) { return Promise.reject(error); }
  }
  function card(item) {
    const evidence = item.evidence ? `<span class="catalog-evidence">${esc(item.evidence.label)} · ${esc(item.evidence.term)}</span>` : '';
    return `<button type="button" class="catalog-card" data-food-ref="${esc(JSON.stringify(item))}" aria-haspopup="dialog"><span class="catalog-source">${esc(item.source)}</span><strong>${esc(item.row[1])}</strong><span>${esc(item.row[2])}${item.row[3] ? ' · '+esc(item.row[3]) : ''}</span><small>${esc(item.row[0])} · 영양 기준량 ${esc(item.row[6] || '미제공')}</small>${evidence}</button>`;
  }
  async function recipeLinks(recipe) {
    if (!linksPromise) linksPromise = json('data/food-links.json.gz',true).catch(error => { linksPromise = null; throw error; });
    const [links, data] = await Promise.all([linksPromise,manifest()]);
    const current = data.datasets.find(d => d.id === 'foods');
    if (links.foodIndexSha256 !== current.index.sha256) throw new Error('연결 데이터가 갱신 중입니다. 음식명으로 다시 검색해 주세요.');
    const found = links.recipes[String(recipe.id)];
    if (!found || found.name !== recipe.name) return {foods:[],total:0};
    return found;
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'catalog-dialog'; dialog.className = 'catalog-dialog'; dialog.setAttribute('aria-label','공식 식품 상세');
  dialog.innerHTML = '<button type="button" class="catalog-close" data-catalog-close aria-label="식품 상세 닫기">닫기 ×</button><div id="catalog-detail"></div>';
  document.body.append(dialog);
  async function open(item, trigger) {
    returnFocus = trigger; const token = ++detailSequence;
    const target = document.getElementById('catalog-detail');
    dialog.removeAttribute('aria-labelledby');
    target.innerHTML = '<p role="status">선택한 식품의 원문을 불러옵니다…</p>';
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('dialog-open');
    try {
      const data = await manifest(), dataset = data.datasets.find(d => d.id === item.group);
      const descriptor = dataset?.chunks[item.row[4]];
      if (!descriptor) throw new Error('선택한 식품의 상세 위치를 확인하지 못했습니다.');
      const path = 'data/nutrition/' + descriptor.path;
      if (!chunks.has(path)) {
        const promise = json(path,true); chunks.set(path,promise);
        promise.catch(() => chunks.delete(path));
        if (chunks.size > 8) chunks.delete(chunks.keys().next().value);
      }
      const chunk = await chunks.get(path);
      if (token !== detailSequence || !dialog.open) return;
      const row = chunk.rows[item.row[5]], value = name => row?.[chunk.columns.indexOf(name)];
      if (value('식품코드') !== item.row[0]) throw new Error('선택한 식품과 상세 원문의 코드가 일치하지 않습니다.');
      const basis = value('영양성분함량기준량') || value('영양성분제공단위량') || '원문 미제공';
      const sourceRows = Object.entries(row).map(([column,content]) => `<tr><th scope="row">${esc(chunk.columns[Number(column)])}</th><td>${esc(content)}</td></tr>`).join('');
      const nutrients = ['에너지(kcal)','탄수화물(g)','단백질(g)','지방(g)','당류(g)','나트륨(mg)'].map(name => `<div><span>${esc(name)}</span><strong>${esc(value(name) ?? '미제공')}</strong></div>`).join('');
      const product = item.group !== 'foods';
      const related = window.FoodCatalog.relatedRecipes?.(item) || [];
      target.innerHTML = `<p class="catalog-source">${esc(dataset.name)}</p><h2 id="catalog-title">${esc(item.row[1])}</h2><p>${esc(item.row[0])} · ${esc(value('제조사명') || value('출처명') || '')}</p>${item.evidence ? `<p class="catalog-notice">연결 근거: ${esc(item.evidence.label)} · ${esc(item.evidence.term)}. 같은 레시피의 영양값으로 확정된 자료는 아닙니다.</p>` : ''}<p class="catalog-notice">영양 기준량: <strong>${esc(basis)}</strong> · 식품중량: ${esc(value('식품중량') || value('식품중량/부피') || '원문 미제공')}<br>1회 섭취참고량: ${esc(value('1회 섭취참고량') || '원문 미제공')} · 원본 기준량 그대로 표시</p><div class="catalog-nutrients">${nutrients}</div>${product ? `<p>품목제조보고번호: ${esc(value('품목제조보고번호') || '원문 미제공')}</p><p class="source-note">${item.group === 'supplements' ? '건강기능식품의 제품별 영양 자료입니다. 일반 음식과 구분하여 표시합니다. ' : ''}원재료·알레르기·회수·HACCP 여부는 현재 영양 DB로 확인할 수 없습니다.</p><a class="catalog-link" href="https://search.shopping.naver.com/search/all?query=${encodeURIComponent(item.row[1]+' '+(item.row[3] || ''))}" target="_blank" rel="noopener noreferrer">이 제품 구매처 검색 ↗</a><p class="source-note">일반 쇼핑 검색 링크입니다. 동일 제품·가격·재고를 보장하지 않습니다.</p>` : ''}${related.length ? `<section class="catalog-related"><h3>음식명으로 연결된 레시피</h3><p class="source-note">이름이 일치하거나 해당 음식명을 포함한 후보입니다. 조리법·분량은 각각 확인하세요.</p>${related.map(recipe => `<button type="button" class="catalog-link" data-catalog-recipe="${esc(recipe.id)}">${esc(recipe.name)} 레시피 보기 →</button>`).join('')}</section>` : ''}<details><summary>제공된 원문 전체 항목</summary><div class="catalog-table"><table><tbody>${sourceRows}</tbody></table></div></details><footer class="source-note">${esc(dataset.sourceAttribution)} · 원본 버전 ${esc(dataset.version)}<br>수집 시각(UTC): ${esc(dataset.fetchedAt)}<br><a href="${esc(dataset.sourceUrl)}" target="_blank" rel="noopener noreferrer">공식 원본 다운로드 ↗</a></footer>`;
      dialog.setAttribute('aria-labelledby','catalog-title'); dialog.scrollTop = 0;
    } catch (error) { if (token === detailSequence && dialog.open) target.textContent = error.message; }
  }
  document.addEventListener('click', event => {
    const food = event.target.closest('[data-food-ref]');
    if (food) { try { open(JSON.parse(food.dataset.foodRef),food); } catch {} return; }
    if (event.target.closest('[data-catalog-close]')) dialog.close();
    const recipe = event.target.closest('[data-catalog-recipe]');
    if (recipe) { dialog.close(); window.FoodCatalog.openRecipe?.(recipe.dataset.catalogRecipe); }
  });
  dialog.addEventListener('close', () => {
    ++detailSequence;
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open');
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
  });
  window.FoodCatalog = {manifest, search, card, recipeLinks, open, escape:esc};
})();

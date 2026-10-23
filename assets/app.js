/* 음식한눈 — buildless, browser-local food explorer. No credentials belong here. */
(() => {
  'use strict';

  const data = window.FOOD_DATA || { meta: {}, recipes: [] };
  const recipes = Array.isArray(data.recipes) ? data.recipes : [];
  const recipeById = new Map(recipes.map(recipe => [String(recipe.id), recipe]));
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const normalize = value => String(value ?? '').normalize('NFC').toLowerCase().replace(/[\s·ㆍ,()[\]#&:]/g, '');
  const storageKey = 'foodhannun:v1';
  const fallbackImage = 'assets/images/food-placeholder.svg';
  const datasetLabel = data.meta?.datasetMode === 'official-sample' ? '공개 샘플' : '공식 레시피';
  let persistenceAvailable = true;
  let persisted;
  try { persisted = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { persisted = {}; persistenceAvailable = false; }
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) persisted = {};
  const saved = new Set((Array.isArray(persisted.saved) ? persisted.saved : []).map(String).filter(id => recipeById.has(id)));
  const storedCart = Array.isArray(persisted.cart) ? persisted.cart : [];
  let cart = [...new Map(storedCart.map(restoreCartItem).filter(Boolean).map(item => [item.key, item])).values()];
  const cartNeedsMigration = JSON.stringify(storedCart) !== JSON.stringify(cart);
  let recent = (Array.isArray(persisted.recent) ? persisted.recent : []).filter(item => typeof item === 'string').slice(0, 6);
  let notes = persisted.notes && typeof persisted.notes === 'object' && !Array.isArray(persisted.notes) ? persisted.notes : {};
  const state = { kind: 'all', query: '', method: 'all', category: 'all', allergen: 'all', sort: 'default', view: 'all' };
  const RESULTS_BATCH_SIZE = 24;
  let currentResults = [];
  let displayedResults = 0;
  let renderedSearchState = null;
  let activeRecipe = null;
  let selectedRecipeId = null;
  let activeTab = 'recipe';
  let returnFocus = null;
  let toastTimer;
  let typingTimer;
  let recognition;
  let listening = false;
  let unifiedSequence = 0, unifiedKey = null, productSequence = 0, nutritionSequence = 0;
  const catalog = window.FoodCatalog;
  catalog.openRecipe = id => openRecipe(id);
  catalog.relatedRecipes = item => item.group === 'foods' ? recipes.filter(recipe => window.FoodSearch.relation(recipe.name, item.row[1], (recipe.ingredients || []).map(i => i.name))).slice(0, 4) : [];
  const catalogNames = {foods:'음식 영양', 'processed-foods':'가공식품', supplements:'건강기능식품'};
  const catalogLimits = new Map();
  let nutritionTotal = null;

  function cartKey(recipeId, name, amount) {
    return JSON.stringify([String(recipeId), String(name).normalize('NFC').trim(), String(amount ?? '').normalize('NFC').trim()]);
  }
  function snapshotIngredient(recipe, ingredient, checked = false) {
    const name = String(ingredient.name || '').trim();
    const amount = String(ingredient.amount || '').trim();
    return { key: cartKey(recipe.id, name, amount), recipeId: String(recipe.id), recipeName: String(recipe.name), name, amount, raw: String(ingredient.raw || ''), checked: Boolean(checked) };
  }
  function restoreCartItem(item) {
    if (!item || typeof item !== 'object' || item.recipeId == null) return null;
    const recipeId = String(item.recipeId);
    const recipe = recipeById.get(recipeId);
    if (typeof item.name === 'string' && item.name.trim()) {
      const name = item.name.trim();
      const amount = typeof item.amount === 'string' ? item.amount.trim() : '';
      return { key: cartKey(recipeId, name, amount), recipeId, recipeName: typeof item.recipeName === 'string' && item.recipeName ? item.recipeName : recipe?.name || `레시피 ${recipeId}`, name, amount, raw: typeof item.raw === 'string' ? item.raw : '', checked: Boolean(item.checked), ...(item.unresolved ? { unresolved: true } : {}) };
    }
    if (!Number.isInteger(item.index) || item.index < 0) return null;
    const ingredient = recipe?.ingredients?.[item.index];
    if (ingredient) return snapshotIngredient(recipe, ingredient, item.checked);
    // Legacy entries did not contain a snapshot. Keep the entry visible instead
    // of silently deleting it when its old recipe is no longer available.
    const name = `이전 재료 ${item.index + 1} (확인 필요)`;
    return { key: cartKey(recipeId, name, ''), recipeId, recipeName: recipe?.name || `레시피 ${recipeId}`, name, amount: '', raw: '', checked: Boolean(item.checked), unresolved: true };
  }
  function cartItemStatus(item) {
    if (item.unresolved) return '이전 저장 형식에 재료명이 없어 원문 확인이 필요합니다.';
    const recipe = recipeById.get(item.recipeId);
    if (!recipe) return '현재 목록에 없는 음식입니다. 담을 당시 내용을 보관하고 있어요.';
    if (!(recipe.ingredients || []).some(ingredient => cartKey(recipe.id, ingredient.name, ingredient.amount) === item.key)) return '원문 재료가 변경되어 담을 당시 내용을 표시합니다.';
    return '';
  }
  function fetchedDate() {
    const date = new Date(data.meta?.fetchedAt || '');
    if (!Number.isFinite(date.getTime())) return '미제공';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} (한국 시간)`;
  }
  function initializeDataControls() {
    for (const key of ['method', 'category']) {
      const select = $(`#${key}-filter`);
      if (!select) continue;
      const label = key === 'method' ? '모든 조리 방법' : '모든 음식 종류';
      const values = [...new Set(recipes.map(recipe => recipe[key]).filter(value => typeof value === 'string' && value))].sort((a, b) => a.localeCompare(b, 'ko'));
      select.innerHTML = `<option value="all">${label}</option>${values.map(value => `<option value="${escape(value)}">${escape(value.replace(/&/g, '·'))}</option>`).join('')}`;
    }
    $$('[data-dataset-label]').forEach(element => { element.textContent = datasetLabel; });
    $$('[data-dataset-count]').forEach(element => { element.textContent = recipes.length; });
  }
  function koreaDateKey(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function dailyRecipe(date = new Date()) {
    if (!recipes.length) return null;
    const dateKey = koreaDateKey(date);
    const [year, month, day] = dateKey.split('-').map(Number);
    const epochDay = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
    const eligible = recipes.filter(recipe => recipe?.name && recipe?.image);
    const pool = eligible.length ? eligible : recipes;
    return pool[((epochDay % pool.length) + pool.length) % pool.length] || pool[0];
  }
  function initializeHero() {
    const recipe = dailyRecipe();
    const button = $('.hero-recipe');
    const image = $('#hero-image');
    const title = $('.hero-recipe-caption strong');
    const link = $('.hero-recipe-link');
    if (!recipe) {
      if ($('.hero-visual')) $('.hero-visual').hidden = true;
      return;
    }
    if (button) {
      button.dataset.recipeId = String(recipe.id);
      button.setAttribute('aria-label', `${recipe.name} 레시피 보기`);
      button.dataset.dailyDate = koreaDateKey();
    }
    if (image) {
      image.src = safeImage(recipe.image);
      image.alt = recipe.name;
    }
    if (title) title.textContent = recipe.name;
    if (link) {
      const arrow = link.querySelector('svg')?.cloneNode(true);
      const category = String(recipe.category || '').replace(/&/g, '·').trim();
      const method = String(recipe.method || '').trim();
      link.textContent = [category, method].filter(Boolean).join(' · ') || '재료와 만드는 법 살펴보기';
      if (arrow) link.append(' ', arrow);
    }
  }

  const icons = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7"/></svg>',
    bag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14l1 14H4L5 7Zm3 0V5a4 4 0 0 1 8 0v2"/></svg>'
  };

  const allergyRules = [
    { name: '알류', pattern: /달걀|계란|메추리알|난백|난황/ },
    { name: '우유', pattern: /우유|생크림|버터|치즈|요구르트|요거트/ },
    { name: '대두', pattern: /두부|콩가루|대두|간장|된장|청국장/ },
    { name: '밀', pattern: /밀가루|빵가루|스파게티|파스타|우동/ },
    { name: '땅콩', pattern: /땅콩/ },
    { name: '새우', pattern: /새우/ },
    { name: '토마토', pattern: /토마토/ },
    { name: '어류', pattern: /북어|명태|멸치|고등어|참치|연어|액젓/ }
  ];
  function allergens(recipe) {
    const text = recipe.ingredientText || '';
    return allergyRules.filter(rule => rule.pattern.test(text)).map(rule => ({ name: rule.name, evidence: [...new Set(text.match(new RegExp(rule.pattern.source, 'g')) || [])] }));
  }
  function possibleAllergens(recipe) { return /간장|된장|고추장/.test(recipe.ingredientText || '') ? ['밀'] : []; }
  function sourceUrl() { return 'https://www.foodsafetykorea.go.kr/api/openApiInfo.do?menu_grp=MENU_GRP31&menu_no=661&show_cnt=10&start_idx=1&svc_no=COOKRCP01'; }
  function safeImage(path) {
    if (typeof path !== 'string') return fallbackImage;
    if (/^assets\/images\/[a-zA-Z0-9._-]+$/.test(path)) return path;
    try { const url = new URL(path); return url.protocol === 'https:' && url.hostname === 'www.foodsafetykorea.go.kr' ? url.href : fallbackImage; } catch { return fallbackImage; }
  }
  function number(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '미제공' : Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 1 }); }
  function toast(message) { clearTimeout(toastTimer); const element = $('#toast'); if (!element) return; element.textContent = message; element.hidden = false; element.classList.add('is-visible'); toastTimer = setTimeout(() => { element.classList.remove('is-visible'); element.hidden = true; }, 3200); }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ saved: [...saved], cart, recent, notes })); return true; }
    catch { persistenceAvailable = false; toast('브라우저 저장 공간을 사용할 수 없어 이번 화면에서만 유지됩니다.'); return false; }
  }
  function updateCounts() {
    if ($('#saved-count')) $('#saved-count').textContent = saved.size;
    if ($('#shopping-count')) $('#shopping-count').textContent = cart.filter(item => !item.checked).length;
    $$('[data-saved-count]').forEach(element => { element.textContent = saved.size; });
    $$('[data-shopping-count]').forEach(element => { element.textContent = cart.filter(item => !item.checked).length; });
  }
  function updateUrl(push = false) {
    const url = new URL(location.href);
    const params = { kind: state.kind, q: state.query, method: state.method, category: state.category, allergen: state.allergen, sort: state.sort, view: state.view, recipe: activeRecipe?.id };
    for (const [key, value] of Object.entries(params)) { if (value && value !== 'all' && value !== 'default') url.searchParams.set(key, String(value)); else url.searchParams.delete(key); }
    const entry = { ...(history.state || {}), foodhannun: true };
    if (push) entry.foodhannunDetail = true;
    else if (!activeRecipe) delete entry.foodhannunDetail;
    try { history[push ? 'pushState' : 'replaceState'](entry, '', url); } catch { /* file:// may restrict history in some browsers. */ }
  }
  function readUrl() {
    const params = new URL(location.href).searchParams;
    state.query = (params.get('q') || '').slice(0, 100);
    state.kind = ['recipes','foods','processed-foods','supplements'].includes(params.get('kind')) ? params.get('kind') : 'all';
    for (const key of ['method', 'category', 'allergen']) {
      const select = $(`#${key}-filter`);
      const candidate = params.get(key) || 'all';
      state[key] = select && [...select.options].some(option => option.value === candidate) ? candidate : 'all';
    }
    state.sort = params.get('sort') === 'name' ? 'name' : 'default';
    state.view = params.get('view') === 'saved' ? 'saved' : 'all';
    syncControls();
    // Detail-only history navigation keeps appended cards and their focus targets.
    // A changed search, filter, sort, or view always starts with the first batch.
    if (renderedSearchState !== JSON.stringify(state)) render();
    const recipe = recipeById.get(params.get('recipe'));
    if (recipe) openRecipe(recipe.id, false);
    else if ($('#recipe-dialog')?.open) { activeRecipe = null; $('#recipe-dialog').close(); }
  }
  function syncControls() {
    $('#search-input').value = state.query;
    for (const key of ['method', 'category', 'allergen']) if ($(`#${key}-filter`)) $(`#${key}-filter`).value = state[key];
    if ($('#sort-select')) $('#sort-select').value = state.sort;
    if ($('#clear-search')) $('#clear-search').hidden = !state.query;
    $$('[data-view]').forEach(button => { const active = button.dataset.view === state.view; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
  }
  function termsMatch(recipe, query) {
    return window.FoodSearch.matches([recipe.name, recipe.tag || '', recipe.ingredientText, recipe.category, recipe.method], window.FoodSearch.terms(query), recipe.name);
  }
  function filteredRecipes() {
    return recipes.filter(recipe =>
      (!state.query || termsMatch(recipe, state.query)) &&
      (state.view !== 'saved' || saved.has(String(recipe.id))) &&
      (state.method === 'all' || recipe.method === state.method) &&
      (state.category === 'all' || recipe.category === state.category) &&
      (state.allergen === 'all' || (String(recipe.ingredientText || '').trim() && ![...allergens(recipe).map(item => item.name), ...possibleAllergens(recipe)].includes(state.allergen)))
    ).sort((a, b) => {
      if (state.sort === 'name') return a.name.localeCompare(b.name, 'ko');
      if (state.query) return Number(normalize(b.name).includes(normalize(state.query))) - Number(normalize(a.name).includes(normalize(state.query)));
      return 0;
    });
  }
  function renderCard(recipe) {
    const isSaved = saved.has(String(recipe.id));
    const isSelected = selectedRecipeId === String(recipe.id);
    const ingredients = (recipe.ingredients || []).slice(0, 3).map(item => item.name).join(' · ') || '원문 재료 정보 미제공';
    return `<article class="recipe-card${isSelected ? ' is-selected' : ''}" data-card-id="${escape(recipe.id)}">
      <div class="recipe-visual">
        <button type="button" class="recipe-image-button" data-recipe-id="${escape(recipe.id)}" aria-label="${escape(recipe.name)} 레시피 보기"><img class="recipe-image" src="${escape(safeImage(recipe.image))}" alt="${escape(recipe.name)} 완성 사진" width="600" height="440" loading="lazy" decoding="async"></button>
        <span class="recipe-origin">식품안전나라</span>
        <button type="button" class="save-button ${isSaved ? 'is-saved' : ''}" data-save="${escape(recipe.id)}" aria-label="${escape(recipe.name)} ${isSaved ? '저장 취소' : '저장'}" aria-pressed="${isSaved}">${icons.heart}</button>
      </div>
      <div class="recipe-body"><div class="recipe-tags"><span class="tag tag--green">${escape(recipe.category)}</span><span class="tag">${escape(recipe.method)}</span><span class="tag tag--selected" data-selection-label${isSelected ? '' : ' hidden'}>최근 선택</span></div>
        <h3 class="recipe-title"><button type="button" class="card-open" data-recipe-id="${escape(recipe.id)}" aria-haspopup="dialog" aria-controls="recipe-dialog">${escape(recipe.name)}</button></h3>
        <p class="recipe-ingredients">${escape(ingredients)}</p>
        <div class="recipe-meta"><span>${recipe.steps?.length ? `조리 단계 <strong>${recipe.steps.length}</strong>개` : '조리 순서 미제공'}</span><span>${recipe.ingredients?.length ? '영양 · 재료 정보' : '재료 미제공'}</span></div>
        <div class="card-footer"><span>재료부터 만드는 법까지</span><button class="card-arrow icon-button" type="button" data-recipe-id="${escape(recipe.id)}" aria-label="${escape(recipe.name)} 상세 보기">${icons.arrow}</button></div>
      </div></article>`;
  }
  function render() {
    const sameSearch = renderedSearchState === JSON.stringify(state);
    const result = filteredRecipes();
    currentResults = result;
    const firstBatch = state.query && state.kind === 'all' && state.view !== 'saved' ? 6 : RESULTS_BATCH_SIZE;
    displayedResults = Math.min(sameSearch ? Math.max(firstBatch, displayedResults) : firstBatch, result.length);
    $('#recipe-grid').innerHTML = result.slice(0, displayedResults).map(renderCard).join('');
    renderedSearchState = JSON.stringify(state);
    renderPagination();
    $('#results-title').textContent = state.query ? `“${state.query}” 검색 결과` : state.view === 'saved' ? '다시 꺼내 보는, 저장한 음식' : '오늘은 이런 한 끼 어때요?';
    $('#results-count').textContent = `${result.length.toLocaleString('ko-KR')}개`;
    $('#empty-state').hidden = Boolean(result.length);
    if (!result.length) {
      const heading = $('#empty-state h3');
      const description = $('#empty-state p');
      if (heading) heading.textContent = state.view === 'saved' && !saved.size ? '마음에 드는 음식을 저장해 보세요' : '조건에 맞는 레시피가 없어요';
      if (description) description.textContent = state.view === 'saved' && !saved.size ? '음식 사진의 하트를 누르면 이곳에서 다시 볼 수 있어요.' : `현재 ${recipes.length}종의 레시피에서 찾지 못했습니다. 음식 영양·가공식품 결과도 확인해 보세요.`;
    }
    const active = [];
    if (state.method !== 'all') active.push(['method', `조리법: ${state.method}`]);
    if (state.category !== 'all') active.push(['category', state.category]);
    if (state.allergen !== 'all') active.push(['allergen', `${state.allergen} 단서 포함 제외`]);
    $('#active-filters').innerHTML = active.map(([key, text]) => `<button type="button" class="pill filter-pill" data-remove-filter="${key}" aria-label="${escape(text)} 필터 해제">${escape(text)} <span aria-hidden="true">×</span></button>`).join('');
    $('#active-filters').hidden = !active.length;
    const caveat = $('#filter-caveat');
    if (caveat) caveat.hidden = state.allergen === 'all';
    syncControls(); updateCounts(); renderRecent(); renderUnified();
  }
  function renderUnified() {
    const savedView = state.view === 'saved';
    $('#result-kinds').hidden = savedView;
    $('#recipe-results').hidden = !savedView && !['all','recipes'].includes(state.kind);
    $('#filter-toggle').hidden = !savedView && !['all','recipes'].includes(state.kind);
    $('#catalog-scope-note').hidden = savedView || (state.method === 'all' && state.category === 'all' && state.allergen === 'all');
    $('#kind-recipes').textContent = currentResults.length.toLocaleString('ko-KR');
    $$('[data-result-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.resultKind === state.kind)));
    window.FoodSafety.searchConnections($('#safety-number-results'), savedView || state.kind !== 'all' ? '' : state.query);
    const key = JSON.stringify([state.query,state.kind,state.view]);
    if (key === unifiedKey) return;
    unifiedKey = key; catalogLimits.clear();
    const token = ++unifiedSequence, status = $('#catalog-search-status'), groups = $('#catalog-search-groups');
    groups.innerHTML = '';
    $('#integrated-catalog').hidden = savedView || state.kind === 'recipes';
    if (savedView) { status.textContent = ''; return; }
    if (!state.query && ['all','recipes'].includes(state.kind)) {
      status.textContent = '음식명·재료명·제품명·식품코드·제조사로 검색하거나 데이터 종류를 선택해 보세요.';
      catalog.manifest().then(data => {
        if (token !== unifiedSequence) return;
        for (const dataset of data.datasets) $('#kind-'+dataset.id).textContent = dataset.count.toLocaleString('ko-KR');
        $('#catalog-overview').innerHTML = `레시피 ${recipes.length.toLocaleString('ko-KR')}개와 공식 영양·제품 ${data.count.toLocaleString('ko-KR')}건을 한 번에 검색합니다. <a href="data-status.html">수집·연결 현황 →</a>`;
      }).catch(error => { if (token === unifiedSequence) status.textContent = error.message; });
      return;
    }
    status.textContent = '공식 음식·제품 데이터를 검색합니다…'; groups.setAttribute('aria-busy','true');
    for (const id of Object.keys(catalogNames)) $('#kind-'+id).textContent = '…';
    catalog.search({query:state.query,group:'all',perGroup:6}).then(result => {
      if (token !== unifiedSequence) return;
      for (const group of result.groups) $('#kind-'+group.id).textContent = group.total.toLocaleString('ko-KR');
      const visible = result.groups.filter(group => state.kind === 'all' || state.kind === group.id).sort((a,b) => ['foods','processed-foods','supplements'].indexOf(a.id) - ['foods','processed-foods','supplements'].indexOf(b.id));
      groups.innerHTML = visible.map(group => catalogGroup(group)).join('');
      status.textContent = `공식 영양·제품 검색 ${visible.reduce((sum,g) => sum + g.total,0).toLocaleString('ko-KR')}건 · 데이터셋별 건수이며 같은 음식이 여러 자료에 포함될 수 있습니다.`;
      groups.setAttribute('aria-busy','false');
    }).catch(error => { if (token === unifiedSequence) { status.textContent = error.message; groups.setAttribute('aria-busy','false'); } });
  }
  function catalogGroup(group) {
    catalogLimits.set(group.id,group.matches.length);
    const note = group.id === 'foods' ? '음식별 원문 영양 자료 · 기준량과 조리 유형을 확인하세요.' : group.id === 'supplements' ? '건강기능식품 제품별 영양 자료 · 일반 음식과 별도로 표시합니다.' : '제품명·식품코드·제조사를 확인할 수 있는 가공식품 영양 자료입니다.';
    return `<section class="catalog-section" id="catalog-group-${group.id}" aria-labelledby="catalog-heading-${group.id}"><div class="catalog-section-header"><h3 id="catalog-heading-${group.id}">${catalogNames[group.id]}</h3><span>${group.total.toLocaleString('ko-KR')}건</span></div><p>${note}</p><div class="catalog-grid">${group.matches.map(catalog.card).join('')}</div>${group.total ? '' : '<p>해당 종류에서 일치하는 자료를 찾지 못했습니다.</p>'}${group.matches.length < group.total ? `<button type="button" class="catalog-more" data-catalog-more="${group.id}">${catalogNames[group.id]} 다음 12건 더 보기</button>` : ''}</section>`;
  }
  async function loadCatalogMore(group, button) {
    const token = unifiedSequence, limit = (catalogLimits.get(group) || 6) + 12, query = state.query;
    button.disabled = true;
    try {
      const result = await catalog.search({query,group,limit});
      if (token !== unifiedSequence) return;
      const section = $('#catalog-group-'+group);
      section.outerHTML = catalogGroup(result.groups[0]);
      // Keep the next action nearby when the existing result list expands.
      $('#catalog-group-'+group+' [data-catalog-more]')?.focus({preventScroll:true});
    } catch(error) { if (button.isConnected) { button.disabled = false; toast(error.message); } }
  }
  async function loadRecipeNutrition(recipe) {
    const token = ++nutritionSequence;
    try {
      const link = await catalog.recipeLinks(recipe);
      if (token !== nutritionSequence || activeRecipe?.id !== recipe.id) return;
      $('#recipe-linked-nutrition').innerHTML = `<h3>연결된 공식 음식 영양 자료</h3><p class="source-note">음식명 일치 또는 관련 후보 ${link.total}건 중 ${link.foods.length}건입니다. 다른 조리법·원료·기준량의 자료일 수 있어 이 레시피의 영양값으로 합산하지 않습니다.</p>${link.foods.length ? `<div class="catalog-grid">${link.foods.map(catalog.card).join('')}</div>` : '<p>현재 기준으로 연결할 음식 영양 후보가 없습니다.</p>'}<button type="button" class="catalog-link" data-nutrition-query="${escape(recipe.name)}">음식명으로 추가 검색</button><div id="recipe-nutrition-search"></div>`;
    } catch(error) { if (token === nutritionSequence && activeRecipe?.id === recipe.id) $('#recipe-linked-nutrition').textContent = error.message; }
  }
  async function searchRecipeNutrition(query) {
    const recipe = activeRecipe, token = ++nutritionSequence, target = $('#recipe-nutrition-search');
    if (!target || !recipe) return;
    target.innerHTML = '<p role="status">음식 영양 자료를 검색합니다…</p>';
    try {
      const result = await catalog.search({query,group:'foods',limit:6,mode:'name'});
      if (token !== nutritionSequence || activeRecipe?.id !== recipe.id) return;
      target.innerHTML = `<p class="source-note">음식명·별칭 검색 ${result.total}건. 레시피와의 동일성을 확인한 자료는 아닙니다.</p><div class="catalog-grid">${result.matches.map(catalog.card).join('')}</div>`;
    } catch(error) { if (token === nutritionSequence && target.isConnected) target.textContent = error.message; }
  }
  function productsPanel(recipe) {
    const names = [...new Set([recipe.name, ...(recipe.ingredients || []).map(item => item.name)])];
    return `<h3>음식·재료로 찾는 관련 제품</h3><p class="source-note">제품명과 별칭으로 찾은 가공식품 영양 자료입니다. 재료의 실제 함유 여부나 같은 음식임을 보증하지 않습니다.</p><div class="catalog-ingredient-buttons" role="group" aria-label="제품 검색에 사용할 음식 또는 재료">${names.map(name => `<button type="button" class="catalog-link" data-product-query="${escape(name)}" aria-pressed="false">${escape(name)}</button>`).join('')}</div><div id="recipe-products-results"></div><p class="catalog-notice">제품 상세에서 품목제조보고번호로 원재료·회수 공고를, 제조업소 인허가번호로 HACCP 자료를 확인할 수 있습니다. 알레르기·회수 대상 제조분·인증 적용 범위는 실제 표시와 원문을 확인하세요. <a href="data-status.html">수집 현황 →</a></p>`;
  }
  async function searchRecipeProducts(query) {
    const recipe = activeRecipe, target = $('#recipe-products-results'), token = ++productSequence;
    if (!recipe || !target) return;
    target.dataset.loaded = 'true';
    $$('#panel-products [data-product-query]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.productQuery === query)));
    target.innerHTML = '<p role="status">관련 가공식품을 검색합니다…</p>';
    try {
      const result = await catalog.search({query,group:'processed-foods',limit:6,mode:'name'});
      if (token !== productSequence || activeRecipe?.id !== recipe.id) return;
      target.innerHTML = `<h4>“${escape(query)}” 제품명 검색</h4><p class="source-note">${result.total.toLocaleString('ko-KR')}건 중 ${result.matches.length}건 표시. 찾는 제품의 제조사와 품목번호를 확인하세요.</p>${result.matches.length ? `<div class="catalog-grid">${result.matches.map(catalog.card).join('')}</div>` : '<p>이 이름으로 찾은 제품이 없습니다. 위에서 다른 재료를 선택해 보세요.</p>'}<a class="catalog-link" href="food-data.html?q=${encodeURIComponent(query)}&amp;group=processed-foods">제품 검색에서 더 보기 →</a>`;
    } catch(error) { if (token === productSequence && target.isConnected) target.textContent = error.message; }
  }
  function renderPagination() {
    let controls = $('#recipe-pagination');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'recipe-pagination';
      controls.className = 'recipe-pagination';
      controls.innerHTML = '<p id="results-progress" class="results-progress" role="status" aria-live="polite" aria-atomic="true"></p><div class="pagination-actions"><button type="button" class="button button--outline load-more-button" data-load-more aria-controls="recipe-grid" aria-describedby="results-progress"></button><button type="button" class="button button--soft" data-show-all aria-controls="recipe-grid" aria-describedby="results-progress">검색 결과 전체 보기</button></div>';
      $('#recipe-grid').insertAdjacentElement('afterend', controls);
    }
    const total = currentResults.length;
    const remaining = total - displayedResults;
    controls.hidden = total <= displayedResults;
    $('#results-progress').textContent = `전체 ${total.toLocaleString('ko-KR')}개 중 ${displayedResults.toLocaleString('ko-KR')}개 표시`;
    const button = controls.querySelector('[data-load-more]');
    button.hidden = remaining <= 0;
    controls.querySelector('[data-show-all]').hidden = remaining <= 0;
    button.textContent = `다음 ${Math.min(RESULTS_BATCH_SIZE, Math.max(0, remaining))}개 더 보기`;
  }
  function loadMoreResults(all = false) {
    if (displayedResults >= currentResults.length) return;
    const grid = $('#recipe-grid');
    const start = displayedResults;
    const next = all ? currentResults.length : Math.min(start + RESULTS_BATCH_SIZE, currentResults.length);
    // Append only the next batch; existing card nodes, images, and handlers survive.
    grid.insertAdjacentHTML('beforeend', currentResults.slice(start, next).map(renderCard).join(''));
    displayedResults = next;
    renderPagination();
    const firstAdded = grid.children[start]?.querySelector('.recipe-image-button');
    // Keep the viewport steady while letting keyboard users visit the new cards.
    firstAdded?.focus({ preventScroll: true });
  }
  function renderRecent() {
    const container = $('#recent-searches');
    if (!container) return;
    container.innerHTML = recent.length ? `<span class="recent-label">최근 검색</span>${recent.map(query => `<button type="button" class="recent-chip" data-search="${escape(query)}">${escape(query)}</button>`).join('')}<button type="button" class="text-button" data-clear-recent>지우기</button>` : '';
    container.hidden = !recent.length;
  }
  function search(query, commit = true, preserveInput = false) {
    const input = $('#search-input');
    const rawQuery = String(query ?? '').slice(0, 100);
    const selectionStart = preserveInput && input === document.activeElement ? input.selectionStart : null;
    state.query = rawQuery.trim();
    if (commit && state.query) { recent = [state.query, ...recent.filter(item => item !== state.query)].slice(0, 6); persist(); }
    $('#suggestions').hidden = true;
    $('#search-input').setAttribute('aria-expanded', 'false');
    render(); updateUrl();
    // Live search must not eat a trailing space while the user is still typing.
    // Keep the filter state trimmed, but restore the exact visible input and caret.
    if (preserveInput && input) {
      input.value = rawQuery;
      if ($('#clear-search')) $('#clear-search').hidden = !rawQuery;
      if (selectionStart != null && input === document.activeElement) {
        const caret = Math.min(selectionStart, rawQuery.length);
        try { input.setSelectionRange(caret, caret); } catch {}
      }
    }
  }
  function suggestions() {
    const query = $('#search-input').value.trim();
    const matches = query ? recipes.filter(recipe => termsMatch(recipe, query)).slice(0, 5) : [];
    $('#suggestions').innerHTML = matches.map(recipe => `<button type="button" class="suggestion" data-search="${escape(recipe.name)}"><span>${escape(recipe.name)}</span><small>${escape(recipe.category)}</small></button>`).join('');
    $('#suggestions').hidden = !matches.length;
    $('#search-input').setAttribute('aria-expanded', String(Boolean(matches.length)));
  }
  function resetFilters() { state.method = state.category = state.allergen = 'all'; render(); updateUrl(); }
  function toggleSaved(id) {
    id = String(id); if (!recipeById.has(id)) return;
    const wasSaved = saved.has(id);
    if (wasSaved) saved.delete(id); else saved.add(id);
    const didSave = persist(); render();
    if (activeRecipe) updateDetailSave();
    if (didSave) toast(wasSaved ? '저장한 음식에서 해제했어요.' : '저장한 음식에 담았어요.');
    requestAnimationFrame(() => { if (!$('#recipe-dialog').open) $(`[data-save="${id}"]`)?.focus({ preventScroll: true }); });
  }
  function updateDetailSave() {
    if (!activeRecipe) return;
    const button = $('#detail-save');
    if (!button) return;
    const isSaved = saved.has(String(activeRecipe.id));
    button.innerHTML = `${icons.heart}${isSaved ? '저장됨' : '음식 저장'}`;
    button.setAttribute('aria-pressed', String(isSaved));
    button.classList.toggle('is-saved', isSaved);
  }
  function showDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    dialog.showModal(); document.body.classList.add('dialog-open');
  }
  function closeDialog(id) { document.getElementById(id)?.close(); }
  function openRecipe(id, push = true) {
    const recipe = recipeById.get(String(id)); if (!recipe) return;
    const wasOpen = $('#recipe-dialog').open;
    if (!wasOpen) returnFocus = document.activeElement;
    activeRecipe = recipe; activeTab = 'recipe';
    selectedRecipeId = String(recipe.id);
    $$('#recipe-grid [data-card-id]').forEach(card => {
      const selected = card.dataset.cardId === selectedRecipeId;
      card.classList.toggle('is-selected', selected);
      card.querySelector('[data-selection-label]').hidden = !selected;
    });
    const known = allergens(recipe);
    $('#detail-content').innerHTML = `<div class="detail-hero"><img src="${escape(safeImage(recipe.image))}" alt="${escape(recipe.name)}" width="600" height="440"><div class="detail-heading"><div class="recipe-tags"><span class="tag tag--green">${escape(recipe.category)}</span><span class="tag">${escape(recipe.method)}</span></div><h2 id="recipe-dialog-title">${escape(recipe.name)}</h2><p>식품안전나라의 재료와 만드는 법을 함께 살펴보세요.</p><div class="detail-actions"><button type="button" id="detail-save" class="button button--soft" data-save="${escape(recipe.id)}"></button><button type="button" class="button button--soft" data-share="${escape(recipe.id)}">${icons.share} 공유</button></div></div></div>
      <div class="detail-tabs" role="tablist" aria-label="음식 상세 정보">${[['recipe', '레시피'], ['ingredients', '재료·장보기'], ['nutrition', '영양'], ['products', '관련 제품'], ['allergy', '알레르기'], ['notes', '내 메모']].map(([key, text]) => `<button type="button" id="tab-${key}" data-tab="${key}" role="tab" aria-selected="${key === 'recipe'}" aria-controls="panel-${key}" tabindex="${key === 'recipe' ? '0' : '-1'}">${text}</button>`).join('')}</div>
      <section class="tab-panel" id="panel-recipe" role="tabpanel" tabindex="0" aria-labelledby="tab-recipe">${recipePanel(recipe)}</section>
      <section class="tab-panel" id="panel-ingredients" role="tabpanel" tabindex="0" aria-labelledby="tab-ingredients" hidden>${ingredientsPanel(recipe)}</section>
      <section class="tab-panel" id="panel-nutrition" role="tabpanel" tabindex="0" aria-labelledby="tab-nutrition" hidden>${nutritionPanel(recipe)}<div id="recipe-linked-nutrition" class="catalog-related"><h3>연결된 공식 음식 영양 자료</h3><p role="status">음식명 연결 후보를 확인합니다…</p></div></section>
      <section class="tab-panel" id="panel-products" role="tabpanel" tabindex="0" aria-labelledby="tab-products" hidden>${productsPanel(recipe)}</section>
      <section class="tab-panel" id="panel-allergy" role="tabpanel" tabindex="0" aria-labelledby="tab-allergy" hidden>${allergyPanel(recipe, known)}</section>
      <section class="tab-panel" id="panel-notes" role="tabpanel" tabindex="0" aria-labelledby="tab-notes" hidden>${notesPanel(recipe)}</section>
      <footer class="detail-source source-note">출처: <a href="${escape(sourceUrl())}" target="_blank" rel="noopener noreferrer">식품안전나라 조리식품 레시피 DB</a> · 원문 ID ${escape(recipe.id)}<br>가져온 날짜 ${escape(fetchedDate())} · 원문 개별 갱신일 미제공</footer>`;
    $('#recipe-dialog').setAttribute('aria-labelledby', 'recipe-dialog-title');
    updateDetailSave(); showDialog('recipe-dialog');
    loadRecipeNutrition(recipe);
    $('#recipe-dialog').scrollTop = 0;
    // Related recipes share the open detail entry, so closing returns directly
    // to the list instead of leaving a stack of dismissed dialogs.
    if (push) updateUrl(!wasOpen);
  }
  function recipePanel(recipe) {
    const steps = recipe.steps || [];
    if (!steps.length) return '<h3>조리 순서 미제공</h3><p class="notice">원문에 조리 순서가 제공되지 않았습니다. 조리 단계가 있는 다른 레시피를 확인해 주세요.</p>';
    const missing = steps.some((step, index) => Number(step.number) !== index + 1);
    const related = relatedRecipes(recipe);
    return `<div class="panel-heading"><h3>차근차근, 만드는 법</h3><span class="tag">${steps.length}개 단계</span></div><p class="source-note">조리시간과 난이도는 원문에서 제공하지 않습니다.</p>${missing ? '<p class="notice">원문에 일부 단계 번호가 없습니다. 제공된 순서와 번호를 그대로 표시합니다.</p>' : ''}<ol class="step-list">${steps.map(step => `<li value="${Number(step.number) || 1}"><span class="step-number" aria-hidden="true">${Number(step.number) || 1}</span><div><p>${escape(String(step.text || '').replace(/^\s*\d+\s*[.)]\s*/, '').replace(/([.!?다요])\s*[abc]$/, '$1'))}</p></div></li>`).join('')}</ol>${related.length ? `<div class="related-section"><h3>같은 재료로 만드는 다른 음식</h3><p class="source-note">재료 이름이 겹치는 레시피를 모았어요.</p><div class="related-list">${related.map(other => `<button type="button" class="related-recipe" data-recipe-id="${escape(other.id)}"><img src="${escape(safeImage(other.image))}" alt="" width="56" height="56" loading="lazy"><span>${escape(other.name)}</span>${icons.arrow}</button>`).join('')}</div></div>` : ''}`;
  }
  function ingredientsPanel(recipe) {
    if (!(recipe.ingredients || []).length) {
      const original = String(recipe.ingredientText || '').trim();
      return `<h3>필요한 재료</h3><p class="notice">${original ? '재료 원문을 개별 항목으로 나누지 못했습니다. 아래 원문을 확인해 주세요.' : '원문에 재료 정보가 제공되지 않아 장보기 목록에 담을 수 없습니다.'}</p>${original ? `<details class="original-ingredients" open><summary>재료 원문 보기</summary><p>${escape(original)}</p></details>` : ''}`;
    }
    return `<div class="panel-heading"><h3>필요한 재료</h3><button type="button" class="button button--primary" data-add-all="${escape(recipe.id)}">${icons.bag} 모두 담기</button></div><p class="source-note">원문에 적힌 분량입니다. 장보기는 판매처의 검색 결과로 연결되며, 가격·재고 정보는 제공하지 않습니다.</p><div class="ingredient-list">${(recipe.ingredients || []).map((ingredient, index) => {
      const key = cartKey(recipe.id, ingredient.name, ingredient.amount);
      const inCart = cart.some(item => item.key === key);
      return `<div class="ingredient-row"><div><strong class="ingredient-name">${escape(ingredient.name)}</strong><span class="ingredient-amount">${escape(ingredient.amount || '분량 미제공')}</span></div><div class="ingredient-actions"><button type="button" class="button button--soft ingredient-add" data-add-ingredient="${escape(recipe.id)}:${index}" ${inCart ? 'disabled' : ''}>${inCart ? '담음' : '담기'}</button><button type="button" class="button button--soft" data-ingredient-official="${index}">원료 정보</button><button type="button" class="button button--soft" data-ingredient-products="${index}">관련 제품</button><a class="ingredient-shop" href="https://search.shopping.naver.com/search/all?query=${encodeURIComponent(ingredient.name)}" target="_blank" rel="noopener noreferrer" aria-label="${escape(ingredient.name)} 네이버쇼핑에서 검색">구매처 ↗</a></div></div>`;
    }).join('')}</div><details class="original-ingredients"><summary>재료 원문 보기</summary><p>${escape(recipe.ingredientText)}</p></details><p class="source-note">구매 링크는 일반 검색 링크이며 현재 제휴 수익이 발생하지 않습니다.</p><button type="button" class="button button--soft" data-shopping-open>${icons.bag} 장보기 목록 보기</button>`;
  }
  function nutritionPanel(recipe) {
    const nutrition = recipe.nutrition || {};
    const entries = [['열량', nutrition.energy, 'kcal'], ['탄수화물', nutrition.carbohydrates, 'g'], ['단백질', nutrition.protein, 'g'], ['지방', nutrition.fat, 'g'], ['나트륨', nutrition.sodium, 'mg']];
    const providedNumber = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    const weight = providedNumber(nutrition.weight);
    const sourceNotices = [];
    if (entries.every(([, value]) => providedNumber(value) === 0)) sourceNotices.push('원문 영양값이 모두 0으로 기재되어 있습니다. 실제 영양 정보는 원문 제공기관에 확인해 주세요.');
    if (weight > 0 && [nutrition.carbohydrates, nutrition.protein, nutrition.fat].some(value => providedNumber(value) > weight)) sourceNotices.push('원문 영양값에 기준 중량보다 큰 수치가 있어 확인이 필요합니다.');
    return `<h3>원문에 제공된 영양 정보</h3><p class="notice">${nutrition.weight ? `원문 중량(1인분): ${escape(nutrition.weight)}. ` : '원문에서 기준 중량을 제공하지 않았습니다. '}아래 수치를 임의로 100g 또는 실제 섭취 1인분 기준으로 해석하지 마세요.</p>${sourceNotices.map(text => `<p class="notice notice--warning">${text}</p>`).join('')}<div class="nutrition-grid">${entries.map(([label, value, unit]) => `<div class="nutrition-item"><span>${label}</span><strong>${number(value)}${value == null || value === '' ? '' : `<small>${unit}</small>`}</strong></div>`).join('')}</div><p class="source-note">식품안전나라 COOKRCP01 제공값입니다. 재료의 종류·분량·조리법에 따라 실제 영양은 달라집니다. 기준 분량이 확인되지 않은 수치를 환산하지 않으며, 음식 간 영양 순위와 식단 목표 필터는 제공하지 않습니다.</p>`;
  }
  function allergyPanel(recipe, known) {
    const possible = possibleAllergens(recipe);
    return `<h3>재료명에서 찾은 주의 성분</h3><p class="notice notice--warning">재료의 단어를 바탕으로 찾은 참고 정보입니다. 알레르기 안전 여부를 판정하지 않으며, 제품 표시와 실제 조리 환경을 별도로 확인해야 합니다.</p>${known.length ? `<div class="allergen-list">${known.map(item => `<div class="allergen-row"><span class="tag tag--orange">${escape(item.name)}</span><span>재료명 단서: ${escape(item.evidence.join(', '))}</span></div>`).join('')}</div>` : '<p>등록한 성분의 단서를 찾지 못했습니다. 알레르기 성분이 없다는 뜻은 아닙니다.</p>'}${possible.length ? `<p class="notice">간장 등 복합 재료는 ${escape(possible.join(', '))}을 포함할 수 있어 제품 표시를 추가로 확인해야 합니다.</p>` : ''}<p class="source-note">교차 접촉과 원재료의 세부 배합은 이 데이터로 확인할 수 없습니다. 어류는 재료 확인을 돕는 묶음으로, 법정 표시 항목 전체를 뜻하지 않습니다.</p><a class="text-link" href="https://www.foodsafetykorea.go.kr/portal/board/boardDetail.do?bbs_no=bbs001&menu_grp=MENU_NEW01&menu_no=3120&ntctxt_no=1100304" target="_blank" rel="noopener noreferrer">식품안전나라 식품 알레르기 안내 ↗</a>`;
  }
  function notesPanel(recipe) {
    const note = typeof notes[recipe.id] === 'string' ? notes[recipe.id] : '';
    return `<h3>다음에 만들 때 기억할 것</h3><p class="source-note">메모는 이 브라우저에만 저장됩니다. 공개 리뷰나 다른 사람의 평점은 아직 연결되지 않았습니다.</p><form id="note-form"><label for="recipe-note" class="sr-only">나의 요리 메모</label><textarea id="recipe-note" maxlength="2000" rows="5" placeholder="재료를 바꿔 본 경험이나 다음에 기억할 팁을 적어 보세요.">${escape(note)}</textarea><div class="note-actions"><button type="submit" class="button button--primary">메모 저장</button><span id="note-feedback" role="status">${note ? '저장된 메모가 있어요.' : ''}</span></div></form><a class="text-link" href="https://search.naver.com/search.naver?query=${encodeURIComponent(`${recipe.name} 후기`)}" target="_blank" rel="noopener noreferrer">외부 후기 검색 ↗</a>`;
  }
  function ingredientIdentity(name) {
    return normalize(name).replace(/다진|칵테일|저염|조선|날|무염/g, '').replace(/연두부|순두부/g, '두부').replace(/북어채/g, '북어');
  }
  function relatedRecipes(recipe) {
    const names = (recipe.ingredients || []).map(item => ingredientIdentity(item.name)).filter(name => !['물', '설탕', '마늘', '참깨', '참기름'].includes(name));
    return recipes.filter(other => String(other.id) !== String(recipe.id)).map(other => ({ recipe: other, overlap: (other.ingredients || []).filter(item => names.includes(ingredientIdentity(item.name))).length })).filter(item => item.overlap).sort((a, b) => b.overlap - a.overlap).slice(0, 3).map(item => item.recipe);
  }
  function setTab(key, focus = false) {
    if (!['recipe', 'ingredients', 'nutrition', 'products', 'allergy', 'notes'].includes(key)) return;
    activeTab = key;
    if (key === 'products' && activeRecipe && !$('#recipe-products-results').dataset.loaded) searchRecipeProducts(activeRecipe.name);
    $$('.detail-tabs [role="tab"]').forEach(tab => { const selected = tab.dataset.tab === key; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    $$('.tab-panel').forEach(panel => { panel.hidden = panel.id !== `panel-${key}`; });
    if (focus) $(`#tab-${key}`)?.focus();
  }
  function addIngredient(id, index, deferSave = false) {
    const recipe = recipeById.get(String(id));
    const ingredient = recipe?.ingredients?.[index];
    if (!ingredient) return false;
    const snapshot = snapshotIngredient(recipe, ingredient);
    if (cart.some(item => item.key === snapshot.key)) return false;
    cart.push(snapshot);
    if (!deferSave) {
      const didSave = persist(); updateCounts(); refreshIngredients();
      if (didSave) toast('장보기 목록에 담았어요.');
    }
    return true;
  }
  function refreshIngredients() { if (activeRecipe && $('#panel-ingredients')) $('#panel-ingredients').innerHTML = ingredientsPanel(activeRecipe); }
  function cartText() {
    return `음식한눈 장보기 목록\n${cart.map(item => `${item.checked ? '[완료]' : '[ ]'} ${item.name} ${item.amount || ''} — ${item.recipeName}${cartItemStatus(item) ? `\n  ${cartItemStatus(item)}` : ''}`).join('\n')}\n\n분량은 담을 당시 각 레시피의 원문 기준입니다.`;
  }
  function renderShopping() {
    const remaining = cart.filter(item => !item.checked).length;
    $('#shopping-content').innerHTML = `<div class="panel-heading"><div><p class="eyebrow">MY SHOPPING LIST</p><h2 id="shopping-dialog-title">잊지 않고, 장보기</h2></div><span class="tag tag--green">남은 재료 ${remaining}개</span></div><p class="source-note">이 브라우저에 저장돼요. 같은 재료라도 레시피별로 담을 당시 분량을 따로 보관합니다.</p>${cart.length ? `<div class="shopping-toolbar"><button type="button" class="button button--soft" data-copy-cart>목록 복사</button><button type="button" class="text-button" data-clear-checked ${cart.some(item => item.checked) ? '' : 'disabled'}>완료 항목 지우기</button></div><div class="shopping-list">${cart.map(item => {
      const status = cartItemStatus(item);
      return `<div class="shopping-item ${item.checked ? 'is-checked' : ''}"><label class="shopping-item-main"><input type="checkbox" data-check-cart="${escape(item.key)}" ${item.checked ? 'checked' : ''}><span><strong>${escape(item.name)} <small>${escape(item.amount || '')}</small></strong><span>${escape(item.recipeName)}</span>${status ? `<small class="source-note">${escape(status)}</small>` : ''}</span></label><div class="shopping-item-actions">${item.unresolved ? '' : `<a class="text-link" href="https://search.shopping.naver.com/search/all?query=${encodeURIComponent(item.name)}" target="_blank" rel="noopener noreferrer" aria-label="${escape(item.name)} 네이버쇼핑 검색">구매처 ↗</a>`}<button type="button" class="icon-button" data-remove-cart="${escape(item.key)}" aria-label="${escape(item.name)} 목록에서 제거">×</button></div></div>`;
    }).join('')}</div>` : '<div class="empty-state"><span class="empty-icon" aria-hidden="true">🥬</span><h3>장보기 목록이 비어 있어요</h3><p>음식 상세의 재료·장보기에서 필요한 재료를 담아 보세요.</p><button type="button" class="button button--primary" data-close="shopping-dialog">음식 둘러보기</button></div>'}`;
    $('#shopping-dialog').setAttribute('aria-labelledby', 'shopping-dialog-title');
  }
  async function copyText(text, success) {
    try { if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(text); toast(success); }
    catch {
      const target = $('#shopping-dialog').open ? $('#shopping-content') : $('#recipe-dialog').open ? $('#detail-content') : $('#sources-content');
      const old = $('#copy-fallback'); if (old) old.remove();
      const area = document.createElement('textarea'); area.id = 'copy-fallback'; area.value = text; area.readOnly = true; area.setAttribute('aria-label', '복사할 내용'); area.className = 'copy-fallback';
      target.append(area); if (!$('#shopping-dialog').open && !$('#recipe-dialog').open) showDialog('sources-dialog'); area.focus(); area.select(); toast('선택된 내용을 직접 복사해 주세요.');
    }
  }
  async function shareRecipe(id) {
    const recipe = recipeById.get(String(id)); if (!recipe) return;
    const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('recipe', recipe.id);
    const shareUrl = url.protocol === 'file:' ? sourceUrl() : url.href;
    if (navigator.share && url.protocol !== 'file:') {
      try { await navigator.share({ title: `${recipe.name} · 음식한눈`, text: `${recipe.name}의 재료와 레시피를 확인해 보세요.`, url: shareUrl }); return; } catch (error) { if (error.name === 'AbortError') return; }
    }
    await copyText(`${recipe.name} · 음식한눈\n${shareUrl}`, '음식 공유 링크를 복사했어요.');
  }
  function renderSources() {
    $('#sources-content').innerHTML = `<p class="eyebrow">ABOUT THE DATA</p><h2 id="sources-dialog-title">어디에서 온 정보인가요?</h2><p>음식한눈은 공식 레시피와 K-FCDB 음식·가공식품·건강기능식품 영양 자료를 연결하는 민간 음식 통합검색 서비스입니다.</p><dl class="source-definition"><div><dt>현재 수록</dt><dd>${datasetLabel} ${recipes.length}종</dd></div><div><dt>가져온 날짜</dt><dd>${escape(fetchedDate())}</dd></div><div><dt>레시피·재료·사진·영양</dt><dd>식품의약품안전처 COOKRCP01</dd></div><div><dt>공식 영양·제품 DB</dt><dd>K-FCDB ${nutritionTotal == null ? '수집본' : nutritionTotal.toLocaleString('ko-KR')+'건'} · <a href="data-status.html">수집·연결 현황</a></dd></div><div><dt>데이터 연결</dt><dd>음식명·별칭·음식명 포함 후보를 구분. 기관 간 동일 레시피 식별키 없음.</dd></div><div><dt>알레르기 표시</dt><dd>재료명 단서 분석 · 안전 판정 아님</dd></div><div><dt>저장한 음식·메모·장보기</dt><dd>현재 브라우저에 보관</dd></div><div><dt>구매처</dt><dd>네이버쇼핑 일반 검색 링크 · 제휴 아님</dd></div></dl><div class="source-links"><a href="${escape(sourceUrl())}" target="_blank" rel="noopener noreferrer">식품안전나라 API 원문 ↗</a><a href="https://www.data.go.kr/data/15060073/openapi.do" target="_blank" rel="noopener noreferrer">공공데이터포털 데이터·이용 조건 ↗</a>${data.meta?.datasetMode === 'official-sample' ? '<a href="https://openapi.foodsafetykorea.go.kr/api/sample/COOKRCP01/json/1/5" target="_blank" rel="noopener noreferrer">공개 샘플 데이터 ↗</a>' : ''}</div><p class="notice">검색 시 마지막 검증된 레시피·음식·제품 스냅샷을 조회합니다. 공식 원재료·회수·업소 HACCP 자료의 수집·연결 상태는 수집 현황에서 확인할 수 있습니다. 공개 리뷰, 가격·재고 조회, 이미지 인식은 아직 연결되지 않았습니다.</p><p class="source-note">기준 중량이 없는 영양값을 환산하지 않습니다. 원문 데이터에도 누락이나 오류가 있을 수 있습니다.</p>`;
    $('#sources-dialog').setAttribute('aria-labelledby', 'sources-dialog-title');
  }
  function initVoice() {
    const button = $('#voice-search');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!button || !SpeechRecognition || !window.isSecureContext) { if (button) button.hidden = true; return; }
    button.hidden = false;
    button.title = '음성 검색 · 브라우저의 음성 인식 서비스를 이용합니다';
    button.addEventListener('click', () => {
      if (listening) { recognition?.stop(); return; }
      recognition = new SpeechRecognition(); recognition.lang = 'ko-KR'; recognition.interimResults = false; recognition.maxAlternatives = 1;
      recognition.onstart = () => { listening = true; button.classList.add('is-listening'); button.setAttribute('aria-label', '음성 검색 멈추기'); toast('음식명이나 재료를 말해 주세요.'); };
      recognition.onresult = event => { $('#search-input').value = event.results[0][0].transcript; search($('#search-input').value); };
      recognition.onerror = event => { toast(event.error === 'not-allowed' ? '음성 검색 권한이 없습니다. 검색어를 직접 입력해 주세요.' : '음성을 인식하지 못했어요. 검색어를 직접 입력해 주세요.'); };
      recognition.onend = () => { listening = false; button.classList.remove('is-listening'); button.setAttribute('aria-label', '음성으로 검색'); };
      try { recognition.start(); } catch { toast('이 브라우저에서 음성 검색을 시작할 수 없습니다.'); }
    });
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button, [data-recipe-id]');
    const card = event.target.closest('#recipe-grid [data-card-id]');
    if (!button && card) {
      card.querySelector('.card-open')?.focus({ preventScroll: true });
      openRecipe(card.dataset.cardId);
      return;
    }
    if (!button) { if (!event.target.closest('#search-form')) { $('#suggestions').hidden = true; $('#search-input').setAttribute('aria-expanded', 'false'); } return; }
    if (button.dataset.resultKind) { state.kind = button.dataset.resultKind; render(); updateUrl(); return; }
    if (button.dataset.catalogMore) { loadCatalogMore(button.dataset.catalogMore, button); return; }
    if (button.hasAttribute('data-ingredient-official') && activeRecipe) { window.FoodSafety.showIngredient(activeRecipe.ingredients[Number(button.dataset.ingredientOfficial)]?.name || '', button); return; }
    if (button.hasAttribute('data-ingredient-products') && activeRecipe) { searchRecipeProducts(activeRecipe.ingredients[Number(button.dataset.ingredientProducts)]?.name || activeRecipe.name); setTab('products'); return; }
    if (button.dataset.productQuery) { searchRecipeProducts(button.dataset.productQuery); return; }
    if (button.dataset.nutritionQuery) { searchRecipeNutrition(button.dataset.nutritionQuery); return; }
    if (button.hasAttribute('data-load-more')) { loadMoreResults(); return; }
    if (button.hasAttribute('data-show-all')) { loadMoreResults(true); return; }
    if (button.dataset.save) { toggleSaved(button.dataset.save); return; }
    if (button.dataset.recipeId) { openRecipe(button.dataset.recipeId); return; }
    if (button.dataset.search) { clearTimeout(typingTimer); $('#search-input').value = button.dataset.search; state.view = 'all'; search(button.dataset.search); return; }
    if (button.dataset.view) { state.view = button.dataset.view; render(); updateUrl(); return; }
    if (button.dataset.close) { closeDialog(button.dataset.close); return; }
    if (button.dataset.open) { if (button.dataset.open === 'sources-dialog') renderSources(); showDialog(button.dataset.open); return; }
    if (button.dataset.tab) { setTab(button.dataset.tab); return; }
    if (button.dataset.removeFilter) { state[button.dataset.removeFilter] = 'all'; render(); updateUrl(); return; }
    if (button.dataset.share) { shareRecipe(button.dataset.share); return; }
    if (button.hasAttribute('data-clear-recent')) { recent = []; persist(); renderRecent(); return; }
    if (button.dataset.addIngredient) {
      const [id, indexText] = button.dataset.addIngredient.split(':');
      const index = Number(indexText);
      const added = addIngredient(id, index);
      if (added) requestAnimationFrame(() => {
        const available = $$('[data-add-ingredient]').filter(item => item.dataset.addIngredient?.startsWith(`${id}:`) && !item.disabled);
        const next = available.find(item => Number(item.dataset.addIngredient.split(':')[1]) > index) || available[0] || $('[data-shopping-open]');
        next?.focus({ preventScroll: true });
      });
      return;
    }
    if (button.dataset.addAll) {
      const recipe = recipeById.get(button.dataset.addAll);
      const added = (recipe?.ingredients || []).map((_, index) => addIngredient(recipe.id, index, true)).filter(Boolean).length;
      const didSave = added ? persist() : true;
      updateCounts(); refreshIngredients();
      if (didSave) toast(added ? '재료를 장보기 목록에 담았어요.' : '이미 모든 재료가 장보기 목록에 있어요.');
      requestAnimationFrame(() => $('[data-shopping-open]')?.focus({ preventScroll: true }));
      return;
    }
    if (button.hasAttribute('data-copy-cart')) { copyText(cartText(), '장보기 목록을 복사했어요.'); return; }
    if (button.hasAttribute('data-clear-checked')) {
      cart = cart.filter(item => !item.checked);
      const didSave = persist(); updateCounts(); renderShopping(); refreshIngredients();
      if (didSave) toast('완료한 항목을 정리했어요.');
      requestAnimationFrame(() => ($('[data-clear-checked]') || $('[data-copy-cart]') || $('#shopping-dialog .modal-close'))?.focus({ preventScroll: true }));
      return;
    }
    if (button.dataset.removeCart) {
      const removeIndex = $$('[data-remove-cart]').indexOf(button);
      cart = cart.filter(item => item.key !== button.dataset.removeCart);
      persist(); updateCounts(); renderShopping(); refreshIngredients();
      requestAnimationFrame(() => {
        const remainingRemoveButtons = $$('[data-remove-cart]');
        const next = remainingRemoveButtons[Math.min(Math.max(removeIndex, 0), Math.max(remainingRemoveButtons.length - 1, 0))] || $('[data-copy-cart]') || $('#shopping-dialog .modal-close');
        next?.focus({ preventScroll: true });
      });
      return;
    }
    if (button.id === 'shopping-open' || button.hasAttribute('data-shopping-open')) { renderShopping(); showDialog('shopping-dialog'); return; }
  });
  document.addEventListener('change', event => {
    if (event.target.dataset.checkCart) {
      const key = event.target.dataset.checkCart;
      const item = cart.find(item => item.key === key);
      if (item) item.checked = event.target.checked;
      persist(); updateCounts(); renderShopping();
      $$('[data-check-cart]').find(input => input.dataset.checkCart === key)?.focus();
    }
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'note-form' || !activeRecipe) return;
    event.preventDefault(); const text = $('#recipe-note').value.trim().slice(0, 2000); if (text) notes[activeRecipe.id] = text; else delete notes[activeRecipe.id]; const didSave = persist(); $('#note-feedback').textContent = didSave ? '이 브라우저에 저장했어요.' : '이번 화면에서만 유지됩니다.';
  });
  document.addEventListener('keydown', event => {
    if (event.target.getAttribute('role') !== 'tab' || !event.target.closest('.detail-tabs')) return;
    const keys = ['recipe', 'ingredients', 'nutrition', 'products', 'allergy', 'notes']; let index = keys.indexOf(activeTab);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault(); setTab(keys[index], true);
  });
  document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement && !event.target.src.endsWith('food-placeholder.svg')) { event.target.src = fallbackImage; event.target.alt = '음식 사진을 불러올 수 없습니다'; } }, true);
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(typingTimer); search($('#search-input').value); $('#search-input').blur(); });
  $('#search-input').addEventListener('input', () => { clearTimeout(typingTimer); const value = $('#search-input').value; if ($('#clear-search')) $('#clear-search').hidden = !value; typingTimer = setTimeout(() => { search(value, false, true); suggestions(); }, 180); });
  $('#search-input').addEventListener('keydown', event => { if (event.key === 'Escape') { $('#suggestions').hidden = true; $('#search-input').setAttribute('aria-expanded', 'false'); } if (event.key === 'ArrowDown' && !$('#suggestions').hidden) { event.preventDefault(); $('#suggestions button')?.focus(); } });
  $('#clear-search')?.addEventListener('click', () => { clearTimeout(typingTimer); search(''); $('#search-input').focus(); });
  $('#filter-toggle')?.addEventListener('click', () => { const panel = $('#filter-panel'); panel.hidden = !panel.hidden; $('#filter-toggle').setAttribute('aria-expanded', String(!panel.hidden)); });
  for (const key of ['method', 'category', 'allergen']) $(`#${key}-filter`)?.addEventListener('change', event => { state[key] = event.target.value; render(); updateUrl(); });
  $('#sort-select')?.addEventListener('change', event => { state.sort = event.target.value; render(); updateUrl(); });
  $('#reset-filters')?.addEventListener('click', resetFilters);
  $('#empty-reset')?.addEventListener('click', () => { state.query = ''; state.view = 'all'; resetFilters(); });
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'recipe-dialog' && !dialog.open) {
        // readUrl clears activeRecipe before a popstate-driven close. Only an
        // explicit dismissal consumes the detail history entry we created.
        const wasActive = Boolean(activeRecipe);
        activeRecipe = null;
        if (wasActive) {
          if (history.state?.foodhannunDetail === true) history.back();
          else updateUrl();
        }
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
      if (!$$('dialog[open]').length) document.body.classList.remove('dialog-open');
    });
  });
  window.addEventListener('popstate', readUrl);
  initializeDataControls(); renderSources(); readUrl(); initVoice();
  if (cartNeedsMigration) persist();
  initializeHero();
  catalog.manifest().then(snapshot => { nutritionTotal = snapshot.count; renderSources(); }).catch(() => {});
  if (!persistenceAvailable) toast('현재 브라우저에서는 저장 기능이 이번 화면에만 유지될 수 있어요.');
})();

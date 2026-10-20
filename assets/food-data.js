(() => {
  'use strict';
  const $ = selector => document.querySelector(selector), catalog = window.FoodCatalog;
  let sequence = 0, limit = 50;
  async function search(reset = true) {
    if (reset) limit = 50;
    const token = ++sequence, query = $('#data-query').value.slice(0,100), group = $('#data-group').value;
    $('#food-data-results').setAttribute('aria-busy','true');
    $('#food-data-results').innerHTML = ''; $('#data-more').hidden = true;
    $('#data-message').textContent = '공식 수집본에서 검색합니다…';
    const url = new URL(location.href);
    if (query) url.searchParams.set('q',query); else url.searchParams.delete('q');
    url.searchParams.set('group',group); history.replaceState(null,'',url);
    try {
      const result = await catalog.search({query,group,limit});
      if (token !== sequence) return;
      $('#data-message').textContent = `검색 결과 ${result.total.toLocaleString('ko-KR')}건 중 ${result.matches.length.toLocaleString('ko-KR')}건 표시`;
      $('#food-data-results').innerHTML = result.matches.map(catalog.card).join('');
      $('#data-more').hidden = result.matches.length >= result.total;
    } catch (error) { if (token === sequence) $('#data-message').textContent = error.message; }
    finally { if (token === sequence) $('#food-data-results').setAttribute('aria-busy','false'); }
  }
  $('#food-data-form').addEventListener('submit',event => { event.preventDefault(); search(); });
  $('#data-group').addEventListener('change',() => search());
  $('#data-more').addEventListener('click',() => { limit += 50; search(false); });
  const params = new URL(location.href).searchParams;
  $('#data-query').value = (params.get('q') || '').slice(0,100);
  if ([...$('#data-group').options].some(option => option.value === params.get('group'))) $('#data-group').value = params.get('group');
  search();
})();

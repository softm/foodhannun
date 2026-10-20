(() => {
 'use strict';
 const $=s=>document.querySelector(s);let token=0,limit=50;
 const worker=new Worker('assets/food-safety-worker.js?v=20261020-api1');
 function search(reset=true){if(reset)limit=50;const query=$('#safety-query').value.trim().slice(0,100),service=$('#safety-service').value;$('#safety-results').innerHTML='';$('#safety-message').textContent='첫 검색은 해당 원본의 압축 인덱스를 불러옵니다…';$('#safety-more').hidden=true;const url=new URL(location.href);url.searchParams.set('service',service);if(query)url.searchParams.set('q',query);else url.searchParams.delete('q');history.replaceState(null,'',url);worker.postMessage({requestId:++token,service,query,limit});}
 worker.onmessage=({data})=>{if(data.requestId!==token)return;if(data.error){$('#safety-message').textContent=data.error;return;}$('#safety-message').textContent=`${data.source.name} · 검색 ${data.total.toLocaleString('ko-KR')}건 중 ${data.matches.length}건 표시 · 수집 시각(UTC): ${data.source.fetchedAt}`;$('#safety-results').innerHTML=data.matches.map(window.FoodSafety.card).join('');$('#safety-more').hidden=data.matches.length>=data.total;};
 worker.onerror=()=>{$('#safety-message').textContent='검색을 시작하지 못했습니다. 새로고침 후 다시 시도해 주세요.';};
 $('#safety-form').addEventListener('submit',e=>{e.preventDefault();search();});$('#safety-service').addEventListener('change',()=>search());$('#safety-more').addEventListener('click',()=>{limit+=50;search(false);});
 const params=new URL(location.href).searchParams;$('#safety-query').value=(params.get('q')||'').slice(0,100);if([...$('#safety-service').options].some(o=>o.value===params.get('service')))$('#safety-service').value=params.get('service');search();
})();

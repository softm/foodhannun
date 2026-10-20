/* Exact identifiers connect official sources; names remain discovery candidates. */
(() => {
 'use strict';
 const base=new URL('../',document.currentScript.src), esc=window.FoodCatalog.escape;
 const cache=new Map();let manifestPromise,detailSequence=0,returnFocus;
 const aliases={name:['PRDLST_NM','PRDTNM','PRDUCT','PRDUCT_NM','RPRSNT_RAWMTRL_NM','RAWMTRL_NM','KOR_NM','FOOD_NM'],report:['PRDLST_REPORT_NO','PRDLST_REPORT_NUM'],license:['LCNS_NO','LCNSNO','LICENSE_NO'],barcode:['BRCD_NO','BRCDNO','BAR_CD','BARCODE','BAR_CD_NO']};
 const labels={PRDLST_REPORT_NO:'품목제조보고번호',LCNS_NO:'인허가번호',BSSH_NM:'업소명',BSSHNM:'업소명',PRDLST_NM:'제품명',PRDTNM:'제품명',PRDLST_DCNM:'품목유형',PRMS_DT:'보고·허가일자',PRODUCTION:'생산종료여부',POG_DAYCNT:'소비기한',LAST_UPDT_DTM:'최종수정일자',RAWMTRL_NM:'원재료명',RAWMTRL_ORDNO:'원재료 표시순서',CHNG_DT:'변경일자',BRCD_NO:'바코드',BRCDNO:'바코드',BAR_CD:'바코드',MNFDT:'제조일자',DISTBTMLMT:'소비·유통기한',RTRVLPRVNS:'회수 사유',RTRVL_GRDCD_NM:'회수 등급',CRET_DTM:'공고 등록일',RTRVLPLANDOC_RTRVLMTHD:'회수 방법',RAWMTRL_CD:'원료코드',RPRSNT_RAWMTRL_NM:'대표 원료명',RAWMTRL_NCKNM:'원료 이명',ENG_NM:'영문명',SCNM:'학명',REGN_CD_NM:'사용 부위',USE_YN:'사용 여부',VALD_BGN_DT:'유효 시작일',VALD_END_DT:'유효 종료일',LCLAS_NM:'원료 대분류',MLSFC_NM:'원료 중분류',USE_CND_NM:'사용 조건 구분',USE_CND_STDR_CN:'사용 조건·기준',RAWMTRL_STATS_CD_NM:'원료 상태',PRCSS_PROCS_CD_NM:'가공 공정',HACCP_APPN_DT:'HACCP 지정일자',HACCP_APPN_NO:'HACCP 지정번호',CRTFC_ENDDT:'인증 종료일',CRTFC_RETN_DT:'인증 반납일',ASGN_CANCL_DT:'지정 취소일',CLSBIZ_DT:'폐업일',CLSBIZ_DVS_CD_NM:'휴·폐업 구분'};
 function first(row,kind){return (aliases[kind]||[]).map(k=>row[k]).find(v=>v!=null&&String(v).trim())||'';}
 function numeric(value){const text=String(value??'').trim();return /^\d{8,25}$/.test(text)?text:'';}
 function bucket(key){let hash=2166136261;for(const byte of new TextEncoder().encode(key))hash=Math.imul(hash^byte,16777619)>>>0;return (hash%256).toString(16).padStart(2,'0');}
 async function read(path,lines=false,expectedHash=null){
  const response=await fetch(new URL(path,base));if(!response.ok)throw Error('공식 원재료·안전 자료를 불러오지 못했습니다. 수집 현황을 확인해 주세요.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(expectedHash&&bytes[0]===31&&bytes[1]===139){const digest=await crypto.subtle.digest('SHA-256',bytes);const actual=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');if(actual!==expectedHash)throw Error('공식 자료가 갱신 중입니다. 새로고침 후 다시 검색해 주세요.');}
  const text=bytes[0]===31&&bytes[1]===139?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text():new TextDecoder().decode(bytes);
  return lines?text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(text);
 }
 function cached(path,lines=false,expectedHash=null){if(!cache.has(path)){const promise=read(path,lines,expectedHash);cache.set(path,promise);promise.catch(()=>cache.delete(path));if(cache.size>10)cache.delete(cache.keys().next().value);}return cache.get(path);}
 function manifest(){if(!manifestPromise)manifestPromise=read('data/food-safety/manifest.json').catch(e=>{manifestPromise=null;throw e;});return manifestPromise;}
 async function lookup(kind,value){const data=await manifest(),key=kind+':'+value;const file=data.lookupFiles[bucket(key)];const rows=await cached('data/food-safety/'+file.path+'?v='+file.sha256,false,file.sha256);return rows[key]||[];}
 async function record(ref){const data=await manifest(),source=data.services[ref[0]];const chunk=source.chunks?.[ref[1]]||(source.path?{path:source.path}:null);if(!chunk)throw Error('공식 원문 위치를 확인하지 못했습니다.');const rows=await cached('data/collection/'+ref[0]+'/'+chunk.path+'?v='+(chunk.sha256||source.fetchedAt),true,chunk.sha256);if(!rows[ref[2]])throw Error('선택한 자료의 원문이 없습니다.');const row=rows[ref[2]];const id=numeric(first(row,'report'))||numeric(first(row,'barcode'))||row.RAWMTRL_CD||row.RTRVLDSUSE_SEQ||row.HACCP_APPN_NO||String(ref[1]*10000+ref[2]+1);if(ref[3]&&String(id)!==String(ref[3]))throw Error('선택한 자료와 원문의 식별자가 일치하지 않습니다. 새로 검색해 주세요.');return {service:ref[0],source,row:rows[ref[2]],ref};}
 function table(row){return '<div class="catalog-table"><table><tbody>'+Object.entries(row).filter(([,v])=>v!=null&&String(v).trim()).map(([k,v])=>`<tr><th scope="row">${esc(labels[k]||k)}</th><td>${esc(v)}</td></tr>`).join('')+'</tbody></table></div>';}
 function sourceNote(source){return `<p class="source-note"><a href="${esc(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(source.name)} 원본 ↗</a> · 수집 시각(UTC): ${esc(source.originalFetchedAt||source.fetchedAt||source.attemptedAt||'미제공')}${source.sourceLastModified?' · 원본 파일 갱신(HTTP): '+esc(source.sourceLastModified):''}${source.countNote?' · '+esc(source.countNote):''}</p>`;}
 function rawCard(item){return `<section class="safety-source-record"><h4>${esc(first(item.row,'name')||item.row.BSSH_NM||item.row.BSSHNM||item.service)}</h4>${item.service==='C005'?'<p class="catalog-notice">2018년 이후 갱신 중단 자료입니다. 현재 제품의 바코드로 확정하지 않습니다.</p>':''}${table(item.row)}${sourceNote(item.source)}</section>`;}
 async function records(refs){return Promise.all(refs.map(record));}
 async function productHTML(report){
  const number=numeric(report);if(!number)return '<p class="source-note">원문 품목제조보고번호가 없거나 형식을 확인할 수 없어 공식 번호 연결을 제공하지 않습니다.</p>';
  const data=await manifest(),refs=await lookup('report',number),items=(await records(refs)).filter(item=>numeric(first(item.row,'report'))===number),byService={};
  for(const item of items)(byService[item.service]??=[]).push(item);
  const licenses=[...new Set((byService.I1250||[]).map(item=>numeric(first(item.row,'license'))).filter(Boolean))];
  const haccp=[];for(const license of licenses)haccp.push(...await lookup('license',license));
  byService.I0580=(await records(haccp)).filter(item=>licenses.includes(numeric(first(item.row,'license'))));
  const sections=[['I1250','공식 품목제조보고','품목제조보고번호가 일치하는 신고 자료입니다.'],['C002','제품 원재료 원문','동일 품목제조보고번호로 연결했습니다. 표시순서·변경일자를 확인하세요.'],['I0490','동일 품목번호의 회수·판매중지 공고','제조일·소비기한·회수 대상 범위를 확인하세요. 공고와 동일한 제조분인지 이 자료만으로 판정하지 않습니다.'],['I0580','제조업소 HACCP 지정 자료','공식 신고의 업소 인허가번호로 연결한 자료입니다. 적용 품목·기간을 확인해야 하며 선택한 제품의 인증을 보장하지 않습니다.'],['C005','과거 바코드 연계 자료','2018년 이후 갱신 중단 자료입니다. 현재 유통 제품의 바코드로 확정하지 않습니다.']];
  return `<h3>공식 신고·원재료·안전 자료</h3><p>연결 기준: 품목제조보고번호 <strong>${esc(number)}</strong></p>`+sections.map(([service,title,note])=>{
   const source=data.services[service],found=byService[service]||[];
   const noData=source?.status==='complete'?'현재 수집본에서 이 번호와 일치하는 자료를 찾지 못했습니다.':`이 자료는 아직 전체 수집을 완료하지 못했습니다. ${source?.reason||''}`;
   return `<details class="safety-source" ${service==='I0490'&&found.length?'open':''}><summary>${esc(title)} · ${found.length?found.length+'건 연결':'연결 자료 없음'}</summary><p class="${service==='I0490'&&found.length?'catalog-notice':'source-note'}">${esc(note)}</p>${found.length?found.map(rawCard).join(''):`<p>${esc(noData)}</p>`}${service==='I0490'?'<p class="source-note">연결된 공고가 없어도 안전을 보증하지 않습니다.</p>':''}${source?sourceNote(source):''}<a href="food-safety.html?service=${service}&amp;q=${encodeURIComponent(service==='I0580'?(licenses[0]||number):number)}">해당 원본에서 더 검색 →</a></details>`;
  }).join('')+'<p class="source-note">알레르기 성분과 교차 접촉 여부는 실제 제품 표시를 별도로 확인하세요.</p>';
 }
 async function mountProduct(target,report){if(!target)return;target.innerHTML='<p role="status">공식 번호로 원재료·안전 자료를 연결합니다…</p>';try{const html=await productHTML(report);if(target.isConnected)target.innerHTML=html;}catch(error){if(target.isConnected)target.innerHTML=`<p>${esc(error.message)}</p><a href="data-status.html">수집 현황 →</a>`;}}
 const dialog=document.createElement('dialog');dialog.id='safety-dialog';dialog.className='catalog-dialog';dialog.setAttribute('aria-label','공식 원재료·안전 자료');dialog.innerHTML='<button type="button" class="catalog-close" data-safety-close aria-label="공식 자료 닫기">닫기 ×</button><div id="safety-detail"></div>';document.body.append(dialog);
 async function openHTML(loader,trigger,title){const token=++detailSequence;returnFocus=trigger;dialog.setAttribute('aria-label',title);const target=dialog.querySelector('#safety-detail');target.innerHTML='<p role="status">공식 원문을 불러옵니다…</p>';if(!dialog.open)dialog.showModal();document.body.classList.add('dialog-open');try{const html=await loader();if(token===detailSequence&&dialog.open){target.innerHTML=html;dialog.scrollTop=0;}}catch(error){if(token===detailSequence&&dialog.open)target.textContent=error.message;}}
 async function showIngredient(name,trigger){return openHTML(async()=>{const refs=await lookup('name',window.FoodSearch.normalize(name)),items=await records(refs.slice(0,24));return `<h2>${esc(name)} 공식 원료 자료</h2><p class="catalog-notice">공식 원료명·이명과 같은 이름으로 찾은 자료입니다. 사용 부위·가공 상태·사용 조건을 함께 확인하세요.</p><p class="source-note">같은 이름·이명 ${refs.length}건 중 ${items.length}건 표시</p>${items.length?items.map(rawCard).join(''):'<p>같은 이름의 원료 자료를 찾지 못했습니다. 원래 원료명으로 다시 검색해 보세요.</p>'}<a href="food-safety.html?service=I2520&amp;q=${encodeURIComponent(name)}">공식 원료 자료에서 더 검색 →</a>`;},trigger,'공식 원료 정보');}
 function card(item){return `<button type="button" class="catalog-card" data-safety-ref="${esc(JSON.stringify([item.service,item.row[4],item.row[5],item.row[0]]))}" aria-haspopup="dialog"><span class="catalog-source">${esc(item.source)}</span><strong>${esc(item.row[1])}</strong><span>${esc(item.row[2])} ${esc(item.row[3])}</span><small>${esc(item.row[7]||item.row[10]||item.row[9]||item.row[0])}</small>${item.service==='C005'?'<span class="catalog-evidence">2018년 이후 갱신 중단</span>':''}</button>`;}
 document.addEventListener('click',event=>{const selected=event.target.closest('[data-safety-ref]');if(selected){const ref=JSON.parse(selected.dataset.safetyRef);openHTML(async()=>{const item=await record(ref);return rawCard(item)+(first(item.row,'report')?await productHTML(first(item.row,'report')):'');},selected,'공식 자료 상세');}if(event.target.closest('[data-safety-close]'))dialog.close();const report=event.target.closest('[data-report-detail]');if(report)openHTML(()=>productHTML(report.dataset.reportDetail),report,'공식 품목 정보');});
 dialog.addEventListener('close',()=>{++detailSequence;if(!document.querySelector('dialog[open]'))document.body.classList.remove('dialog-open');returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});});
 function recordCard(item){const row=item.row,id=numeric(first(row,'report'))||numeric(first(row,'barcode'))||row.RAWMTRL_CD||row.RTRVLDSUSE_SEQ||row.HACCP_APPN_NO||String(item.ref[1]*10000+item.ref[2]+1);return card({service:item.service,source:item.source.name,row:[id,first(row,'name')||row.BSSH_NM||row.BSSHNM||id,'','',item.ref[1],item.ref[2],'',first(row,'report'),first(row,'license'),first(row,'barcode'),row.RAWMTRL_CD||'']});}
 async function searchConnections(target,query){
  if(!target)return;target.dataset.query=query;target.innerHTML='';if(!query)return;
  try{
   if(!/^\d{8,25}$/.test(query)){
    const refs=await lookup('name',window.FoodSearch.normalize(query)),items=await records(refs.slice(0,6));
    if(!target.isConnected||target.dataset.query!==query)return;
    target.innerHTML=`<h3>공식 원재료·안전 자료</h3>${items.length?`<p class="source-note">공식 원료명·이명 일치 ${refs.length}건 중 ${items.length}건 표시 · 사용 부위·조건을 상세에서 확인하세요.</p><div class="catalog-grid">${items.map(recordCard).join('')}</div>`:''}<a class="catalog-link" href="food-safety.html?service=I1250&amp;q=${encodeURIComponent(query)}">${esc(query)} 품목제조보고 검색 →</a> <a class="catalog-link" href="food-safety.html?service=I0490&amp;q=${encodeURIComponent(query)}">회수 공고 검색 →</a> <a class="catalog-link" href="food-safety.html?service=I2520&amp;q=${encodeURIComponent(query)}">원료 정보 검색 →</a>`;
    return;
   }
   const [report,barcode]=await Promise.all([lookup('report',query),lookup('barcode',query)]);
   if(!target.isConnected||target.dataset.query!==query)return;
   const items=await records(barcode.filter(ref=>ref[0]==='C005'));
   if(!target.isConnected||target.dataset.query!==query)return;
   target.innerHTML=`<h3>공식 번호 검색</h3>${report.length?`<button type="button" class="catalog-link" data-report-detail="${esc(query)}">품목제조보고번호 ${esc(query)} · 공식 자료 ${report.length}건 보기 →</button>`:''}${items.length?`<p class="catalog-notice">과거 바코드 연계 ${items.length}건 · 2018년 이후 갱신 중단 자료입니다.</p><div class="catalog-grid">${items.map(recordCard).join('')}</div>`:''}${!report.length&&!items.length?'<p class="source-note">이 번호와 일치하는 공식 자료를 찾지 못했습니다.</p>':''}`;
  }catch(error){if(target.dataset.query===query)target.innerHTML=`<p class="source-note">${esc(error.message)}</p>`;}
 }
 window.FoodSafety={manifest,record,lookup,card,showIngredient,mountProduct,searchConnections,productHTML,bucket};
})();

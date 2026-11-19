let hannunInstallPrompt=null;
const hannunStandalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const hannunNative=/; wv\)|HannunAndroid|AdMobNative\/1/i.test(navigator.userAgent);

function hannunInstallPlatform(){
 if(/iphone|ipad|ipod/i.test(navigator.userAgent))return 'ios';
 if(/android/i.test(navigator.userAgent))return 'android';
 return 'desktop';
}

function hannunInstallSteps(){
 if(hannunInstallPlatform()==='ios')return ['이 페이지를 Safari에서 엽니다.','공유 버튼을 누릅니다.','홈 화면에 추가를 선택한 뒤 추가를 누릅니다.'];
 if(hannunInstallPlatform()==='android')return ['브라우저 오른쪽 위 메뉴를 누릅니다.','앱 설치, 설치 및 바로가기 만들기 또는 홈 화면에 추가를 선택합니다.'];
 return ['주소창 오른쪽의 설치 아이콘을 누릅니다.','아이콘이 없으면 브라우저 메뉴에서 앱 설치를 선택합니다.'];
}

function hannunOpenInstallGuide(){
 const dialog=document.getElementById('hannun-pwa-dialog');
 const action=document.getElementById('hannun-pwa-action');
 document.getElementById('hannun-pwa-steps').innerHTML=hannunInstallSteps().map(step=>`<li>${step}</li>`).join('');
 action.hidden=!hannunInstallPrompt;
 if(!dialog.open)dialog.showModal();
}

async function hannunRequestInstall(){
 if(!hannunInstallPrompt){hannunOpenInstallGuide();return;}
 const prompt=hannunInstallPrompt;hannunInstallPrompt=null;
 await prompt.prompt();
 await prompt.userChoice.catch(()=>({outcome:'dismissed'}));
}

function hannunMountInstallUI(){
 if(hannunStandalone||hannunNative)return;
 const name=document.querySelector('meta[name="application-name"]')?.content||document.title.split(/[|·—]/)[0].trim()||'한눈서비스';
 document.body.insertAdjacentHTML('beforeend',`<button type="button" id="hannun-pwa-install" class="hannun-pwa-install" aria-label="${name} 앱 설치"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/></svg><span>앱 설치</span></button><dialog id="hannun-pwa-dialog" class="hannun-pwa-dialog" aria-labelledby="hannun-pwa-title"><button type="button" class="hannun-pwa-close" aria-label="안내 닫기">×</button><span class="hannun-pwa-eyebrow">ADD TO HOME SCREEN</span><h2 id="hannun-pwa-title">${name}을 홈 화면에 추가</h2><p>홈 화면에서 한 번에 열고, 브라우저 화면 없이 사용할 수 있어요.</p><ol id="hannun-pwa-steps"></ol><button type="button" id="hannun-pwa-action" class="hannun-pwa-action">앱 설치</button></dialog>`);
 document.getElementById('hannun-pwa-install').addEventListener('click',hannunRequestInstall);
 document.getElementById('hannun-pwa-action').addEventListener('click',hannunRequestInstall);
 document.querySelector('.hannun-pwa-close').addEventListener('click',()=>document.getElementById('hannun-pwa-dialog').close());
}

function hannunStaticResources(){
 const urls=[location.href,...performance.getEntriesByType('resource').map(entry=>entry.name)];
 return [...new Set(urls)].filter(value=>{try{return new URL(value,location.href).origin===location.origin;}catch{return false;}});
}

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();hannunInstallPrompt=event;});
window.addEventListener('appinstalled',()=>{hannunInstallPrompt=null;document.getElementById('hannun-pwa-install')?.remove();document.getElementById('hannun-pwa-dialog')?.close();});
document.addEventListener('DOMContentLoaded',hannunMountInstallUI,{once:true});
if('serviceWorker' in navigator&&!hannunNative){
 window.addEventListener('load',async()=>{
  try{
   const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
   await navigator.serviceWorker.ready;
   registration.active?.postMessage({type:'PRECACHE_URLS',urls:hannunStaticResources()});
  }catch{}
 },{once:true});
}

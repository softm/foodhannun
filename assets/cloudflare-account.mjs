// 음식한눈 로그인: Cloudflare Workers + D1 한눈 공통 계정.
// 로그인만 교체하며 localStorage의 레시피·장보기·메모를 자동으로 이관하거나 지우지 않습니다.
import {createAccountContext} from 'https://softm.github.io/shared/platform/v1/site-account.mjs?v=20261113-foodhannun-1';
import {mountSiteAccount} from 'https://softm.github.io/shared/platform/v1/account-menu.mjs?v=20261113-foodhannun-1';
import {createCloudflareAccountClient} from 'https://softm.github.io/services/cloudflare-account/src/client.mjs?v=20261113-foodhannun-1';

export const FOOD_ACCOUNT_BASE='https://softm-hannun-account.softm.workers.dev';
const SITE_ID='foodhannun';
const LEGACY_BOOT='https://softm.github.io/shared/platform/v1/boot.mjs?site=foodhannun&v=20261029-account-1';

export function createFoodAccountClient({siteId}={}) {
  if(siteId!==SITE_ID)throw Error('음식한눈 전용 인증 연결입니다.');
  const client=createCloudflareAccountClient({baseUrl:FOOD_ACCOUNT_BASE,siteId});
  const listeners=new Set();
  const emit=()=>{for(const fn of listeners)fn(client.currentUser);};
  return Object.freeze({
    siteId,
    get currentUser(){return client.currentUser;},
    onUser(fn){
      if(typeof fn!=='function')throw TypeError('계정 상태 구독 함수가 필요합니다.');
      listeners.add(fn);
      fn(client.currentUser);
      return ()=>listeners.delete(fn);
    },
    async login({popup,mode='login'}={}){
      // OAuth 로그인과 최초 회원가입은 같은 SNS 인증 후 Worker 동의 화면으로 연결됩니다.
      const result=await client.login({popup,mode});
      emit();
      return result;
    },
    async logout(){
      try{await client.logout();}
      finally{emit();}
    }
  });
}

export function mountFoodAccount() {
  // An old Android APK does not have a browser-return bridge; avoid a broken WebView popup.
  // Updated Android shells handle OAuth in the system browser and return a one-time PKCE code.
  if(location.protocol==='file:'||location.hostname==='appassets.androidplatform.net')return null;
  if(navigator.userAgent.includes('FoodHannunAndroid/')&&
     typeof window.FoodHannunAndroid?.startCloudflareLogin!=='function')return null;

  if(new URL(location.href).searchParams.get('legacyAccount')==='1'){
    // Explicitly opt in to inspect pre-migration Firebase backups. Never mount both providers.
    import(LEGACY_BOOT).catch(()=>console.warn('이전 보관소 연결을 불러오지 못했습니다.'));
    return null;
  }

  const account=createAccountContext({
    siteId:SITE_ID,
    sdkLoader:async()=>({createSiteClient:createFoodAccountClient}),
    accountPageUrl:FOOD_ACCOUNT_BASE+'/account',
    legacyVaultUrl:'https://softm.github.io/foodhannun/?legacyAccount=1'
  });
  const ui=mountSiteAccount({
    siteId:SITE_ID,name:'음식한눈',account,accountTarget:'#foodAccountSlot',vault:null
  });
  window.SoftmAccounts ||= new Map();
  window.SoftmAccounts.set(SITE_ID,account);
  window.dispatchEvent(new CustomEvent('softm:account-ready',
    {detail:{siteId:SITE_ID,account,backend:'cloudflare'}}));
  window.addEventListener('pagehide',()=>{
    ui.destroy();
    account.destroy();
    if(window.SoftmAccounts?.get(SITE_ID)===account)window.SoftmAccounts.delete(SITE_ID);
  },{once:true});
  return {account,ui};
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountFoodAccount,{once:true});
else mountFoodAccount();

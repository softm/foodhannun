import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('음식한눈 홈은 Cloudflare 계정 UI를 정확히 한 번 장착한다',()=>{
  const html=read('index.html');
  assert.equal((html.match(/id="foodAccountSlot"/g)||[]).length,1);
  assert.match(html,/assets\/cloudflare-account\.mjs\?v=/);
  assert.doesNotMatch(html,/shared\/platform\/v1\/boot\.mjs\?site=foodhannun/);
});

test('Cloudflare와 이전 Firebase 보관소는 명시적으로 분리한다',()=>{
  const module=read('assets/cloudflare-account.mjs');
  assert.match(module,/softm-hannun-account\.softm\.workers\.dev/);
  assert.match(module,/siteId:SITE_ID/);
  assert.match(module,/createCloudflareAccountClient/);
  assert.match(module,/legacyAccount/);
  assert.match(module,/accountTarget:'#foodAccountSlot'/);
  assert.match(module,/navigator\.userAgent\.includes\('FoodHannunAndroid\/'\)/);
});

test('기존 개인 자료는 자동으로 동기화하지 않는다고 안내한다',()=>{
  const html=read('privacy.html');
  assert.match(html,/Cloudflare Workers/);
  assert.match(html,/자동 이전하거나 동기화하지 않습니다/);
  assert.match(read('docs/COMMON-VAULT.md'),/localStorage/);
});

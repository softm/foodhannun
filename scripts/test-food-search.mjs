/* Execute the actual worker with actual compressed data, without a browser. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=new Map();
const context=vm.createContext({Response,Blob,DecompressionStream,TextDecoder,Uint8Array,console,URL,setTimeout,clearTimeout,
  fetch:async url=>new Response(fs.readFileSync(path.resolve(root,'assets',String(url)))),
  postMessage:message=>output.set(message.requestId,message)
});
context.self=context;
context.importScripts=filename=>vm.runInContext(fs.readFileSync(path.join(root,'assets',filename.split('?')[0]),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'assets/food-data-worker.js'),'utf8'),context);
let id=0;
async function query(args){const requestId=++id;await context.self.onmessage({data:{requestId,...args}});const result=output.get(requestId);assert(!result.error,result.error);return result;}
const all=await query({group:'all',perGroup:6});
assert.equal(all.total,348370);assert.equal(all.groups.length,3);assert.equal(all.matches.length,18);
const kimchi=await query({group:'foods',query:'김치찌개',limit:50});
assert.equal(kimchi.total,34);assert.equal(kimchi.matches.length,34);
assert(!context.FoodSearch.matches(["청국장찌개_배추김치","찌개 및 전골류"],context.FoodSearch.terms("김치찌개"),"청국장찌개_배추김치"),"query tokens must not cross field boundaries");
assert(context.FoodSearch.identity(kimchi.matches[0].row[1])==='김치찌개','exact names should rank before related dishes');
const eggs=await query({group:'foods',query:'계란찜',limit:20});
assert(eggs.total>0);assert(eggs.matches.some(m=>m.row[1].includes('달걀')),'egg aliases must work');
const initial=await query({group:'foods',query:'ㄱㅊㅉㄱ',limit:20});assert(initial.total>0);
const code=await query({group:'processed-foods',query:'P114-103010200-0827'});assert.equal(code.total,1);
const supplement=await query({group:'supplements',query:'F103-003030000-0144'});assert.equal(supplement.total,1);assert.equal(supplement.matches[0].row[6],'350mg');
const empty=await query({group:'all',query:'zzzz-no-such-food-2026'});assert.equal(empty.total,0);
const manufacturer=await query({group:'processed-foods',query:'주식회사 더스타푸드',limit:6});assert(manufacturer.total>0);
const namesOnly=await query({group:'processed-foods',query:'주식회사 더스타푸드',mode:'name'});assert.equal(namesOnly.total,0,'ingredient exploration must not match manufacturer metadata');
const links=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root,'data/food-links.json.gz'))));
let checked=0;
for(const link of Object.values(links.recipes))for(const item of link.foods){const evidence=context.FoodSearch.relation(link.name,item.row[1]);assert.equal(evidence.kind,item.evidence.kind);assert.equal(evidence.term,item.evidence.term);checked++;}
assert.equal(context.FoodSearch.relation('두부','순두부'),null,'search aliases must not establish identity');
assert.equal(context.FoodSearch.relation('토마토','방울토마토'),null);
console.log(`Actual worker: full counts, ranked names, aliases, initials, code, supplement basis, missing results, manufacturer scope passed. ${checked} JS/Python relationship rules agree.`);

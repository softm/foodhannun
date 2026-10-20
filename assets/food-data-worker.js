'use strict';
importScripts('food-search.js?v=20261020-api2');
let manifestPromise;
function manifest() {
  if (!manifestPromise) {
    manifestPromise = fetch('../data/nutrition/manifest.json').then(response => {
      if (!response.ok) throw new Error('수집 현황을 불러오지 못했습니다.');
      return response.json();
    }).catch(error => { manifestPromise = null; throw error; });
  }
  return manifestPromise;
}
const indexes = new Map();
async function readIndex(dataset) {
  if (!indexes.has(dataset.id)) {
    const loading = (async () => {
      const response = await fetch('../data/nutrition/' + dataset.index.path);
      if (!response.ok) throw new Error('검색 데이터를 불러오지 못했습니다.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = bytes[0] === 31 && bytes[1] === 139 ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(bytes);
      const data = JSON.parse(text);
      if (data.rows.length !== dataset.count) throw new Error('검색 데이터 건수 확인이 필요합니다.');
      return data.rows;
    })();
    indexes.set(dataset.id, loading);
    loading.catch(() => indexes.delete(dataset.id));
  }
  return indexes.get(dataset.id);
}
self.onmessage = async event => {
  const {requestId, query = '', group = 'foods', limit = 50, perGroup = null, mode = 'all'} = event.data;
  try {
    const data = await manifest();
    const datasets = data.datasets.filter(dataset => group === 'all' || dataset.id === group);
    const queryTerms = FoodSearch.terms(query), needle = FoodSearch.identity(query);
    const groups = await Promise.all(datasets.map(async dataset => {
      const found = [], cap = Math.max(1, Number(perGroup ?? limit) || 50);
      let total = 0;
      for (const row of await readIndex(dataset)) {
        if (queryTerms.length && !FoodSearch.matches(mode === 'name' ? row[1] : row.slice(0, 4), queryTerms, row[1])) continue;
        total++;
        const name = FoodSearch.identity(row[1]);
        const score = !needle ? 0 : name === needle ? 4 : name.startsWith(needle) ? 3 : name.includes(needle) ? 2 : 1;
        if (found.length < cap || score > found[found.length - 1].score) {
          found.push({group:dataset.id, source:dataset.name, row, score});
          found.sort((a,b) => b.score - a.score);
          if (found.length > cap) found.pop();
        }
      }
      return {id:dataset.id, name:dataset.name, total, matches:found};
    }));
    const matches = groups.flatMap(item => item.matches);
    self.postMessage({requestId, total:groups.reduce((sum,item) => sum + item.total,0), groups, matches:perGroup ? matches : matches.slice(0,limit)});
  } catch (error) {
    self.postMessage({requestId, error:error.message || '공식 수집 데이터를 확인하지 못했습니다.'});
  }
};

'use strict';
const manifestPromise = fetch('../data/nutrition/manifest.json').then(response => {
  if (!response.ok) throw new Error('수집 현황을 불러오지 못했습니다.');
  return response.json();
});
const indexes = new Map();
const normalize = value => String(value ?? '').normalize('NFC').toLowerCase().replace(/[\s·ㆍ,()[\]#&:]/g, '');
async function readIndex(dataset) {
  if (!indexes.has(dataset.id)) {
    const loading = (async () => {
      const response = await fetch('../data/nutrition/' + dataset.index.path);
      if (!response.ok) throw new Error('검색 데이터를 불러오지 못했습니다.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text;
      if (bytes[0] === 31 && bytes[1] === 139) {
        if (typeof DecompressionStream !== 'function') throw new Error('최신 브라우저에서 압축 데이터 검색을 이용해 주세요.');
        text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      } else text = new TextDecoder().decode(bytes);
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
  const {requestId, query = '', group = 'foods', limit = 50} = event.data;
  try {
    const manifest = await manifestPromise;
    const datasets = manifest.datasets.filter(dataset => group === 'all' || dataset.id === group);
    const terms = query.trim().split(/\s+/).filter(Boolean).map(normalize);
    let total = 0;
    const matches = [];
    for (const dataset of datasets) {
      for (const row of await readIndex(dataset)) {
        if (terms.length && !terms.every(term => normalize(row[0] + row[1] + row[2] + row[3]).includes(term))) continue;
        total += 1;
        if (matches.length < limit) matches.push({group:dataset.id, source:dataset.name, row});
      }
    }
    self.postMessage({requestId, total, matches});
  } catch (error) {
    self.postMessage({requestId, error:error.message || '공식 수집 데이터를 확인하지 못했습니다.'});
  }
};

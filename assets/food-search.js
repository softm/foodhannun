/* Shared query rules. Search expansion never establishes food identity. */
((root) => {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFC').toLowerCase().replace(/[\s·ㆍ,()[\]#&:_-]/g, '');
  const identity = value => normalize(value).replace(/계란/g, '달걀').replace(/북엇국/g, '북어국');
  const aliases = [['계란', '달걀', '알류'], ['두부', '순두부', '연두부'], ['북어국', '북엇국', '북어'], ['토마토', '방울토마토'], ['콩', '대두', '콩가루']];
  const consonants = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const initials = text => [...text].map(char => { const n = char.charCodeAt(0) - 44032; return n >= 0 && n <= 11171 ? consonants[Math.floor(n / 588)] : char; }).join('');
  function terms(query) {
    return String(query).trim().split(/\s+/).filter(Boolean).map(term => {
      const word = normalize(term), family = aliases.find(group => group.includes(word));
      return [...new Set([word, identity(word), ...(family || [])])];
    });
  }
  function matches(text, queryTerms, name = text) {
    const haystack = normalize(text), comparable = identity(text), initialName = initials(normalize(name));
    return queryTerms.every(group => group.some(word => haystack.includes(word) || comparable.includes(identity(word)) || (/^[ㄱ-ㅎ]+$/.test(word) && initialName.includes(word))));
  }
  function relation(recipeName, foodName) {
    if (normalize(recipeName) === normalize(foodName)) return {kind:'name-exact', term:foodName, label:'음식명 일치'};
    if (identity(recipeName) === identity(foodName)) return {kind:'alias-exact', term:foodName, label:'별칭 일치'};
    const family = String(foodName).split('_')[0].trim();
    if (identity(family).length >= 3 && identity(recipeName).includes(identity(family))) return {kind:'name-in-title', term:family, label:'음식명 포함 후보'};
    return null;
  }
  root.FoodSearch = {normalize, identity, initials, terms, matches, relation};
})(typeof self === 'undefined' ? window : self);

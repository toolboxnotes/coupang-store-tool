import assert from 'node:assert/strict';
import { normalize, demoScan } from '../lib/core.js';
import { categoriesFromRows, rowsHaveCategory, analyzeTrends, demoTrends, pvRange, trendsCSV, negativeKeywordIndex } from '../lib/trendcore.js';

const rows = normalize(demoScan(1).all.list);
assert.ok(rowsHaveCategory(rows));
assert.equal(rowsHaveCategory([{ categoryCode: '' }]), false);
const cats = categoriesFromRows(rows);
assert.equal(cats[0].code, '82224');            // 상품이 가장 많은 카테고리 먼저
assert.equal(cats[0].name, '낚시찌');
assert.ok(cats.every((c) => c.active <= c.products));

const adRows = [
  { name: 'AI 스마트', isActive: true, detail: { negativeKeywords: ['낚시 용품', '무료'] } },
  { name: '꺼진 캠페인', isActive: false, detail: { negativeKeywords: ['전자찌'] } },
];
const idx = negativeKeywordIndex(adRows);
assert.deepEqual(idx['낚시용품'], ['AI 스마트']);      // 띄어쓰기 무시
assert.equal(idx['전자찌'], undefined);                  // 꺼진 캠페인 제외

const t = demoTrends();
const a = analyzeTrends(t, rows, adRows);
assert.equal(a.keywords.length, 10);
const by = Object.fromEntries(a.keywords.map((r) => [r.keyword, r]));
assert.ok(by['낚시용품'].flags.includes('EXCLUDED'));
assert.ok(by['낚시용품'].flags.includes('MISSING'));
assert.ok(by['낚시용품'].flags.includes('HARD'));
assert.ok(by['전자찌'].flags.includes('TOP'));
assert.ok(by['바다막대찌'].flags.includes('LOW'));
assert.equal(a.recommend[0].keyword, '낚시용품');       // 제외 키워드 충돌이 맨 앞
assert.ok(!a.recommend.some((r) => r.flags.includes('TOP')));
// 나머지는 수요 큰 순
const rest = a.recommend.slice(1).map((r) => r.demand);
assert.deepEqual(rest, [...rest].sort((x, y) => y - x));
// 가격 비교: 내 가격이 중앙값의 1.3배 초과
const rowsP = rows.map((r) => (r.productId === '7000000004' ? { ...r, salePrice: 99000 } : r));
assert.ok(analyzeTrends(t, rowsP, []).keywords.find((r) => r.keyword === '바다전자찌').flags.includes('PRICE_HIGH'));
// 상세 없이 조회한 경우
const t2 = { ...t, keywords: {} };
assert.ok(analyzeTrends(t2, rows, []).keywords.every((r) => r.flags.length === 0));

assert.equal(pvRange(10000, 20000), '1만~2만');
assert.equal(pvRange(4000, 6000), '4천~6천');
assert.equal(pvRange(0, 0), '-');
const csv = trendsCSV(a.keywords);
assert.ok(csv.startsWith('﻿카테고리'));
assert.ok(csv.includes('60위 밖'));
console.log('인기 키워드 테스트 통과');

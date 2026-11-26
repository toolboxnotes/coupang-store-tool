// adcore.js 광고 분석 테스트: node tests/adcore.test.mjs
import { normalizeAds, analyzeCampaigns, summarizeAds, breakEvenRoas, adsCSV, demoAds, adCampaignUrl } from '../lib/adcore.js';
import assert from 'node:assert/strict';

assert.equal(breakEvenRoas(30), 333);
assert.equal(breakEvenRoas(50), 200);

// 실제 응답 구조 (2026-11 확인, 값은 임의): 캠페인 목록 + tableMetric(campaign_sales) + report/SALES
const raw = {
  start: 1794150000000, end: 1794668400000, days: 7,
  campaigns: [
    { id: 900100, name: 'AI 스마트', isActive: true, roasTarget: 400, budget: 300000 },
    { id: 900101, name: '꺼진 캠페인', isActive: false, roasTarget: 260, budget: 30000 },
  ],
  metrics: {
    900100: { impressions: 8000000, clicks: 34400, adAttributedOrders: 1029, adAttributedUnits: 2100, adAttributedSales: 11950000, deliveredAdCost: 5000000, todayAdSpend: 60000 },
  },
  daily: { 1794236400000: { IMPRESSIONS: 600000, CLICKS: 2100, DELIVERED_AD_COST: 430000, AD_ATTRIBUTED_ORDERS: 70, AD_ATTRIBUTED_SALES: 907300 } },
};
const { rows, daily } = normalizeAds(raw);
assert.equal(rows.length, 2);
const [r1, r2] = rows;
assert.equal(r1.roas, 239);      // 11,950,000 / 5,000,000
assert.equal(r1.ctr, 0.43);
assert.equal(r1.cvr, 2.99);
assert.equal(r2.spend, 0);       // 성과 없는 캠페인도 0으로
assert.equal(daily[0].roas, 211);

analyzeCampaigns(rows, { marginRate: 30 });
assert.ok(r1.flags.includes('LOSS'), JSON.stringify(r1.flags));          // 239% < 손익분기 333%
assert.ok(r1.flags.includes('BELOW_TARGET'));                            // 239 < 400×0.8
assert.ok(!r2.flags.includes('NO_IMP'));                                 // 꺼진 캠페인은 노출 없음 표시 안 함
// 마진율 50% → 손익분기 200% → 손실 아님
analyzeCampaigns(rows, { marginRate: 50 });
assert.ok(!r1.flags.includes('LOSS'));

// 데모 데이터로 모든 유형 확인
const d = normalizeAds(demoAds(7));
analyzeCampaigns(d.rows, { marginRate: 30 });
const by = Object.fromEntries(d.rows.map((r) => [r.name, r.flags]));
console.log(by);
assert.ok(by['데모_효자상품'].includes('SCALE_UP'));
assert.ok(by['데모_적자캠페인'].includes('LOSS'));
assert.ok(by['데모_전환없음'].includes('NO_CONV') && !by['데모_전환없음'].includes('LOSS'));
assert.ok(by['데모_목표미달'].includes('BELOW_TARGET'));
assert.ok(by['데모_노출없음'].includes('NO_IMP'));
assert.ok(by['데모_클릭률낮음'].includes('LOW_CTR') && by['데모_클릭률낮음'].includes('LOW_CVR'));
assert.deepEqual(by['데모_꺼진캠페인'], []);
const s = summarizeAds(d.rows, { marginRate: 30 });
assert.equal(s.breakEven, 333);
assert.equal(s.wasted, 1700000 + 300000 + 80000); // AI 스마트(205%)·적자캠페인 손익분기 미달 + 전환 없음 (목표미달 350%, 클릭률낮음 346%는 손익분기 이상)
assert.ok(adsCSV(d.rows).startsWith('﻿캠페인ID'));
assert.equal(adCampaignUrl(123), 'https://advertising.coupang.com/marketing/dashboard/sales/campaign/123');
assert.equal(adCampaignUrl('x'), '');
console.log('summary', s);
console.log('광고 테스트 통과');

// ── v0.5.0: AI 스마트 비교 · 변경안 · 수정안 CSV · 키워드 보고서 ──
import { aiSmartComparison, proposeChanges, recentChangeIndex, budgetUse, validateChange, changeWarning, parseCSV, parseKeywordReport, analyzeKeywords, negKeywordChanges, keywordsCSV, demoKeywordReport, adEditUrl, isAiSmartCampaign } from '../lib/adcore.js';

const D = normalizeAds(demoAds(7));
analyzeCampaigns(D.rows, { marginRate: 30 });
const ai = D.rows.find((r) => r.isAiSmart);
assert.ok(ai && ai.name === 'AI 스마트' && ai.detail.negativeKeywords.length === 3 && ai.groupId === '800000');
assert.ok(isAiSmartCampaign({ name: 'x', creationContext: ['AUTO_PRODUCT_SELECTION'] }));
assert.ok(!isAiSmartCampaign({ name: '수동 캠페인', creationContext: null }));
const cmp = aiSmartComparison(D.rows, { marginRate: 30 });
console.log('AI 비교', cmp.share, cmp.ai.roas, cmp.others.roas, cmp.notes);
assert.ok(cmp.share > 0 && cmp.notes.some((n) => n.includes('제외 키워드 3/500')) && cmp.notes.some((n) => n.includes('검수 실패')));

// 변경안
const plan = proposeChanges(D.rows, { marginRate: 30, days: 7 });
console.log('변경안', plan.map((c) => `${c.campaignName}:${c.field} ${c.from}→${c.to}`));
const byName = (n, f) => plan.find((c) => c.campaignName === n && c.field === f);
assert.equal(byName('데모_전환없음', 'isActive').to, 'OFF');
assert.equal(byName('데모_적자캠페인', 'roasTarget').to, 340);         // ROAS 150, 목표 300 < 손익분기 333 → max(300,150)×1.2=360 → 상한 340
assert.equal(byName('데모_전환없음', 'isActive').to, 'OFF');
assert.equal(byName('데모_효자상품', 'budget'), undefined);             // 예산 소진율 86% → 증액 안 함
assert.ok(plan.skipped.some((x) => x.campaignName === 'AI 스마트' && x.reason.includes('예산 조정은 효과 없음')));
assert.equal(byName('데모_노출없음', 'roasTarget'), undefined);         // 목표 300 ≤ 손익분기 → 하향 안 함
// 캠페인당 변경 1개
assert.equal(new Set(plan.map((c) => c.campaignId)).size, plan.length);

// 규칙별 확인 (기간 7일)
const mk = (o) => ({ id: 1, name: 't', isActive: true, groupId: 9, budget: 50000, roasTarget: 300, spend: 100000, sales: 250000, orders: 20, flags: ['LOSS'], ...o });
const P = (r, o = {}) => proposeChanges([r], { marginRate: 30, days: 7, ...o });
let pc = P(mk({ roas: 250 }));                                           // 손익분기 333의 75%
assert.equal(pc[0].field, 'roasTarget'); assert.equal(pc[0].to, 340);
pc = P(mk({ roas: 600, roasTarget: 500 }), { marginRate: 10 });          // 손익분기 1000
assert.equal(pc[0].to, 720);                                            // 600 × 1.2 (1000%로 한 번에 X)
// 사용자 사례: 마진 10%, ROAS 212%, 목표 300% → 360% (한 단계)
pc = P(mk({ roas: 212 }), { marginRate: 10 });
assert.equal(pc[0].field, 'roasTarget'); assert.equal(pc[0].to, 360); assert.ok(pc[0].reason.includes('제외 키워드'));
// ROAS 100% 미만 → OFF
pc = P(mk({ roas: 90 }));
assert.equal(pc[0].field, 'isActive'); assert.equal(pc[0].to, 'OFF');
// 목표가 이미 손익분기 이상: 예산 다 쓰면 축소, 아니면 변경 없음
pc = P(mk({ roas: 250, roasTarget: 400, spend: 340000 }));              // 소진율 97%
assert.equal(pc[0].field, 'budget'); assert.equal(pc[0].to, 40000);
pc = P(mk({ roas: 250, roasTarget: 400, spend: 100000 }));              // 소진율 29%
assert.equal(pc.length, 0); assert.ok(pc.skipped[0].reason.includes('효과 없음'));
// 확대: 예산 소진 → 증액 / 예산 남음 → 목표 하향(하한 손익분기×1.15=390)
pc = P(mk({ roas: 600, flags: ['SCALE_UP'], spend: 340000 }));
assert.equal(pc[0].field, 'budget'); assert.equal(pc[0].to, 60000);
pc = P(mk({ roas: 600, flags: ['SCALE_UP'], roasTarget: 500, spend: 100000 }));
assert.equal(pc[0].field, 'roasTarget'); assert.equal(pc[0].to, 400);
pc = P(mk({ roas: 600, flags: ['SCALE_UP'], roasTarget: 400, spend: 100000 }));
assert.equal(pc[0].to, 390);
// 노출 0: 목표가 손익분기보다 높으면 하향, 상품 문제면 안내만
pc = P(mk({ flags: ['NO_IMP'], roasTarget: 600, spend: 0, orders: 0 }));
assert.equal(pc[0].to, 480);
pc = P(mk({ flags: ['NO_IMP'], roasTarget: 600, spend: 0, orders: 0, detail: { servingHints: ['VENDOR_ITEM_SOLD_OUT'] } }));
assert.equal(pc.length, 0); assert.ok(pc.skipped[0].reason.includes('품절'));
// 데이터 부족·최근 변경·최적화 기간
pc = P(mk({ roas: 250, orders: 3 }));
assert.equal(pc.length, 0); assert.ok(pc.skipped[0].reason.includes('데이터 부족'));
const now = Date.parse('2026-11-18T00:00:00Z');
pc = P(mk({ roas: 250 }), { now, recent: recentChangeIndex([{ ok: true, campaignId: 1, at: '2026-11-15T00:00:00Z' }]) });
assert.equal(pc.length, 0); assert.ok(pc.skipped[0].reason.includes('3일 전'));
pc = P(mk({ roas: 250 }), { now, cooldownDays: 2, recent: recentChangeIndex([{ ok: true, campaignId: 1, at: '2026-11-15T00:00:00Z' }]) });
assert.equal(pc.length, 1);
pc = P(mk({ roas: 250, startDate: '2026-11-10' }), { now });
assert.equal(pc.length, 0); assert.ok(pc.skipped[0].reason.includes('최적화 기간'));
pc = P(mk({ roas: 250, startDate: '2026-10-01' }), { now });
assert.equal(pc.length, 1);
assert.deepEqual(recentChangeIndex([{ ok: false, campaignId: 1, at: '2026-11-15' }, { ok: true, demo: true, campaignId: 1, at: '2026-11-16' }]), {});
pc = P(mk({ roas: 250 }), { roasStep: 10 });
assert.equal(pc[0].to, 330);                                            // 300 × 1.1
assert.equal(budgetUse({ budget: 10000, spend: 35000 }, 7), 50);
for (const c of plan) assert.equal(validateChange(c), '', `${c.key} ${validateChange(c)}`);
assert.equal(validateChange({ field: 'budget', to: 5000 }), '일예산은 10,000원 ~ 10,000,000원');
assert.equal(validateChange({ field: 'roasTarget', to: 300, groupId: '' }), '광고그룹ID 없음');
assert.equal(validateChange({ field: 'isActive', to: 'MAYBE' }), 'ON 또는 OFF');
assert.ok(changeWarning({ field: 'budget', from: 100000, to: 200000 }).includes('100%'));

// 키워드 보고서
const kr = parseKeywordReport(demoKeywordReport());
assert.ok(!kr.error);
assert.equal(kr.columns.orders, '총 주문수(14일)');
const kwRows = analyzeKeywords(kr.rows, D.rows, { marginRate: 30 });
const k = (w) => kwRows.find((r) => r.keyword === w);
assert.equal(k('무료 낚시').spend, 35000);                      // 날짜별 행 합산
assert.equal(k('무료 낚시').flag, 'WASTE');
assert.equal(k('중고').alreadyExcluded, true);                 // 이미 제외된 키워드
assert.equal(k('낚시찌').flag, 'LOSS');                         // ROAS 316% < 손익분기 333%
assert.ok(!kwRows.some((r) => r.keyword === '-'));             // 키워드 없는 지면 제외
const neg = negKeywordChanges(kwRows, D.rows);
console.log('제외 키워드 추가안', neg.map((c) => `${c.campaignName}: ${c.to}`));
assert.equal(neg.find((c) => c.campaignName === 'AI 스마트').to, '무료 낚시');   // 중고는 이미 제외
assert.equal(neg.find((c) => c.campaignName === '데모_적자캠페인').to, '집어등');
assert.ok(keywordsCSV(kwRows).includes('낭비(전환 없음)'));
assert.ok(parseKeywordReport([['a', 'b'], ['1', '2']]).error);
assert.equal(adEditUrl(1, 2, true), 'https://advertising.coupang.com/marketing/campaign/1/ad-group/2?goalType=SALES&adSelectionType=AUTO_SELECTION');
// CSV 따옴표·줄바꿈
assert.deepEqual(parseCSV('a,"b,c","d""e"\r\n"x\ny",z'), [['a', 'b,c', 'd"e'], ['x\ny', 'z']]);
console.log('v0.5.0 광고 테스트 통과');

// 캠페인별 마진율
{
  const { normalizeAds, demoAds, analyzeCampaigns, proposeChanges, analyzeKeywords } = await import('../lib/adcore.js');
  let R = analyzeCampaigns(normalizeAds(demoAds(7)).rows, { marginRate: 30, margins: { 900002: 80 } });   // 적자캠페인 마진 80% → 손익분기 125
  const red = R.find((r) => r.id === '900002');
  assert.equal(red.breakEven, 125); assert.ok(red.ownMargin);
  assert.ok(!red.flags.includes('LOSS'));                    // ROAS 150 ≥ 125
  assert.equal(R.find((r) => r.id === '900000').breakEven, 333);
  const pc = proposeChanges(R, { marginRate: 30, margins: { 900002: 80 }, days: 7 });
  assert.ok(!pc.some((c) => c.campaignId === '900002'));
  R = analyzeCampaigns(normalizeAds(demoAds(7)).rows, { marginRate: 30, margins: { 900002: 'x' } });       // 잘못된 값 → 전체 마진율
  assert.equal(R.find((r) => r.id === '900002').breakEven, 333);
  console.log('캠페인별 마진율 테스트 통과');
}

// 변경 효과
{
  const { evaluateEffects } = await import('../lib/adcore.js');
  const D = Date.parse('2026-11-01T05:00:00Z');                      // 적용 시각
  const log = [
    { at: new Date(D).toISOString(), ok: true, campaignId: '1', field: 'roasTarget', before: { days: 7, spend: 700000, sales: 1400000, orders: 70 } },   // 하루 광고비 10만, 매출 20만
    { at: new Date(D).toISOString(), ok: true, campaignId: '2', field: 'budget', before: { days: 7, spend: 70000, sales: 700000, orders: 30 } },
    { at: new Date(D).toISOString(), ok: false, campaignId: '3', field: 'budget' },
  ];
  const snapAfter = { at: '2026-11-09T03:00:00Z', start: Date.parse('2026-11-01T15:00:00Z'), days: 7, rows: [
    { id: '1', spend: 420000, sales: 1260000, orders: 60 },          // 하루 광고비 6만, 매출 18만 → 이익(마진 30%) -4만 → -0.6만 개선
    { id: '2', spend: 140000, sales: 700000, orders: 30 } ] };        // 광고비 2배, 매출 같음 → 악화
  const snapBefore = { at: '2026-10-31T03:00:00Z', start: Date.parse('2026-10-24T15:00:00Z'), days: 7, rows: [] };
  let E = evaluateEffects(log, [snapBefore, snapAfter], { marginRate: 30, now: Date.parse('2026-11-09T05:00:00Z') });
  assert.equal(E.length, 2);                                          // 실패한 적용 제외
  assert.equal(E[0].status, 'BETTER'); assert.equal(E[0].beforeM.profit, -40000); assert.equal(E[0].afterM.profit, -6000);
  assert.equal(E[1].status, 'WORSE');
  E = evaluateEffects(log, [snapBefore, snapAfter], { marginRate: 30, now: Date.parse('2026-11-05T05:00:00Z') });
  assert.equal(E[0].status, 'WAIT');
  E = evaluateEffects(log, [snapBefore], { marginRate: 30, now: Date.parse('2026-11-09T05:00:00Z') });
  assert.equal(E[0].status, 'NEED_SCAN');
  assert.equal(evaluateEffects([{ at: '2026-11-01', ok: true, campaignId: '9', field: 'budget' }], [], {})[0].status, 'NO_BASE');
  console.log('변경 효과 테스트 통과');
}

// 광고 중인 문제 상품
{
  const { adProductIssues } = await import('../lib/adcore.js');
  const prows = [{ vendorItemId: '11', issues: ['SUPPRESSED'], productName: 'A' }, { vendorItemId: '12', issues: [], productName: 'B' }, { vendorItemId: '13', issues: ['OUT_OF_STOCK', 'NO_BRAND'], productName: 'C' }];
  const snap = { products: [
    { vendorItemId: '11', campaignId: '1', campaignName: 'AI', spend: 5000, sales: 0, orders: 0 },
    { vendorItemId: '11', campaignId: '2', campaignName: '수동', spend: 3000, sales: 10000, orders: 1 },
    { vendorItemId: '12', campaignId: '1', campaignName: 'AI', spend: 9000 },
    { vendorItemId: '13', campaignId: '1', campaignName: 'AI', spend: 0 } ] };
  const L = adProductIssues(snap, prows);
  assert.equal(L.length, 1); assert.equal(L[0].spend, 8000); assert.equal(L[0].campaigns.length, 2); assert.deepEqual(L[0].issues, ['SUPPRESSED']);
  assert.deepEqual(adProductIssues({}, prows), []);
  console.log('광고 중 문제 상품 테스트 통과');
}

// 제외 키워드 현황 + 추천
{
  const { negKeywordAdvice } = await import('../lib/adcore.js');
  const camp = { id: '1', name: 'AI', detail: { negativeKeywords: ['무료', '낚시 용품', '중고'] } };
  const kwRows = [
    { campaignId: '1', keyword: '렌탈', flag: 'WASTE', spend: 5000, clicks: 12 },
    { campaignId: '1', keyword: '중고', flag: 'WASTE', spend: 9000 },                    // 이미 제외
    { campaignId: '1', keyword: '대여', flag: 'WASTE', spend: 8000, clicks: 3 },
    { campaignId: '1', keyword: '찌', flag: 'LOSS', spend: 20000, roas: 150, orders: 2 },
    { campaignId: '2', keyword: '다른캠페인', flag: 'WASTE', spend: 99999 },
  ];
  const a = negKeywordAdvice(camp, { kwRows, trendKeywords: [{ keyword: '낚시용품', categoryName: '낚시 소품', categoryRank: 1 }, '전자찌'] });
  assert.deepEqual(a.current.map((x) => x.popular), [false, true, false]);
  assert.deepEqual(a.add.map((x) => x.keyword), ['대여', '렌탈']);       // 광고비 큰 순, 이미 제외·다른 캠페인 제외
  assert.deepEqual(a.watch.map((x) => x.keyword), ['찌']);
  assert.equal(a.release.length, 1); assert.equal(a.release[0].category, '낚시 소품');
  assert.ok(a.hasReport && a.hasTrends);
  const b = negKeywordAdvice({ id: '3', name: 'X' }, {});
  assert.equal(b.current.length, 0); assert.ok(!b.hasReport && !b.hasTrends);
  console.log('제외 키워드 추천 테스트 통과');
}

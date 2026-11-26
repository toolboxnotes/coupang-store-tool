// 광고 분석 순수 로직 (B2 분석 / B3 수정 제안). chrome.* 호출 없음 → Node에서 테스트 가능.
// 광고센터 데이터는 외부 공개·제3자 제공 금지 → 이 PC의 Chrome에만 저장

// 문제·기회 유형 (level: 3=심각, 2=주의, 1=참고, 0=기회)
export const AD_FLAGS = {
  LOSS:         { level: 3, label: '손익분기 미달', tip: '목표 ROAS를 손익분기 ROAS 이상으로 올리거나, 성과 나쁜 상품을 광고에서 제외하세요.' },
  NO_CONV:      { level: 3, label: '전환 없는 광고비', tip: '광고비만 쓰고 주문이 없습니다. 광고 중지 또는 상품 상세페이지·가격·리뷰를 점검하세요.' },
  BELOW_TARGET: { level: 2, label: '목표 ROAS 미달', tip: '자동 운영 학습 중인지 확인하고, 계속 미달이면 목표 ROAS 재설정 또는 상품 구성을 바꾸세요.' },
  NO_IMP:       { level: 2, label: '노출 없음', tip: '켜져 있지만 노출이 없습니다. 예산·입찰 경쟁력·광고 상품 상태(품절·노출제한)를 확인하세요.' },
  LOW_CTR:      { level: 1, label: '클릭률 낮음', tip: '대표 이미지·상품명·가격 경쟁력을 점검하세요.' },
  LOW_CVR:      { level: 1, label: '전환율 낮음', tip: '상세페이지·리뷰·가격·배송 조건을 점검하세요.' },
  SCALE_UP:     { level: 0, label: '확대 후보', tip: '성과가 좋습니다. 일 예산 증액 또는 상품 추가를 검토하세요.' },
};

// 기본 기준값 (설정에서 마진율만 바꿀 수 있음)
export const AD_DEFAULTS = { marginRate: 30, minSpend: 10000, lowCtr: 0.2, lowCvr: 1.0, minImpForCtr: 10000, minClicksForCvr: 200, scaleUpFactor: 1.3 };

// 손익분기 ROAS(%) = 100 / 마진율 × 100  (예: 마진 30% → 333%)
export const breakEvenRoas = (marginRate) => (marginRate > 0 ? Math.round(10000 / marginRate) : 0);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ratio = (a, b) => (b > 0 ? a / b : 0);

// AI 스마트 광고 여부: 자동 상품 선택(AUTO_PRODUCT_SELECTION / AUTO_SELECTION) 또는 이름
export function isAiSmartCampaign(c, d) {
  const ctx = [].concat(c.creationContext || []).map(String);
  return ctx.includes('AUTO_PRODUCT_SELECTION') || (d && d.adSelectionType === 'AUTO_SELECTION') || /AI\s*스마트/.test(c.name || '');
}

// 수집 결과 → 캠페인 행
export function normalizeAds(raw) {
  const rows = (raw.campaigns || []).map((c) => {
    const m = (raw.metrics || {})[String(c.id)] || {};
    const spend = num(m.deliveredAdCost);
    const sales = num(m.adAttributedSales);
    const impressions = num(m.impressions);
    const clicks = num(m.clicks);
    const orders = num(m.adAttributedOrders);
    return {
      id: String(c.id), name: c.name || String(c.id),
      isActive: !!c.isActive, suspended: !!c.isSuspended || !!c.disabledByCoupang,
      roasTarget: num(c.roasTarget) || null, budget: num(c.budget) || null, capType: c.capType || '', objective: c.objective || '',
      startDate: c.startDate || '', adCount: num(c.totalAdCount),
      spend, sales, impressions, clicks, orders, units: num(m.adAttributedUnits), todaySpend: num(m.todayAdSpend),
      groupId: String(c.groupId || (raw.details && raw.details[c.id] && raw.details[c.id].groupId) || ''),
      isAiSmart: isAiSmartCampaign(c, raw.details && raw.details[c.id]),
      detail: (raw.details && raw.details[c.id]) || null,   // 제외 키워드·제외 상품·노출 상태 (켜진 캠페인만)
      roas: Math.round(ratio(sales, spend) * 100),           // %
      ctr: +(ratio(clicks, impressions) * 100).toFixed(2),    // %
      cvr: +(ratio(orders, clicks) * 100).toFixed(2),         // %
      cpc: Math.round(ratio(spend, clicks)),
    };
  });
  // 일별 합계 (키 = 날짜 0시 ms)
  const daily = Object.entries(raw.daily || {})
    .map(([k, v]) => {
      const spend = num(v.DELIVERED_AD_COST), sales = num(v.AD_ATTRIBUTED_SALES);
      return { date: Number(k), spend, sales, orders: num(v.AD_ATTRIBUTED_ORDERS), impressions: num(v.IMPRESSIONS), clicks: num(v.CLICKS), roas: Math.round(ratio(sales, spend) * 100) };
    })
    .sort((a, b) => a.date - b.date);
  return { rows, daily };
}

// 캠페인별 마진율: opts.margins[캠페인ID]가 있으면 그 값, 없으면 전체 마진율
export const marginFor = (r, o) => {
  const m = Number(o.margins && o.margins[r.id]);
  return m > 0 && m < 100 ? m : o.marginRate;
};

// 캠페인별 문제·기회 판정 (r.marginRate, r.breakEven, r.ownMargin 도 채움)
export function analyzeCampaigns(rows, opts = {}) {
  const o = { ...AD_DEFAULTS, ...opts };
  for (const r of rows) {
    r.marginRate = marginFor(r, o);
    r.ownMargin = r.marginRate !== o.marginRate || !!(o.margins && o.margins[r.id]);
    const be = breakEvenRoas(r.marginRate);
    r.breakEven = be;
    const f = [];
    const spent = r.spend >= o.minSpend;
    if (spent && r.orders === 0) f.push('NO_CONV');
    else if (spent && be && r.roas < be) f.push('LOSS');
    if (spent && r.roasTarget && r.orders > 0 && r.roas < r.roasTarget * 0.8) f.push('BELOW_TARGET');
    if (r.isActive && !r.suspended && r.impressions === 0) f.push('NO_IMP');
    if (r.impressions >= o.minImpForCtr && r.ctr < o.lowCtr) f.push('LOW_CTR');
    if (r.clicks >= o.minClicksForCvr && r.cvr < o.lowCvr) f.push('LOW_CVR');
    const bar = Math.max(be, r.roasTarget || 0) * o.scaleUpFactor;
    if (spent && r.isActive && r.orders > 0 && r.roas >= bar) f.push('SCALE_UP');
    r.flags = f.sort((a, b) => AD_FLAGS[b].level - AD_FLAGS[a].level);
    r.level = f.length ? AD_FLAGS[r.flags[0]].level : -1;
  }
  return rows;
}

// 기간 합계
export function summarizeAds(rows, opts = {}) {
  const o = { ...AD_DEFAULTS, ...opts };
  const t = rows.reduce((a, r) => {
    a.spend += r.spend; a.sales += r.sales; a.orders += r.orders; a.impressions += r.impressions; a.clicks += r.clicks;
    return a;
  }, { spend: 0, sales: 0, orders: 0, impressions: 0, clicks: 0 });
  const counts = {};
  for (const k of Object.keys(AD_FLAGS)) counts[k] = 0;
  for (const r of rows) for (const f of r.flags || []) counts[f]++;
  // 손익분기 미달·전환 없음 캠페인의 광고비 합계 = 개선 여지
  const wasted = rows.filter((r) => (r.flags || []).some((f) => f === 'NO_CONV' || f === 'LOSS')).reduce((a, r) => a + r.spend, 0);
  return {
    ...t,
    roas: Math.round(ratio(t.sales, t.spend) * 100),
    ctr: +(ratio(t.clicks, t.impressions) * 100).toFixed(2),
    cvr: +(ratio(t.orders, t.clicks) * 100).toFixed(2),
    breakEven: breakEvenRoas(o.marginRate),
    active: rows.filter((r) => r.isActive).length,
    campaigns: rows.length,
    wasted, counts,
  };
}

// 광고센터 캠페인 상세 화면
export const adCampaignUrl = (id) => (/^\d+$/.test(String(id || '')) ? `https://advertising.coupang.com/marketing/dashboard/sales/campaign/${id}` : '');

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// 캠페인 분석 CSV (엑셀용 BOM 포함)
export function adsCSV(rows) {
  const head = ['캠페인ID', '캠페인명', 'ON/OFF', '목표 ROAS(%)', '일 예산', '광고비', '광고 전환 매출', 'ROAS(%)', '노출수', '클릭수', '클릭률(%)', '전환 주문수', '전환율(%)', 'CPC', '진단', '제안'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.name, r.isActive ? 'ON' : 'OFF', r.roasTarget ?? '', r.budget ?? '', r.spend, r.sales, r.roas, r.impressions, r.clicks, r.ctr, r.orders, r.cvr, r.cpc,
      (r.flags || []).map((f) => AD_FLAGS[f].label).join(' / '), (r.flags || []).map((f) => AD_FLAGS[f].tip).join(' | '),
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// 데모 데이터 (실제 응답 구조 모방)
export function demoAds(days = 7) {
  const DAY = 86400000, KST = 9 * 3600000;
  const end = Math.floor((Date.now() + KST) / DAY) * DAY - KST - DAY;
  const start = end - (days - 1) * DAY;
  const spec = [
    ['AI 스마트', true, 400, 300000, 1700000, 3500000, 2800000, 12000, 340, ['AUTO_PRODUCT_SELECTION']],
    ['데모_효자상품', true, 300, 100000, 600000, 3000000, 250000, 3000, 160],
    ['데모_적자캠페인', true, 300, 50000, 300000, 450000, 200000, 900, 30],
    ['데모_전환없음', true, 300, 30000, 80000, 0, 60000, 400, 0],
    ['데모_목표미달', true, 500, 50000, 200000, 700000, 150000, 600, 45],
    ['데모_노출없음', true, 300, 30000, 0, 0, 0, 0, 0],
    ['데모_클릭률낮음', true, 300, 50000, 150000, 520000, 300000, 450, 4],
    ['데모_꺼진캠페인', false, 300, 30000, 0, 0, 0, 0, 0],
  ];
  const campaigns = [], metrics = {}, details = {};
  spec.forEach(([name, on, target, budget, spend, sales, imp, clicks, orders, ctx], i) => {
    const id = 900000 + i, groupId = 800000 + i;
    campaigns.push({ id, name, isActive: on, roasTarget: target, budget, objective: 'PRODUCT_TARGET_ROAS', totalAdCount: 3, groupId, creationContext: ctx || null });
    metrics[id] = { deliveredAdCost: spend, adAttributedSales: sales, impressions: imp, clicks, adAttributedOrders: orders, adAttributedUnits: orders };
    if (on) details[id] = {
      groupId, roasTarget: target, adSelectionType: ctx ? 'AUTO_SELECTION' : 'MANUAL_SELECTION', targetKeywordType: 'automatic',
      negativeKeywords: i === 0 ? ['무료', '중고', '렌탈'] : [], otherKeywords: [], excludedProducts: i === 0 ? 12 : 0,
      servingStatus: i === 0 ? 'DELIVERABLE_PARTIAL_ADS_ERROR' : 'DELIVERABLE', servingHints: i === 0 ? ['AD_BUNDLE_AUDIT_FAILED'] : [],
    };
  });
  const daily = {};
  for (let d = 0; d < days; d++) daily[start + d * DAY] = { DELIVERED_AD_COST: 430000 + d * 5000, AD_ATTRIBUTED_SALES: 1100000 - d * 20000, AD_ATTRIBUTED_ORDERS: 80, IMPRESSIONS: 560000, CLICKS: 2500 };
  return { demo: true, start, end, days, campaigns, metrics, daily, details, errors: [], finishedAt: new Date().toISOString() };
}

// 데모 키워드 보고서 (광고센터 보고서 형식 모방)
export function demoKeywordReport() {
  return [
    ['날짜', '캠페인 ID', '캠페인명', '광고그룹', '키워드', '노출수', '클릭수', '광고비', '총 주문수(14일)', '총 전환매출액(14일)'],
    ['20261110', '900000', 'AI 스마트', '새 광고 그룹', '낚시찌', '52000', '410', '98000', '22', '310000'],
    ['20261110', '900000', 'AI 스마트', '새 광고 그룹', '무료 낚시', '8000', '95', '21000', '0', '0'],
    ['20261111', '900000', 'AI 스마트', '새 광고 그룹', '무료 낚시', '6000', '60', '14000', '0', '0'],
    ['20261110', '900000', 'AI 스마트', '새 광고 그룹', '중고', '5000', '40', '9000', '0', '0'],
    ['20261110', '900000', 'AI 스마트', '새 광고 그룹', '바다낚시 세트', '30000', '220', '61000', '5', '120000'],
    ['20261110', '900000', 'AI 스마트', '새 광고 그룹', '-', '90000', '300', '40000', '6', '90000'],
    ['20261110', '900002', '데모_적자캠페인', '새 광고 그룹', '집어등', '20000', '150', '33000', '0', '0'],
    ['20261110', '900002', '데모_적자캠페인', '새 광고 그룹', '문어 집어등', '18000', '160', '30000', '6', '160000'],
  ];
}

// ══════════════════════════════════════════════════════════════
// AI 스마트 광고 비교
// ══════════════════════════════════════════════════════════════
const agg = (rows) => {
  const t = rows.reduce((a, r) => { a.spend += r.spend; a.sales += r.sales; a.orders += r.orders; a.impressions += r.impressions; a.clicks += r.clicks; return a; },
    { spend: 0, sales: 0, orders: 0, impressions: 0, clicks: 0 });
  return { ...t, n: rows.length, roas: Math.round(ratio(t.sales, t.spend) * 100), ctr: +(ratio(t.clicks, t.impressions) * 100).toFixed(2), cvr: +(ratio(t.orders, t.clicks) * 100).toFixed(2), cpc: Math.round(ratio(t.spend, t.clicks)) };
};

// AI 스마트 vs 나머지(광고비가 있는) 캠페인 비교 + 해설 문장
export function aiSmartComparison(rows, opts = {}) {
  const be = breakEvenRoas({ ...AD_DEFAULTS, ...opts }.marginRate);
  const ai = rows.filter((r) => r.isAiSmart);
  if (!ai.length) return null;
  const others = rows.filter((r) => !r.isAiSmart && r.spend > 0);
  const A = agg(ai), O = agg(others), total = A.spend + O.spend;
  const share = Math.round(ratio(A.spend, total) * 100);
  const a0 = ai[0];
  const notes = [];
  notes.push(`AI 스마트가 전체 광고비의 ${share}%를 사용합니다.`);
  if (O.spend > 0) {
    if (A.roas < O.roas) notes.push(`ROAS는 AI 스마트 ${A.roas}% / 나머지 캠페인 ${O.roas}% 로 AI 스마트가 낮습니다 → AI 스마트 일예산 일부를 성과 좋은 캠페인으로 옮기는 것을 검토하세요.`);
    else notes.push(`ROAS는 AI 스마트 ${A.roas}% / 나머지 캠페인 ${O.roas}% 로 AI 스마트가 더 높습니다 → AI 스마트 예산 유지·증액을 검토하세요.`);
    if (A.cpc > O.cpc * 1.2) notes.push(`AI 스마트 클릭당 비용(${A.cpc}원)이 나머지(${O.cpc}원)보다 높습니다 → 광고비가 많이 드는 키워드를 보고서로 확인해 제외 키워드로 추가하세요.`);
    if (A.cvr < O.cvr * 0.8) notes.push(`AI 스마트 전환율(${A.cvr}%)이 나머지(${O.cvr}%)보다 낮습니다 → 전환이 낮은 상품을 「특정 상품 제외」로 빼는 것을 검토하세요.`);
  }
  if (be && A.roas < be) notes.push(`AI 스마트 ROAS ${A.roas}%가 손익분기 ${be}%보다 낮습니다 → 목표 ROAS를 ${be}% 이상으로 올리거나 일예산을 줄이세요.`);
  if (a0.roasTarget && A.roas < a0.roasTarget * 0.8) notes.push(`목표 ROAS(${a0.roasTarget}%)와 실제(${A.roas}%) 차이가 큽니다. 목표를 너무 높게 잡으면 노출이 줄 수 있으니 손익분기와 실제 성과 사이에서 조정하세요.`);
  const d = a0.detail;
  if (d) {
    notes.push(`제외 키워드 ${d.negativeKeywords.length}/500개, 제외 상품 ${d.excludedProducts}개가 설정되어 있습니다.`);
    if (d.negativeKeywords.length >= 450) notes.push('제외 키워드가 한도(500개)에 가깝습니다 → 효과 없는 제외 키워드를 정리하세요.');
    if (d.servingHints && d.servingHints.length) notes.push(`노출 상태 알림: ${d.servingHints.map((h) => SERVING_HINTS[h] || h).join(', ')}`);
  }
  return { ai: A, others: O, share, notes, campaign: a0 };
}

// 광고 노출 상태 힌트 코드 → 한국어
export const SERVING_HINTS = {
  AD_BUNDLE_AUDIT_FAILED: '일부 광고 검수 실패(광고 중지됨)',
  AD_IMAGE_AUDIT_FAILED: '광고 이미지 검수 실패',
  NO_REMAINING_BUDGET: '예산 소진',
  VENDOR_ITEM_SOLD_OUT: '품절 상품 있음',
  VENDOR_ITEM_NOT_BUYBOX_WINNER: '아이템위너 아닌 상품 있음',
  VENDOR_ITEM_BAD_UNIT_PRICE: '단위가격 문제 상품 있음',
  ITEM_OUT_OF_STOCK: '품절 상품 있음',
  ITEM_NOT_WINNER: '아이템위너 아닌 상품 있음',
};

// ══════════════════════════════════════════════════════════════
// 수정 사항(변경안) 만들기 — 자동 적용 대상: 일예산·목표 ROAS·ON/OFF / 제외 키워드는 복사 후 직접 입력
// ══════════════════════════════════════════════════════════════
export const CHANGE_FIELDS = {
  budget:     { label: '일예산', unit: '원', auto: true },
  roasTarget: { label: '목표ROAS', unit: '%', auto: true },
  isActive:   { label: 'ON/OFF', unit: '', auto: true },
  negKeywords: { label: '제외키워드추가', unit: '', auto: false },
};
const round = (v, step) => Math.round(v / step) * step;
const ceil = (v, step) => Math.ceil(v / step) * step;

// 진단 결과로 변경안 생성 (선택은 사용자가)
// 변경안 기준 (설정에서 바꿀 수 있음)
//  roasStep     목표 ROAS 1회 조정 폭(%)       — 목표 ROAS와 노출은 반비례, 한 번에 크게 바꾸면 노출이 급변
//  budgetStep   일예산 1회 조정 폭(%)
//  minOrders    판단에 필요한 최소 전환 주문 수 (적으면 데이터 부족 → 변경 안 함)
//  cooldownDays 변경 후 대기일 (쿠팡 자동 운영의 최적화 기간 7~14일)
//  learnDays    새 캠페인 최적화(학습) 기간 — 이 기간에는 설정을 바꾸지 않음
export const PLAN_RULE_DEFAULTS = { roasStep: 20, budgetStep: 20, minOrders: 5, cooldownDays: 7, learnDays: 14 };

// 최근 적용 기록 → { 캠페인ID: 마지막 적용 시각(ms) } (성공한 실제 적용만)
export function recentChangeIndex(applyLog = []) {
  const idx = {};
  for (const l of applyLog) {
    if (!l.ok || l.demo || !l.campaignId) continue;
    const t = Date.parse(l.at);
    if (!idx[l.campaignId] || t > idx[l.campaignId]) idx[l.campaignId] = t;
  }
  return idx;
}

// 예산 소진율 = 기간 광고비 ÷ (일예산 × 기간 일수). 일예산을 다 쓰고 있으면(≥90%) 예산이 노출을 막는 상태
export function budgetUse(r, days) {
  if (!r.budget || !days) return null;
  return Math.round((r.spend / (r.budget * days)) * 100);
}
const PRODUCT_HINTS = ['VENDOR_ITEM_SOLD_OUT', 'VENDOR_ITEM_NOT_BUYBOX_WINNER', 'ITEM_OUT_OF_STOCK', 'ITEM_NOT_WINNER', 'AD_BUNDLE_AUDIT_FAILED', 'AD_IMAGE_AUDIT_FAILED', 'VENDOR_ITEM_BAD_UNIT_PRICE'];
const parseDay = (v) => { if (!v) return NaN; const n = Number(v); return Number.isFinite(n) && n > 1e11 ? n : Date.parse(String(v).slice(0, 10)); };

// 진단 결과 → 변경안 (캠페인당 1개만, 일예산·목표 ROAS를 동시에 바꾸지 않음)
// 원칙 (쿠팡 광고 운영 가이드·실무 자료 정리)
//  - 목표 ROAS ↔ 노출은 반비례: 효율(ROAS)은 목표 ROAS로, 물량(노출·매출)은 일예산·목표 ROAS로 조절
//  - 일예산은 다 쓰고 있을 때만(소진율 90%↑) 의미 있음. 예산이 남는 캠페인은 예산을 바꿔도 변화 없음
//  - 최적화 기간(새 캠페인 14일, 변경 후 7일)에는 바꾸지 않음, 한 번에 조금씩
//  - 효율이 나쁜 원인은 설정보다 상품(아이템위너·품절·가격·리뷰·상세페이지)과 검색어인 경우가 많음 → 안내
//
// 판단 순서
//  0) 제외: 꺼진 캠페인 / 최적화 기간 / 최근 변경 / 광고비 적음 / 전환 주문 부족
//  1) 전환 0 + 광고비 3만원↑ → OFF
//  2) ROAS 100% 미만(광고 매출 < 광고비) → OFF 후보
//  3) 손익분기 미달
//     - 목표 ROAS < 손익분기 → 목표 ROAS 한 단계 상향 = max(현재 목표, 실제 ROAS) × (1+roasStep), 손익분기 상한
//     - 목표가 이미 손익분기 이상 → 일예산 축소 (예산을 다 쓰는 경우) 또는 상품·검색어 점검 안내
//  4) 손익분기 × 1.3 이상 (확대 여지)
//     - 예산 소진율 90%↑ → 일예산 증액
//     - 예산 소진율 70% 미만 → 목표 ROAS 한 단계 하향 (노출 확대), 손익분기 × 1.15 하한
//  5) 켜져 있는데 노출 0 + 상품 문제 없음 → 목표 ROAS 한 단계 하향
export function proposeChanges(rows, opts = {}) {
  const o = { ...AD_DEFAULTS, ...PLAN_RULE_DEFAULTS, ...opts };
  const beAll = breakEvenRoas(o.marginRate);
  const recent = o.recent || {};
  const now = o.now || Date.now();
  const days = o.days || 7;
  const out = [];
  out.skipped = [];
  const add = (r, field, from, to, reason) => out.push({ key: `${r.id}|${field}`, campaignId: r.id, campaignName: r.name, groupId: r.groupId, field, from, to, reason, source: 'auto' });
  const skip = (r, why) => out.skipped.push({ campaignId: r.id, campaignName: r.name, reason: why });
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  for (const r of rows) {
    if (!r.isActive) continue;
    const f = r.flags || [];
    const be = r.breakEven || breakEvenRoas(marginFor(r, o)) || beAll;  // 캠페인별 마진율 반영
    const use = budgetUse(r, days);
    const useTxt = use == null ? '' : ` · 예산 소진율 ${use}%`;
    const hints = ((r.detail && r.detail.servingHints) || []).filter((h) => PRODUCT_HINTS.includes(h));
    const hintTxt = hints.length ? ` ※ 상품 문제(${hints.map((h) => SERVING_HINTS[h] || h).join(', ')})를 먼저 해결하세요.` : '';
    const relevant = f.some((x) => ['NO_CONV', 'LOSS', 'SCALE_UP', 'NO_IMP'].includes(x)) || (r.orders > 0 && r.roas < 100);
    if (!relevant) continue;

    const started = parseDay(r.startDate);
    if (Number.isFinite(started) && now - started < o.learnDays * 86400000) {
      skip(r, `시작 ${Math.max(0, Math.floor((now - started) / 86400000))}일째 → 최적화 기간(${o.learnDays}일)에는 설정을 바꾸지 않는 것이 좋음`); continue;
    }
    const last = recent[r.id];
    if (last && now - last < o.cooldownDays * 86400000) {
      skip(r, `${Math.floor((now - last) / 86400000)}일 전에 변경함 → ${o.cooldownDays}일 동안 결과를 지켜본 뒤 다시 판단`); continue;
    }

    // 5) 노출 없음
    if (f.includes('NO_IMP')) {
      if (hints.length) skip(r, `노출 0 — 설정보다 상품 문제가 원인으로 보임.${hintTxt}`);
      else if (r.groupId && r.roasTarget && r.roasTarget > ceil(be, 10)) {
        const to = Math.max(ceil(be, 10), round(r.roasTarget * (1 - o.roasStep / 100), 10));
        add(r, 'roasTarget', r.roasTarget, to, `켜져 있는데 노출 0 → 목표 ROAS가 높아 노출 기회를 잃고 있을 수 있음. 목표 ROAS 한 단계 하향 (하한 손익분기 ${ceil(be, 10)}%)`);
      } else skip(r, `노출 0 — 목표 ROAS(${r.roasTarget || '-'}%)는 이미 손익분기 이하. 상품 상태(아이템위너·재고·검수)·가격을 확인하세요`);
      continue;
    }
    if (r.spend < o.minSpend) continue;

    // 1) 전환 없음
    if (f.includes('NO_CONV')) {
      if (r.spend >= o.minSpend * 3) add(r, 'isActive', 'ON', 'OFF', `기간 광고비 ${won(r.spend)}, 전환 주문 0건.${hintTxt}`);
      else skip(r, `전환 0건이지만 광고비 ${won(r.spend)}으로 아직 판단하기 이릅니다`);
      continue;
    }
    if (r.orders < o.minOrders) { skip(r, `전환 주문 ${r.orders}건 (${o.minOrders}건 미만) → 데이터 부족, 기간을 늘려(14·30일) 다시 점검`); continue; }

    // 2) 광고 매출 < 광고비
    if (r.roas < 100) {
      add(r, 'isActive', 'ON', 'OFF', `ROAS ${r.roas}% — 광고 매출(${won(r.sales)})이 광고비(${won(r.spend)})보다 적음. 끄거나, 검색어 보고서로 제외 키워드·제외 상품을 정리한 뒤 다시 켜세요.${hintTxt}`);
      continue;
    }

    // 3) 손익분기 미달
    if (f.includes('LOSS')) {
      const pct = be ? Math.round((r.roas / be) * 100) : 0;
      if (r.groupId && r.roasTarget && r.roasTarget < be) {
        const to = Math.min(ceil(be, 10), ceil(Math.max(r.roasTarget, r.roas) * (1 + o.roasStep / 100), 10));
        if (to > r.roasTarget) {
          add(r, 'roasTarget', r.roasTarget, to, `ROAS ${r.roas}% (손익분기 ${be}%의 ${pct}%)${useTxt} → 목표 ROAS 한 단계 상향 (노출은 줄고 효율은 올라감). ${o.cooldownDays}일 뒤 다시 점검${pct < 50 ? '. 차이가 커서 목표 상향만으로는 부족 — 검색어 보고서로 제외 키워드, 마진 낮은 상품 제외를 함께 검토' : ''}.${hintTxt}`);
          continue;
        }
      }
      if (r.budget && use != null && use >= 90) {
        add(r, 'budget', r.budget, Math.max(10000, round(r.budget * (1 - o.budgetStep / 100), 1000)), `ROAS ${r.roas}% < 손익분기 ${be}%, 목표 ROAS는 이미 ${r.roasTarget || '-'}%${useTxt} → 일예산 ${o.budgetStep}% 축소로 손실 규모를 줄임.${hintTxt}`);
      } else {
        skip(r, `ROAS ${r.roas}% < 손익분기 ${be}%, 목표 ROAS ${r.roasTarget || '-'}%${useTxt} — 예산을 다 쓰지 않아 예산 조정은 효과 없음. 검색어 보고서(제외 키워드)·상품(가격·리뷰·상세페이지)을 점검하세요.${hintTxt}`);
      }
      continue;
    }

    // 4) 확대 여지
    if (f.includes('SCALE_UP')) {
      if (r.budget && use != null && use >= 90) {
        add(r, 'budget', r.budget, round(r.budget * (1 + o.budgetStep / 100), 1000), `ROAS ${r.roas}% (손익분기 ${be}%의 1.3배 이상, 전환 ${r.orders}건)${useTxt} → 예산이 노출을 막고 있음. 일예산 ${o.budgetStep}% 증액`);
      } else if (r.groupId && r.roasTarget && use != null && use < 70) {
        const floor = ceil(be * 1.15, 10);
        const to = Math.max(floor, round(r.roasTarget * (1 - o.roasStep / 100), 10));
        if (to < r.roasTarget) add(r, 'roasTarget', r.roasTarget, to, `ROAS ${r.roas}% (손익분기의 1.3배 이상)${useTxt} → 예산이 남음. 목표 ROAS 한 단계 하향으로 노출 확대 (하한 손익분기×1.15 = ${floor}%)`);
        else skip(r, `효율 좋음${useTxt}, 목표 ROAS가 이미 하한(${floor}%) 근처`);
      } else skip(r, `효율 좋음${useTxt} — 현재 설정 유지`);
    }
  }
  return out;
}

// 변경값 검증 (적용 전 반드시 호출)
export function validateChange(c) {
  if (!CHANGE_FIELDS[c.field]) return '알 수 없는 항목';
  if (c.field === 'budget') { const v = Number(c.to); if (!Number.isFinite(v) || v < 10000 || v > 10000000) return '일예산은 10,000원 ~ 10,000,000원'; }
  if (c.field === 'roasTarget') { const v = Number(c.to); if (!Number.isFinite(v) || v < 100 || v > 3000) return '목표 ROAS는 100% ~ 3000%'; if (!c.groupId) return '광고그룹ID 없음'; }
  if (c.field === 'isActive' && !['ON', 'OFF'].includes(String(c.to).toUpperCase())) return 'ON 또는 OFF';
  if (c.field === 'negKeywords' && !String(c.to || '').trim()) return '제외 키워드 없음';
  return '';
}
// 큰 폭 변경 경고 (±50% 초과)
export function changeWarning(c) {
  if ((c.field === 'budget' || c.field === 'roasTarget') && Number(c.from) > 0) {
    const r = Number(c.to) / Number(c.from);
    if (r > 1.5 || r < 0.5) return `기존 값 대비 ${Math.round((r - 1) * 100)}% 변경`;
  }
  return '';
}

// 광고센터 광고그룹 편집 화면 (제외 키워드·제외 상품 입력)
export const adEditUrl = (campaignId, groupId, aiSmart) =>
  /^\d+$/.test(String(campaignId)) && /^\d+$/.test(String(groupId))
    ? `https://advertising.coupang.com/marketing/campaign/${campaignId}/ad-group/${groupId}?goalType=SALES&adSelectionType=${aiSmart ? 'AUTO_SELECTION' : 'MANUAL_SELECTION'}`
    : '';

// CSV 텍스트 → 2차원 배열 (따옴표·줄바꿈 처리)
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const t = String(text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// ══════════════════════════════════════════════════════════════
// 키워드 보고서 (광고센터 「광고 보고서」 엑셀/CSV 업로드) 분석
// ══════════════════════════════════════════════════════════════
// 열 이름은 보고서 버전에 따라 조금씩 달라서 포함 단어로 찾는다
const KW_COLS = {
  campaignId: [/^캠페인\s*ID$/i, /캠페인\s*ID/i],
  campaignName: [/^캠페인명$/, /캠페인\s*이름/, /캠페인명/],
  keyword: [/^키워드$/, /키워드/],
  impressions: [/^노출수$/, /노출수/],
  clicks: [/^클릭수$/, /클릭수/],
  spend: [/^광고비$/, /집행\s*광고비/, /광고비/],
  orders: [/총\s*주문수\s*\(14일\)/, /총\s*주문수/, /전환\s*주문수/, /주문수/],
  sales: [/총\s*전환\s*매출액\s*\(14일\)/, /총\s*전환\s*매출/, /전환\s*매출/, /매출액/],
};
const findCol = (head, pats) => {
  for (const p of pats) { const i = head.findIndex((h) => p.test(String(h).trim())); if (i >= 0) return i; }
  return -1;
};
const toNum = (v) => { const n = Number(String(v ?? '').replace(/[,원%\s]/g, '')); return Number.isFinite(n) ? n : 0; };

// 2차원 배열(엑셀 시트/CSV) → 캠페인·키워드별 합계
export function parseKeywordReport(table) {
  const hi = table.findIndex((r) => findCol(r, KW_COLS.keyword) >= 0 && (findCol(r, KW_COLS.spend) >= 0 || findCol(r, KW_COLS.clicks) >= 0));
  if (hi < 0) return { error: '키워드·광고비 열을 찾지 못했습니다. 광고센터 「광고 보고서」에서 만든 파일인지 확인하세요.', rows: [] };
  const head = table[hi];
  const ix = Object.fromEntries(Object.entries(KW_COLS).map(([k, p]) => [k, findCol(head, p)]));
  const map = new Map();
  for (const r of table.slice(hi + 1)) {
    const kw = String(r[ix.keyword] ?? '').trim();
    if (!kw || kw === '-' || /^합계|^총계/.test(kw)) continue;          // 검색 외 지면(키워드 없음)·합계 행 제외
    const cid = ix.campaignId >= 0 ? String(r[ix.campaignId] ?? '').replace(/\D/g, '') : '';
    const k = `${cid}|${kw}`;
    const cur = map.get(k) || { campaignId: cid, campaignName: ix.campaignName >= 0 ? String(r[ix.campaignName] ?? '').trim() : '', keyword: kw, impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0 };
    cur.impressions += toNum(r[ix.impressions]); cur.clicks += toNum(r[ix.clicks]); cur.spend += toNum(r[ix.spend]);
    cur.orders += toNum(r[ix.orders]); cur.sales += toNum(r[ix.sales]);
    map.set(k, cur);
  }
  const rows = [...map.values()].map((r) => ({ ...r, roas: Math.round(ratio(r.sales, r.spend) * 100), ctr: +(ratio(r.clicks, r.impressions) * 100).toFixed(2), cvr: +(ratio(r.orders, r.clicks) * 100).toFixed(2) }));
  return { rows, columns: Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, i >= 0 ? head[i] : null])) };
}

// 키워드 판정: 낭비(광고비만, 전환 0) / 손익분기 미달 / 우수
export const KW_DEFAULTS = { minKwSpend: 3000 };
export function analyzeKeywords(kwRows, campaigns, opts = {}) {
  const o = { ...AD_DEFAULTS, ...KW_DEFAULTS, ...opts };
  const beAll = breakEvenRoas(o.marginRate);
  const beBy = new Map(campaigns.map((c) => [String(c.id), c.breakEven || breakEvenRoas(marginFor(c, o))]));
  const negBy = new Map(campaigns.map((c) => [String(c.id), new Set(((c.detail && c.detail.negativeKeywords) || []).map((k) => k.toLowerCase()))]));
  for (const r of kwRows) {
    const neg = negBy.get(r.campaignId);
    r.alreadyExcluded = !!(neg && neg.has(r.keyword.toLowerCase()));
    const be = beBy.get(r.campaignId) || beAll;
    r.flag = r.spend >= o.minKwSpend && r.orders === 0 ? 'WASTE' : r.spend >= o.minKwSpend && r.roas < be ? 'LOSS' : r.orders > 0 && r.roas >= be * 1.3 ? 'GOOD' : '';
  }
  return kwRows.sort((a, b) => b.spend - a.spend);
}

// 낭비 키워드 → 캠페인별 「제외키워드추가」 변경안 (이미 제외된 키워드·한도 초과 제외)
export function negKeywordChanges(kwRows, campaigns) {
  const byId = new Map(campaigns.map((c) => [String(c.id), c]));
  const groups = new Map();
  for (const r of kwRows) {
    if (r.flag !== 'WASTE' || r.alreadyExcluded) continue;
    const camp = byId.get(r.campaignId) || campaigns.find((c) => c.name === r.campaignName);
    if (!camp) continue;
    if (!groups.has(camp.id)) groups.set(camp.id, { camp, list: [], spend: 0 });
    const g = groups.get(camp.id);
    g.list.push(r.keyword); g.spend += r.spend;
  }
  return [...groups.values()].map(({ camp, list, spend }) => {
    const room = 500 - ((camp.detail && camp.detail.negativeKeywords.length) || 0);
    const kws = list.slice(0, Math.max(0, room));
    return { key: `${camp.id}|negKeywords`, campaignId: camp.id, campaignName: camp.name, groupId: camp.groupId, field: 'negKeywords', from: '', to: kws.join(', '),
      reason: `전환 없이 광고비 ${spend.toLocaleString('ko-KR')}원을 쓴 키워드 ${list.length}개${kws.length < list.length ? ` (제외 키워드 한도 때문에 ${kws.length}개만)` : ''}`, source: 'keyword' };
  }).filter((c) => c.to);
}

// 키워드 분석 CSV
export function keywordsCSV(rows) {
  const head = ['캠페인ID', '캠페인명', '키워드', '판정', '이미 제외됨', '노출수', '클릭수', '광고비', '전환 주문수', '전환 매출', 'ROAS(%)', '클릭률(%)', '전환율(%)'];
  const label = { WASTE: '낭비(전환 없음)', LOSS: '손익분기 미달', GOOD: '우수', '': '' };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.campaignId, r.campaignName, r.keyword, label[r.flag], r.alreadyExcluded ? 'Y' : '', r.impressions, r.clicks, r.spend, r.orders, r.sales, r.roas, r.ctr, r.cvr].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ══════════════════════════════════════════════════════════════
// 변경 효과 확인: 적용 직전 광고 점검(before) vs 적용 이후에 시작하는 기간의 광고 점검(after)
// ══════════════════════════════════════════════════════════════
//  - 하루 평균으로 비교 (기간 길이가 달라도 비교 가능)
//  - 이익(하루) = 광고 매출 × 마진율 − 광고비  → 개선 / 악화 / 변화 없음
//  - 적용 후 waitDays(기본 7일)가 지나지 않으면 「관찰 중」, 적용일 이후로만 된 점검 기간이 없으면 「점검 필요」
export const EFFECT_LABELS = { WAIT: '관찰 중', NEED_SCAN: '광고 점검 필요', NO_DATA: '데이터 없음', NO_BASE: '비교 기준 없음', BETTER: '개선', WORSE: '악화', SAME: '변화 없음' };
export function evaluateEffects(applyLog, snapshots, opts = {}) {
  const o = { ...AD_DEFAULTS, waitDays: 7, ...opts };
  const now = o.now || Date.now();
  const snaps = (snapshots || []).filter((x) => !x.demo).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const day = (x, d) => (d ? x / d : 0);
  const metrics = (m, days, rate) => {
    const spend = day(m.spend, days), sales = day(m.sales, days);
    return { spend: Math.round(spend), sales: Math.round(sales), orders: +day(m.orders, days).toFixed(1), roas: m.spend ? Math.round((m.sales / m.spend) * 100) : 0, profit: Math.round((sales * rate) / 100 - spend) };
  };
  return (applyLog || []).filter((l) => l.ok && !l.demo).map((l) => {
    const t = Date.parse(l.at);
    const out = { ...l, daysSince: Math.floor((now - t) / 86400000) };
    const rate = marginFor({ id: l.campaignId }, o);
    if (!l.before || !l.before.days) return { ...out, status: 'NO_BASE' };
    out.beforeM = metrics(l.before, l.before.days, rate);
    if (out.daysSince < o.waitDays) return { ...out, status: 'WAIT' };
    const after = snaps.find((x) => Number(x.start) >= t);       // 기간 시작이 적용 이후인 가장 최근 점검
    if (!after) return { ...out, status: 'NEED_SCAN' };
    const row = (after.rows || []).find((r) => String(r.id) === String(l.campaignId));
    if (!row) return { ...out, status: 'NO_DATA' };
    out.afterM = metrics(row, after.days, rate);
    out.afterAt = after.at;
    const b = out.beforeM.profit, a = out.afterM.profit;
    const tol = Math.max(1000, Math.abs(b) * 0.1);
    out.status = a > b + tol ? 'BETTER' : a < b - tol ? 'WORSE' : 'SAME';
    return out;
  });
}

// ══════════════════════════════════════════════════════════════
// 상품 문제 ↔ 광고: 광고비를 쓰고 있는데 상품에 문제가 있는 옵션
// ══════════════════════════════════════════════════════════════
//  adsSnap.products: [{ vendorItemId, campaignId, campaignName, spend, sales, orders, impressions, clicks }] (광고 점검 시 수집)
//  productRows: 상품 점검 행 (issues: SUPPRESSED / OUT_OF_STOCK / LOSER / ATTR / MOTA …)
export const AD_PRODUCT_ISSUES = ['SUPPRESSED', 'OUT_OF_STOCK', 'LOSER', 'ATTR', 'MOTA', 'MPN'];
export function adProductIssues(adsSnap, productRows) {
  const list = (adsSnap && adsSnap.products) || [];
  if (!list.length) return [];
  const byVid = new Map((productRows || []).map((r) => [String(r.vendorItemId), r]));
  const agg = new Map();
  for (const p of list) {
    const r = byVid.get(String(p.vendorItemId));
    if (!r || !p.spend) continue;
    const issues = (r.issues || []).filter((i) => AD_PRODUCT_ISSUES.includes(i));
    if (!issues.length) continue;
    const k = String(p.vendorItemId);
    const a = agg.get(k) || { vendorItemId: k, row: r, issues, campaigns: [], spend: 0, sales: 0, orders: 0 };
    a.spend += p.spend || 0; a.sales += p.sales || 0; a.orders += p.orders || 0;
    a.campaigns.push({ id: String(p.campaignId), name: p.campaignName || String(p.campaignId), spend: p.spend || 0 });
    agg.set(k, a);
  }
  return [...agg.values()].sort((a, b) => b.spend - a.spend);
}

// ══════════════════════════════════════════════════════════════
// 캠페인별 제외 키워드 현황 + 추천
// ══════════════════════════════════════════════════════════════
//  current : 지금 제외 키워드 (인기 검색어면 popular 표시)
//  add     : 제외 추천 = 광고 보고서에서 전환 없이 광고비만 쓴 키워드 (아직 제외 안 됨, 광고비 큰 순)
//  watch   : 참고 = 손익분기 미달 키워드 (전환은 있음 → 바로 제외하기보다 지켜보기)
//  release : 제외 해제 검토 = 내 카테고리 인기 검색어(키워드 트렌드)인데 제외되어 있는 키워드
const kwKey = (k) => String(k || '').replace(/\s+/g, '').toLowerCase();
export function negKeywordAdvice(campaign, { kwRows = [], trendKeywords = [] } = {}) {
  const neg = (campaign.detail && campaign.detail.negativeKeywords) || [];
  const negSet = new Set(neg.map(kwKey));
  const popular = new Map(trendKeywords.map((t) => [kwKey(t.keyword || t), t]));
  const mine = kwRows.filter((r) => String(r.campaignId) === String(campaign.id) || (!r.campaignId && r.campaignName === campaign.name));
  const fresh = (r) => !r.alreadyExcluded && !negSet.has(kwKey(r.keyword));
  return {
    limit: 500,
    current: neg.map((k) => ({ keyword: k, popular: popular.has(kwKey(k)) })),
    add: mine.filter((r) => r.flag === 'WASTE' && fresh(r)).sort((a, b) => b.spend - a.spend)
      .map((r) => ({ keyword: r.keyword, spend: r.spend, clicks: r.clicks })),
    watch: mine.filter((r) => r.flag === 'LOSS' && fresh(r)).sort((a, b) => b.spend - a.spend)
      .map((r) => ({ keyword: r.keyword, spend: r.spend, roas: r.roas, orders: r.orders })),
    release: neg.filter((k) => popular.has(kwKey(k))).map((k) => {
      const t = popular.get(kwKey(k));
      return { keyword: k, category: (t && t.categoryName) || '', rank: (t && t.categoryRank) || null };
    }),
    hasReport: mine.length > 0,
    hasTrends: trendKeywords.length > 0,
  };
}

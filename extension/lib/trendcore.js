// 인기 키워드(쿠팡 트렌드) 분석 — 내 상품 카테고리 기준 인기 검색어 추천
// 데이터: WING 「쿠팡 인기 상품 검색」 (lib/trends.js 에서 수집)
//  - 카테고리 인기 검색어 10개 (category/top-keywords)
//  - 키워드별 판매량순 상위 상품: 28일 조회수 구간(lowerPvLast28d~upperPvLast28d), 가격, 리뷰 수, 내 상품 순위

import { isInactive } from './core.js';

export const TRENDS_PAGE_URL = 'https://wing.coupang.com/tenants/rfm-ss/coupang-trends/popularity-search';
export const trendsKeywordUrl = (kw) => `${TRENDS_PAGE_URL}?keyword=${encodeURIComponent(kw)}`;

export const TREND_FLAGS = {
  EXCLUDED: { label: '제외 키워드에 있음', tip: '인기 검색어인데 켜진 캠페인의 제외 키워드로 막혀 있습니다. 내 상품과 관련 있다면 제외 해제를 검토하세요.' },
  MISSING: { label: '내 상품 순위 밖', tip: '판매량순 상위 60위 안에 내 상품이 없습니다. 상품명·검색어 태그에 키워드를 반영하거나 수동 광고 키워드로 검토하세요.' },
  LOW: { label: '내 상품 하위권', tip: '내 상품이 상위 20위 밖입니다. 광고로 노출을 보강하거나 상품명·대표 이미지를 점검하세요.' },
  TOP: { label: '내 상품 상위권', tip: '내 상품이 상위 20위 안에 있습니다. 재고·가격을 유지하세요.' },
  PRICE_HIGH: { label: '가격 높음', tip: '내 상품 가격이 상위 10개 상품 가격 중앙값보다 30% 이상 높습니다.' },
  HARD: { label: '경쟁 강함', tip: '상위 10개 상품의 평균 리뷰가 1,000개 이상이라 신규 진입이 어렵습니다.' },
};

// 최신 상품 점검 결과에서 내 상품 카테고리 목록 (판매 중 상품 수 → 판매수량 순)
export function categoriesFromRows(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r.categoryCode) continue;
    const c = map.get(r.categoryCode) || { code: r.categoryCode, name: r.categoryName || r.categoryCode, products: new Set(), active: new Set(), sold: new Map() };
    c.products.add(r.sellerProductId);
    if (!isInactive(r)) c.active.add(r.sellerProductId);
    c.sold.set(r.sellerProductId, r.unitSold || 0);
    map.set(r.categoryCode, c);
  }
  return [...map.values()]
    .map((c) => ({ code: c.code, name: c.name, products: c.products.size, active: c.active.size, sold: [...c.sold.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.active - a.active || b.sold - a.sold || b.products - a.products);
}
// 점검 결과에 카테고리 정보가 있는지 (0.5.2 이전 점검 결과에는 없음)
export const rowsHaveCategory = (rows) => (rows || []).some((r) => r.categoryCode);

// 켜진 캠페인의 제외 키워드 → { 키워드: [캠페인명…] }
export function negativeKeywordIndex(adRows) {
  const idx = {};
  for (const r of adRows || []) {
    if (!r.isActive || !r.detail) continue;
    for (const k of r.detail.negativeKeywords || []) {
      const key = String(k).replace(/\s+/g, '').toLowerCase();
      (idx[key] = idx[key] || []).push(r.name);
    }
  }
  return idx;
}

// 키워드별 판정 + 추천 순서
//  trends: lib/trends.js 결과, productRows: 상품 점검 행(가격 비교용), adRows: 광고 캠페인 행(제외 키워드)
export function analyzeTrends(trends, productRows = [], adRows = []) {
  if (!trends) return { keywords: [], categories: [] };
  const neg = negativeKeywordIndex(adRows);
  const priceByVid = new Map();
  const priceByPid = new Map();
  for (const r of productRows) {
    if (r.salePrice) { priceByVid.set(String(r.vendorItemId), r.salePrice); if (r.productId && !priceByPid.has(r.productId)) priceByPid.set(String(r.productId), r.salePrice); }
  }
  const out = [];
  const seen = new Set();
  for (const c of trends.categories || []) {
    c.keywords.forEach((k, i) => {
      const d = (trends.keywords || {})[k] || null;
      const flags = [];
      const excludedIn = neg[String(k).replace(/\s+/g, '').toLowerCase()] || [];
      if (excludedIn.length) flags.push('EXCLUDED');
      let myPrice = null;
      if (d) {
        if (d.myRank == null) flags.push('MISSING');
        else if (d.myRank > 20) flags.push('LOW');
        else flags.push('TOP');
        if (d.myItem) myPrice = priceByVid.get(d.myItem.vendorItemId) || priceByPid.get(d.myItem.productId) || null;
        if (myPrice && d.priceMedian && myPrice > d.priceMedian * 1.3) flags.push('PRICE_HIGH');
        if (d.avgReviews10 >= 1000) flags.push('HARD');
      }
      const row = {
        keyword: k, categoryCode: c.code, categoryName: c.name, categoryRank: i + 1,
        detail: d, flags, excludedIn: [...new Set(excludedIn)], myPrice,
        demand: d ? d.avgPv10 : 0,
        duplicate: seen.has(k),
      };
      seen.add(k);
      out.push(row);
    });
  }
  // 추천: 내 상품이 상위권이 아닌 인기 키워드 (수요 큰 순), 제외 키워드 충돌은 맨 앞
  const recommend = out
    .filter((r) => !r.duplicate && (r.flags.includes('EXCLUDED') || r.flags.includes('MISSING') || r.flags.includes('LOW')))
    .sort((a, b) => (b.flags.includes('EXCLUDED') - a.flags.includes('EXCLUDED')) || (b.demand - a.demand) || (a.categoryRank - b.categoryRank));
  return { keywords: out, recommend, categories: trends.categories || [] };
}

// 28일 조회수 구간 표시 (예: 10000~20000 → 1만~2만)
export function pvRange(lo, hi) {
  const f = (n) => (n >= 10000 ? `${+(n / 10000).toFixed(1)}만` : n >= 1000 ? `${+(n / 1000).toFixed(1)}천` : String(n || 0));
  if (!lo && !hi) return '-';
  return `${f(lo)}~${f(hi)}`;
}

export function trendsCSV(list) {
  const head = ['카테고리', '카테고리 순위', '키워드', '판매 1위 상품 28일 조회수', '상위10 평균 조회수', '가격 중앙값', '상위10 평균 리뷰', '내 상품 순위', '내 상품', '판정', '제외 키워드 캠페인', '연관 키워드'];
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(',')];
  for (const r of list) {
    const d = r.detail || {};
    lines.push([r.categoryName, r.categoryRank, r.keyword, d.topPvUpper ? pvRange(d.topPvLower, d.topPvUpper) : '', d.avgPv10 || '', d.priceMedian || '', d.avgReviews10 || '',
      d.myRank || (r.detail ? '60위 밖' : ''), d.myItem ? d.myItem.productName : '', r.flags.map((f) => TREND_FLAGS[f].label).join(' / '), r.excludedIn.join(' / '), (d.related || []).join(' ')].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// 데모 데이터 (demoScan 상품 7000000000~ 과 연결)
export function demoTrends() {
  const kw = (avg, top, rank, pid, price, rev, rel) => ({
    count: 60, topPvLower: top[0], topPvUpper: top[1], avgPv10: avg, priceMin: Math.round(price * 0.6), priceMedian: price, priceMax: price * 2,
    avgReviews10: rev, myRank: rank, myItem: rank ? { productId: String(pid), vendorItemId: '', productName: '데모 상품' } : null, related: rel, leafCategories: {},
  });
  return {
    at: new Date().toISOString(), demo: true, errors: [],
    categories: [
      { code: '82224', name: '낚시찌', products: 6, active: 6, sold: 60, keywords: ['전자찌', '민물전자찌', '바다막대찌', '캐스팅볼', '바다전자찌'] },
      { code: '82205', name: '낚시 소품', products: 3, active: 3, sold: 21, keywords: ['낚시용품', '낚시', '바다낚시용품', '카고낚시채비', '해루질장비'] },
    ],
    keywords: {
      전자찌: kw(15000, [20000, 40000], 3, 7000000000, 9900, 900, ['전자구멍찌', '전자막대찌']),
      민물전자찌: kw(8000, [10000, 20000], null, 0, 12000, 400, ['민물찌', '올림찌']),
      바다막대찌: kw(6000, [10000, 20000], 35, 7000000002, 15000, 300, ['막대찌', '바다찌']),
      캐스팅볼: kw(3000, [4000, 6000], null, 0, 8000, 1500, ['던질찌']),
      바다전자찌: kw(9000, [10000, 20000], 12, 7000000004, 7000, 250, ['구멍찌']),
      낚시용품: kw(50000, [80000, 100000], null, 0, 26000, 2900, ['바다낚시용품', '민물낚시용품']),
      낚시: kw(70000, [80000, 100000], 88, 7000000001, 30000, 3000, ['낚시대', '릴']),
      바다낚시용품: kw(20000, [40000, 60000], null, 0, 19000, 800, ['낚시용품']),
      카고낚시채비: kw(4000, [6000, 8000], 5, 7000000005, 6500, 120, ['카고']),
      해루질장비: kw(5000, [6000, 8000], null, 0, 22000, 200, ['해루질']),
    },
  };
}

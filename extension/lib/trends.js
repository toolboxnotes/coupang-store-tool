// WING 「쿠팡 인기 상품 검색」(coupang-trends) 데이터 수집 — WING 탭 안에서 실행 (chrome.scripting.executeScript)
// 이 함수는 탭 안으로 그대로 주입되므로 외부 변수·import를 사용하면 안 됨 (자기 완결형).
//
// 사용하는 WING 내부 주소 (읽기 전용, 2026-11 확인)
//  - GET  /tenants/rfm-ss/api/trends/category/top-keywords?categoryCode={노출 카테고리 코드}
//         → ["키워드", …] (카테고리 인기 검색어 10개)
//  - POST /tenants/rfm-ss/api/trends/search  { searchCondition: { query, limit, sort:['BEST_SELLING'], … } }
//         → 판매량순 최대 60개 (limit를 크게 해도 60개, start로 다음 페이지 없음)
//         → { relatedKeywords[], searchItems[{ productId, vendorItemId, productName, pvLast28dRank,
//              lowerPvLast28d, upperPvLast28d, salesPrice{amount}, rating, ratingCount, displayCategoryInfos[] }] }
//  - 두 주소 모두 X-XSRF-TOKEN 헤더(쿠키 XSRF-TOKEN 값)가 필요
export async function trendsInPage(opts) {
  const o = Object.assign({ categories: [], detail: true, limit: 60, delayMs: 3000, myProductIds: [], myVendorItemIds: [], skipKeywords: [], maxKeywords: 60 }, opts || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 사람처럼 간격을 불규칙하게 (대기 시간 ×0.7~1.4)
  const pause = () => sleep(Math.round(o.delayMs * (0.7 + Math.random() * 0.7)));
  const progress = (phase, done, total) => { try { chrome.runtime.sendMessage({ type: 'trendsProgress', phase, done, total }); } catch (e) { /* 무시 */ } };
  const xsrf = decodeURIComponent((document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/) || [])[1] || '');
  const H = { Accept: 'application/json, text/plain, */*', 'X-XSRF-TOKEN': xsrf, 'X-CP-PT-locale': 'ko' };
  const out = { at: new Date().toISOString(), categories: [], keywords: {}, errors: [] };
  const mineP = new Set(o.myProductIds.map(String));
  const mineV = new Set(o.myVendorItemIds.map(String));

  async function once(url, init) {
    let res;
    try { res = await fetch(url, Object.assign({ credentials: 'include' }, init)); } catch (e) { return { error: 'BLOCKED' }; } // 쿠팡 보안이 요청을 끊으면 네트워크 오류로 보임
    if (res.status === 401 || /\/login|sso\./.test(res.url)) return { error: 'AUTH' };
    if (res.status === 403 || res.status === 429) return { error: 'BLOCKED' };
    if (!res.ok) return { error: 'API', status: res.status };
    const text = await res.text();
    if (!text) return { error: 'BLOCKED' };          // 빈 응답 = 차단·제한
    try { return { data: JSON.parse(text) }; } catch (e) { return { error: /<html/i.test(text) ? 'AUTH' : 'API' }; }
  }
  // 차단으로 보이면 40초 쉬고 1번만 다시 시도 → 그래도 막히면 중단 (지금까지 결과는 저장)
  async function call(url, init) {
    const r = await once(url, init);
    if (r.error !== 'BLOCKED') return r;
    progress('cooldown', 0, 0);
    await sleep(40000);
    return once(url, init);
  }

  // 1) 카테고리별 인기 검색어
  for (let i = 0; i < o.categories.length; i++) {
    const c = o.categories[i];
    progress('categories', i, o.categories.length);
    const r = await call(`/tenants/rfm-ss/api/trends/category/top-keywords?categoryCode=${encodeURIComponent(c.code)}`, { headers: H });
    if (r.error === 'AUTH') return { error: 'AUTH' };
    if (r.error === 'BLOCKED') { if (!out.categories.length) return { error: 'BLOCKED' }; out.stopped = 'BLOCKED'; break; }
    if (r.error) { out.errors.push(`카테고리 ${c.name || c.code}: ${r.error}${r.status ? ' ' + r.status : ''}`); out.categories.push({ ...c, keywords: [] }); }
    else out.categories.push({ ...c, keywords: (Array.isArray(r.data) ? r.data : []).map(String) });
    await pause();
  }
  progress('categories', o.categories.length, o.categories.length);
  if (!o.detail || out.stopped) { out.finishedAt = new Date().toISOString(); return out; }

  // 2) 키워드별 검색 결과 (판매량순 상위 상품의 28일 조회수, 가격, 내 상품 순위)
  // 최근 조회한 키워드(skipKeywords)는 다시 조회하지 않음, 한 번에 최대 maxKeywords개
  const skip = new Set(o.skipKeywords.map(String));
  const all = [...new Set(out.categories.flatMap((c) => c.keywords))].filter((k) => !skip.has(k));
  const list = all.slice(0, o.maxKeywords);
  out.remaining = all.length - list.length;
  const context = { bundleId: 62, ip: '127.0.0.1', viewType: 'WEB', sourcePage: 'Srp', pcid: 'unknown', channel: 'unknown', userNo: 0, uuid: '', osType: 'PC', appVersion: '1.0.0', abTests: null, engineParams: {}, filteredAbTests: null, swapSet: null };
  let fails = 0;
  for (let i = 0; i < list.length; i++) {
    const kw = list[i];
    progress('keywords', i, list.length);
    const body = { searchCondition: { start: 0, limit: o.limit, query: kw, sort: ['BEST_SELLING'], filter: {}, context } };
    const r = await call('/tenants/rfm-ss/api/trends/search', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(body) });
    if (r.error === 'AUTH' || r.error === 'BLOCKED') { out.stopped = r.error; out.remaining += list.length - i; break; }
    if (r.error) { out.errors.push(`키워드 ${kw}: ${r.error}`); if (++fails >= 3) { out.errors.push('연속 실패로 키워드 조회 중단'); out.remaining += list.length - i - 1; break; } await pause(); continue; }
    fails = 0;
    const items = Array.isArray(r.data.searchItems) ? r.data.searchItems : [];
    const top = items.slice(0, 10);
    // 조회수 하한이 Long 최솟값(-9223372036854775808)으로 오는 경우 = 1,000 미만 구간 → 0으로 처리
    const pv = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1e12 ? n : 0; };
    const mid = (it) => (pv(it.lowerPvLast28d) + pv(it.upperPvLast28d)) / 2;
    const prices = top.map((it) => Number(it.salesPrice && it.salesPrice.amount)).filter((n) => n > 0).sort((a, b) => a - b);
    let myRank = null; let myItem = null;
    items.some((it, idx) => {
      if (mineP.has(String(it.productId)) || mineV.has(String(it.vendorItemId))) { myRank = idx + 1; myItem = { productId: String(it.productId), vendorItemId: String(it.vendorItemId), productName: String(it.productName || '') }; return true; }
      return false;
    });
    const cats = {};
    for (const it of top) { const d = (it.displayCategoryInfos || [])[0]; if (d && d.leafCategoryCode) cats[d.leafCategoryCode] = (cats[d.leafCategoryCode] || 0) + 1; }
    out.keywords[kw] = {
      count: items.length,
      topPvLower: top[0] ? pv(top[0].lowerPvLast28d) : 0,
      topPvUpper: top[0] ? pv(top[0].upperPvLast28d) : 0,
      avgPv10: top.length ? Math.round(top.reduce((a, it) => a + mid(it), 0) / top.length) : 0,
      priceMin: prices[0] || 0,
      priceMedian: prices.length ? prices[Math.floor(prices.length / 2)] : 0,
      priceMax: prices[prices.length - 1] || 0,
      avgReviews10: top.length ? Math.round(top.reduce((a, it) => a + (Number(it.ratingCount) || 0), 0) / top.length) : 0,
      myRank, myItem,
      related: (r.data.relatedKeywords || []).map(String).slice(0, 10),
      leafCategories: cats,
      at: new Date().toISOString(),
    };
    await pause();
  }
  progress('keywords', list.length, list.length);
  out.finishedAt = new Date().toISOString();
  return out;
}

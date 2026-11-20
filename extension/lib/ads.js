// 쿠팡 광고센터 탭(advertising.coupang.com) 안에서 실행되는 함수 (chrome.scripting.executeScript로 주입).
// 반드시 독립적으로 동작해야 함: import 금지, 바깥 변수 참조 금지.
// 읽기 전용: 광고센터 화면이 사용하는 조회 엔드포인트만 호출 (캠페인 수정·생성 없음).
//
// 수집 항목 (2026-11 확인)
//  1) 캠페인 목록   POST /marketing/tetris-api/campaigns        → 이름, ON/OFF, 목표 ROAS, 예산, 운영 방식
//  2) 캠페인 성과   POST /marketing/cmg-api/tableMetric         → tableType "campaign_sales", 캠페인 ID 묶음 단위
//  3) 일별 합계     POST /marketing/cmg-api/report/SALES        → 날짜별 광고비·전환 매출 등
//  4) 광고그룹 상세 GET  /marketing/tetris-api/campaign/{캠페인ID}/ad-group/{광고그룹ID}
//                   → 제외 키워드(type blacklist), 제외 상품 수, 노출 상태·힌트, 목표 ROAS (켜진 캠페인만)
// 날짜는 한국 시간 자정 기준 밀리초 (start = 첫날 0시, end = 마지막 날 0시)
export async function adsScanInPage(opts) {
  // 광고센터는 요청이 빠르면 막히므로 간격을 넉넉하게 (기본 4초, 불규칙)
  const { days = 7, delayMs = 4000, chunk = 20, maxDetail = 20, skipDetailIds = [],
    productTargets = [], adsIndex = {}, maxListPages = 10, indexMaxAgeDays = 7 } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5)))); // 간격을 불규칙하게 (차단 방지)
  const progress = (phase, done, total) => {
    try { chrome.runtime.sendMessage({ type: 'adsProgress', phase, done, total }); } catch (e) { /* 무시 */ }
  };

  // 로그인 페이지면 중단
  if (/\/user\/login/.test(location.pathname)) return { error: 'ADS_AUTH' };

  // 차단 감지: 연결 끊김·403·429·빈 응답 → BLOCKED (60초 쉬고 1번만 재시도)
  async function once(url, init) {
    let res;
    try { res = await fetch(url, Object.assign({ credentials: 'include' }, init)); } catch (e) { return { error: 'BLOCKED' }; }
    if (res.status === 401 || /\/user\/login/.test(res.url)) return { error: 'ADS_AUTH' };
    if (res.status === 403 || res.status === 429) return { error: 'BLOCKED' };
    const text = await res.text();
    if (!text) return { error: res.ok ? 'BLOCKED' : 'API', status: res.status };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { error: /login|로그인/i.test(text) ? 'ADS_AUTH' : 'BLOCKED' }; }
    if (!res.ok) return { error: 'API', status: res.status, message: typeof json === 'string' ? json : '' };
    return { json };
  }
  async function request(url, init) {
    const r = await once(url, init);
    if (r.error !== 'BLOCKED') return r;
    progress('cooldown', 0, 0);
    await new Promise((ok) => setTimeout(ok, 60000));
    return once(url, init);
  }
  const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // 기간 계산 (한국 시간)
  const DAY = 86400000, KST = 9 * 3600000;
  const todayStart = Math.floor((Date.now() + KST) / DAY) * DAY - KST;
  const end = todayStart - DAY;                 // 어제 0시
  const start = end - (days - 1) * DAY;         // N일 전 0시

  const out = { startedAt: new Date().toISOString(), start, end, days, campaigns: [], metrics: {}, daily: {}, errors: [] };

  // 1) 캠페인 목록 (매출 성장 = SALES)
  let page = 0;
  for (;;) {
    const r = await post('/marketing/tetris-api/campaigns', {
      isDeleted: false, pagination: { page, size: 100 }, sortedBy: 'ID', isSortDesc: 'DESC', budgetTypes: null, isActive: null,
      name: '', creationContext: null, objective: null, primaryOrderBy: 'DEFAULT', goalType: 'SALES',
      targetCampaignId: null, vendorItemId: null, tdeCardTypes: null, campaignIds: null,
    });
    if (r.error) { out.error = r.error; return out; }
    const list = (r.json && r.json.campaigns) || [];
    out.campaigns.push(...list.map((c) => ({
      id: c.id, name: c.name, isActive: c.isActive, isSuspended: c.isSuspended, disabledByCoupang: c.disabledByCoupang,
      status: c.status, roasTarget: c.roasTarget, targetType: c.targetType, budget: c.calculatedBudget, capType: c.capType,
      objective: c.objective, campaignType: c.campaignType, startDate: c.startDate, endDate: c.endDate, totalAdCount: c.totalAdCount,
      groupId: c.groupId, creationContext: c.creationContext,
    })));
    if (list.length < 100 || page >= 20) break;
    page++;
    await sleep(delayMs);
  }
  progress('campaigns', out.campaigns.length, out.campaigns.length);

  // 2) 캠페인 성과 (묶음 단위)
  const ids = out.campaigns.map((c) => c.id);
  for (let i = 0; i < ids.length; i += chunk) {
    await sleep(delayMs);
    const part = ids.slice(i, i + chunk);
    const r = await post('/marketing/cmg-api/tableMetric', {
      campaignIds: part, creativeId: null, start, end, tableType: 'campaign_sales', targetList: part, isMatchTypeEnabled: false,
    });
    if (r.error) { out.errors.push(r.error === 'BLOCKED' ? '광고센터가 요청을 막아 캠페인 성과 일부만 조회' : '캠페인 성과 일부 조회 실패'); if (r.error === 'BLOCKED') out.stopped = 'BLOCKED'; break; }
    Object.assign(out.metrics, r.json || {});
    progress('metrics', Math.min(i + chunk, ids.length), ids.length);
  }

  // 3) 일별 합계
  if (!out.stopped) {
    await sleep(delayMs);
    const d = await post('/marketing/cmg-api/report/SALES', { start, end });
    if (d.error === 'BLOCKED') out.stopped = 'BLOCKED';
    if (d.error) out.errors.push('일별 합계 조회 실패');
    else out.daily = (d.json && d.json.result) || {};
  }

  // 4) 켜진 캠페인의 광고그룹 상세 (제외 키워드 등)
  out.details = {};
  // 최근(6시간 안) 조회한 캠페인은 건너뜀 (skipDetailIds), 한 번에 최대 maxDetail개
  const skip = new Set(skipDetailIds.map(String));
  const allTargets = out.stopped ? [] : out.campaigns.filter((c) => c.isActive && c.groupId && !skip.has(String(c.id)));
  const targets = allTargets.slice(0, maxDetail);
  out.detailRemaining = allTargets.length - targets.length;
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    await sleep(delayMs);
    const r = await request(`/marketing/tetris-api/campaign/${c.id}/ad-group/${c.groupId}`, {});
    if (r.error) {
      out.errors.push(r.error === 'BLOCKED' ? '광고센터가 요청을 막아 광고그룹 상세 일부만 조회' : '광고그룹 상세 일부 조회 실패');
      if (r.error === 'BLOCKED') out.stopped = 'BLOCKED';
      out.detailRemaining += targets.length - i;
      break;
    }
    const j = r.json;
    const ag = (j && j.adGroup) || {};
    const cp = (j && j.campaign) || {};
    out.details[c.id] = {
      groupId: ag.id || c.groupId,
      roasTarget: ag.roasTarget,
      adSelectionType: ag.adSelectionType,          // AUTO_SELECTION = AI 스마트(자동 상품 선택)
      targetKeywordType: ag.targetKeywordType,      // automatic = 키워드 자동
      negativeKeywords: (ag.keywords || []).filter((k) => k.type === 'blacklist' && !k.isDeleted).map((k) => k.keyword),
      otherKeywords: (ag.keywords || []).filter((k) => k.type !== 'blacklist' && !k.isDeleted).map((k) => ({ keyword: k.keyword, type: k.type, price: k.price })),
      excludedProducts: (ag.excludeProductList || []).length,
      servingStatus: (cp.servingStatus && cp.servingStatus.status) || (ag.servingStatus && ag.servingStatus.status) || '',
      servingHints: [...new Set(((ag.servingStatus && ag.servingStatus.hints) || []).map((h) => h.status))],
      spentToday: cp.spentBudget,
      at: new Date().toISOString(),
    };
    progress('details', i + 1, targets.length);
  }

  // 5) 상품(옵션)별 광고 성과 — 상품 점검에서 문제가 있는 옵션(productTargets)만 조회
  //  - 광고그룹의 광고 목록(광고ID ↔ 옵션ID)은 7일 동안 저장해 재사용 (AI 스마트는 광고가 수천 개라 여러 번에 나눠 수집)
  //    POST /marketing/tetris-api/{광고그룹ID}/ads { isDeleted:false, pagination:{page,size:200}, sortedBy:'ID', isSortDesc:true }
  //  - 성과: POST /marketing/cmg-api/tableMetric { tableType:'product_sales', adGroupId, targetList:[광고ID…] }
  out.adsIndex = {};
  out.products = [];
  const targetsSet = new Set(productTargets.map(String));
  if (!out.stopped && targetsSet.size) {
    let pagesLeft = maxListPages;
    const groups = out.campaigns.filter((c) => c.isActive && c.groupId)
      .sort((a, b) => ((out.metrics[b.id] || {}).deliveredAdCost || 0) - ((out.metrics[a.id] || {}).deliveredAdCost || 0));
    for (let gi = 0; gi < groups.length && !out.stopped; gi++) {
      const c = groups[gi];
      const gid = String(c.groupId);
      let idx = adsIndex[gid];
      const fresh = idx && idx.complete && Date.now() - Date.parse(idx.at) < indexMaxAgeDays * 86400000;
      if (!fresh) {
        if (!idx || idx.complete) idx = { at: new Date().toISOString(), complete: false, nextPage: 0, total: null, ads: [] };
        while (!idx.complete && pagesLeft > 0) {
          await sleep(delayMs);
          const r = await post(`/marketing/tetris-api/${gid}/ads`, { isDeleted: false, pagination: { page: idx.nextPage, size: 200 }, sortedBy: 'ID', isSortDesc: true });
          pagesLeft--;
          if (r.error) { if (r.error === 'BLOCKED') out.stopped = 'BLOCKED'; out.errors.push('광고 상품 목록 일부 조회 실패'); break; }
          const ads = (r.json && r.json.ads) || [];
          for (const a of ads) idx.ads.push({ id: String(a.adNodeId), vid: String(a.vendoritemid || a.vendorItemId || ''), active: a.isActive !== false && !a.isSuspended, name: String(a.itemName || '') });
          idx.total = (r.json && r.json.pageInfo && r.json.pageInfo.totalCount) || idx.total;
          idx.nextPage++;
          if (ads.length < 200 || (idx.total && idx.ads.length >= idx.total)) { idx.complete = true; idx.at = new Date().toISOString(); }
          progress('products', idx.ads.length, idx.total || idx.ads.length);
        }
      }
      out.adsIndex[gid] = idx;
      const hit = idx.ads.filter((a) => targetsSet.has(a.vid));
      for (let i = 0; i < hit.length && !out.stopped; i += 200) {
        const part = hit.slice(i, i + 200);
        await sleep(delayMs);
        const r = await post('/marketing/cmg-api/tableMetric', { campaignIds: [String(c.id)], creativeId: null, start, end, tableType: 'product_sales', adGroupId: gid, targetList: part.map((a) => a.id), isMatchTypeEnabled: false });
        if (r.error) { if (r.error === 'BLOCKED') out.stopped = 'BLOCKED'; out.errors.push('상품별 광고 성과 일부 조회 실패'); break; }
        for (const a of part) {
          const m = (r.json || {})[a.id] || {};
          out.products.push({ vendorItemId: a.vid, adId: a.id, adActive: a.active, campaignId: String(c.id), campaignName: c.name, groupId: gid,
            spend: Math.round(m.deliveredAdCost || 0), sales: Math.round(m.adAttributedSales || 0), orders: m.adAttributedOrders || 0, impressions: m.impressions || 0, clicks: m.clicks || 0 });
        }
      }
    }
    out.productTargets = targetsSet.size;
  }

  out.finishedAt = new Date().toISOString();
  return out;
}

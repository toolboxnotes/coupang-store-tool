// WING 탭(wing.coupang.com) 안에서 실행되는 함수 (chrome.scripting.executeScript로 주입).
// 반드시 독립적으로 동작해야 함: import 금지, 바깥 변수 참조 금지.
// 읽기 전용: 상품 조회/수정 화면이 사용하는 WING 내부 조회 엔드포인트만 호출.
//
// 점검은 짧은 단계로 나눠 실행합니다 (0.7.2~).
//  Chrome은 확장 프로그램의 한 작업이 5분을 넘거나 PC가 절전되면 백그라운드를 멈추므로,
//  한 번에 전체를 수집하면 중간에 결과가 사라질 수 있습니다. 단계마다 진행 상황을 저장해 이어서 점검할 수 있게 합니다.
//
//  1) wingListPageInPage  : 상품 목록 1페이지 + 그 페이지의 노출 상태
//     POST /tenants/seller-web/v2/vendor-inventory/search
//     POST /tenants/seller-web/v2/vendor-inventories/exposure/query-status-new
//     → 옵션별 아이템위너 여부, 자사 상품에 위너를 뺏겼는지, 노출제한 여부
//  2) wingDetailBatchInPage : 상세 정보 몇 개씩 (판매중 상품만)
//     GET  /tenants/seller-web/v2/vendor-inventory/vendor-inventory-items-with-vendorItems/{등록상품ID}
//     → 노출상품ID(productId), 누락된 필수 속성 등

// 상품 목록 1페이지 + 노출 상태
export async function wingListPageInPage(opts) {
  const { page = 1, pageSize = 50, collectStatus = true, delayMs = 2000 } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5)))); // 간격을 불규칙하게 (차단 방지)
  async function call(url, init) {
    let res;
    try { res = await fetch(url, { credentials: 'include', ...init }); } catch (e) { return { error: 'NETWORK', message: String(e) }; }
    if (res.status === 401 || res.status === 403) return { error: 'AUTH', status: res.status };
    if (res.status === 429) return { error: 'RATE', status: res.status };
    const text = await res.text();
    if (!text) return { error: 'NETWORK', status: res.status }; // 빈 응답 = 차단·제한
    let json;
    try { json = JSON.parse(text); } catch (e) { return { error: 'AUTH', status: res.status }; } // HTML = 로그인 페이지
    if (!res.ok || json.success === false || json.successful === false) return { error: 'API', status: res.status, message: json && json.message };
    return { json };
  }
  const postJSON = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const r = await postJSON('/tenants/seller-web/v2/vendor-inventory/search', { exposureStatus: 'ALL', exposureStatuses: [], page, countPerPage: pageSize });
  if (r.error) return { error: r };
  const d = r.json.data || {};
  const list = d.productList || [];
  const out = { list, totalPages: (d.pagination && d.pagination.totalPages) || 0, totalCount: (d.pagination && d.pagination.totalCount) || 0, statusError: null };
  if (collectStatus && list.length) {
    await sleep(Math.round(delayMs / 2));
    const inventoryRequests = list
      .map((p) => ({ vendorInventoryId: p.vendorInventoryId, vendorItemIds: (p.vendorInventoryItems || []).map((i) => i.vendorItemId) }))
      .filter((x) => x.vendorItemIds.length);
    const s = await postJSON('/tenants/seller-web/v2/vendor-inventories/exposure/query-status-new', { inventoryRequests, queryTypeEnum: null });
    if (s.error) out.statusError = s; // 노출 상태 실패는 기록만 하고 목록 수집은 계속
    else {
      const body = s.json.body || s.json.data || {};
      for (const p of list) {
        const st = body[p.vendorInventoryId];
        if (!st) continue;
        const byItem = new Map((st.items || []).map((x) => [String(x.vendorItemId), x]));
        for (const it of p.vendorInventoryItems || []) {
          const x = byItem.get(String(it.vendorItemId));
          if (x) it._status = {
            displayStatus: x.displayStatus, buyboxWinner: x.buyboxWinner, selfLoser: x.buyboxLoserBySellerSelf,
            suppressed: x.suppressed, suppressedTypes: x.suppressedTypes, attributesViolation: x.attributesViolation, productItemId: x.productItemId,
          };
        }
      }
    }
  }
  return out;
}

// 상세 정보 묶음: ids = 등록상품ID 목록 → { details: { 등록상품ID: { 옵션ID: _detail } }, done, error }
export async function wingDetailBatchInPage(opts) {
  const { ids = [], delayMs = 2000 } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5))));
  const details = {};
  let done = 0;
  for (let i = 0; i < ids.length; i++) {
    if (i) await sleep(delayMs);
    let res, json;
    try {
      res = await fetch(`/tenants/seller-web/v2/vendor-inventory/vendor-inventory-items-with-vendorItems/${ids[i]}?hasProgressiveDiscountRule=true&queryNonVariationJustificationProof=true&queryMpnProof=false`, { credentials: 'include' });
    } catch (e) { return { details, done, error: { error: 'NETWORK' } }; }
    if (res.status === 401 || res.status === 403) return { details, done, error: { error: 'AUTH' } };
    if (res.status === 429) return { details, done, error: { error: 'RATE' } };
    const text = await res.text();
    if (!text) return { details, done, error: { error: 'NETWORK' } };
    try { json = JSON.parse(text); } catch (e) { return { details, done, error: { error: 'AUTH' } }; }
    if (!res.ok) return { details, done, error: { error: 'API', status: res.status } };
    const m = {};
    for (const x of json.data || []) {
      m[String(x.vendorItemId)] = {
        productId: x.productId, itemId: x.itemId, originalPrice: x.originalPrice,
        missingRequiredAttributeNames: x.missingRequiredAttributeNames || [],
        cdsSuppressTags: x.cdsSuppressTags || [], hasCdsSuppressed: !!x.hasCdsSuppressed,
      };
    }
    details[String(ids[i])] = m;
    done++;
  }
  return { details, done };
}

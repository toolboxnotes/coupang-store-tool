// WING 탭(wing.coupang.com) 안에서 실행되는 함수 (chrome.scripting.executeScript로 주입).
// 반드시 독립적으로 동작해야 함: import 금지, 바깥 변수 참조 금지.
// 읽기 전용: 상품 조회/수정 화면이 사용하는 WING 내부 조회 엔드포인트만 호출.
//
// 수집 순서
//  1) 상품 목록      POST /tenants/seller-web/v2/vendor-inventory/search            (페이지별)
//  2) 노출 상태      POST /tenants/seller-web/v2/vendor-inventories/exposure/query-status-new  (페이지별 일괄)
//     → 옵션별 아이템위너 여부, 자사 상품에 위너를 뺏겼는지, 노출제한 여부
//  3) 상세 정보      GET  /tenants/seller-web/v2/vendor-inventory/vendor-inventory-items-with-vendorItems/{등록상품ID}
//     → 노출상품ID(productId), 누락된 필수 속성 등. 판매중 상품만 (호출 수 절약)
export async function wingScanInPage(opts) {
  const {
    pageSize = 50, delayMs = 1500, maxPages = 200,
    collectStatus = true, collectDetail = true, detailOnlyActive = true, maxDetail = 600,
  } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5)))); // 간격을 불규칙하게 (차단 방지)
  // 진행 상황을 백그라운드로 전달 (실패해도 수집은 계속)
  const progress = (phase, done, total) => {
    try { chrome.runtime.sendMessage({ type: 'progress', phase, done, total }); } catch (e) { /* 무시 */ }
  };

  // 공통 요청. 오류는 코드로 반환 (예외를 던지지 않음)
  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, { credentials: 'include', ...init });
    } catch (e) {
      return { error: 'NETWORK', message: String(e) };
    }
    if (res.status === 401 || res.status === 403) return { error: 'AUTH', status: res.status };
    if (res.status === 429) return { error: 'RATE', status: res.status };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return { error: 'AUTH', status: res.status }; // HTML = 세션 만료로 로그인 페이지 리다이렉트
    }
    if (!res.ok || json.success === false || json.successful === false) {
      return { error: 'API', status: res.status, message: json && json.message };
    }
    return { json };
  }
  const postJSON = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const out = { startedAt: new Date().toISOString(), all: { list: [], totalCount: 0 }, filters: {}, statusError: null, detailError: null, detailCount: 0 };

  // 1) + 2) 상품 목록과 노출 상태
  let page = 1, totalPages = 1;
  while (page <= totalPages && page <= maxPages) {
    const r = await postJSON('/tenants/seller-web/v2/vendor-inventory/search', { exposureStatus: 'ALL', exposureStatuses: [], page, countPerPage: pageSize });
    if (r.error) { out.all.error = r; return out; } // 목록 오류는 즉시 중단 (연속 오류로 인한 IP 차단 방지)
    const d = r.json.data || {};
    const list = d.productList || [];
    totalPages = (d.pagination && d.pagination.totalPages) || 0;
    out.all.totalCount = (d.pagination && d.pagination.totalCount) || 0;

    if (collectStatus && !out.statusError && list.length) {
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
    out.all.list.push(...list);
    progress('list', page, totalPages);
    page++;
    if (page <= totalPages) await sleep(delayMs);
  }
  out.all.truncated = totalPages > maxPages;

  // 3) 상세 정보 (판매중 상품 위주)
  if (collectDetail) {
    const targets = out.all.list.filter((p) => !detailOnlyActive || p.productStatus !== 'SUSPENDED').slice(0, maxDetail);
    for (const p of targets) {
      await sleep(delayMs);
      const r = await call(`/tenants/seller-web/v2/vendor-inventory/vendor-inventory-items-with-vendorItems/${p.vendorInventoryId}?hasProgressiveDiscountRule=true&queryNonVariationJustificationProof=true&queryMpnProof=false`, { method: 'GET' });
      if (r.error) { out.detailError = r; break; } // 상세 오류 시 상세 수집만 중단
      const byItem = new Map((r.json.data || []).map((x) => [String(x.vendorItemId), x]));
      for (const it of p.vendorInventoryItems || []) {
        const x = byItem.get(String(it.vendorItemId));
        if (x) it._detail = {
          productId: x.productId, itemId: x.itemId, originalPrice: x.originalPrice,
          missingRequiredAttributeNames: x.missingRequiredAttributeNames || [],
          cdsSuppressTags: x.cdsSuppressTags || [], hasCdsSuppressed: !!x.hasCdsSuppressed,
        };
      }
      out.detailCount++;
      progress('detail', out.detailCount, targets.length);
    }
    out.detailTargets = targets.length;
  }
  out.finishedAt = new Date().toISOString();
  return out;
}

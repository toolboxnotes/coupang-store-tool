// 순수 로직: WING 검색 결과 정규화, 진단, 스냅샷 비교, CSV, 데모 데이터.
// chrome.* 호출 없음 → Node에서 테스트 가능.

// WING 상품 조회/수정 화면의 노출상태 필터 값 (구버전 호환용)
export const FILTERS = {
  NON_ITEM_WINNER: 'NON_ITEM_WINNER', // 아이템위너 아님
  SUPPRESSED: 'FIX_TO_BOOST_V3',      // 노출제한
  ATTR: 'NON_VALID_VARIATION',        // 상품정보 수정필요
};

// WING 노출상태 코드(displayStatus) → 내부 상태
const STATUS_MAP = {
  ITEM_WINNER: 'WINNER',
  ITEM_LOSER: 'LOSER',
  BUP_SUPPRESSION: 'SUPPRESSED',
  BAP_SUPPRESSION: 'SUPPRESSED',
  ATTRIBUTE_VIOLATION: 'ATTR',
  PENDING: 'PENDING',
  SAVING: 'PENDING',
  DASH: 'NONE',
};

// 쿠팡 위반 유형 코드 → 한국어 (violationTypeDetails.violationType)
export const VIOLATION_LABELS = {
  MOTA_V2: '옵션 필수속성 누락',
  MOTA: '옵션 필수속성 누락',
  MPN: 'GTIN/모델번호 누락',
  GTIN: 'GTIN 누락',
  ATTR: '속성 정보 오류',
  NO_VA_V2: '옵션 구성 오류',
  NON_VALID_VARIATION: '옵션 구성 오류',
  MISSING_OPTION_TABLE_ATTR: '옵션 필수속성 누락',
};
// 위반 사유 코드 (violationReason)
export const REASON_LABELS = { LOW_IMP: '노출 낮음' };

// 문제 유형 정의 (level: 3=심각, 2=주의, 1=참고)
export const ISSUE_DEFS = {
  SUPPRESSED:   { level: 3, label: '노출제한', hint: '아래 위반 사유를 수정한 뒤 수정 승인 요청 (WING 수정 버튼)' },
  ATTR:         { level: 3, label: '상품정보 수정필요', hint: '카테고리 기준에 맞게 옵션 구성·속성 정보 수정' },
  MOTA:         { level: 2, label: '옵션 필수속성 누락', hint: '옵션별 필수 속성(색상·사이즈·수량 등)을 입력 — 미입력 시 노출 낮음' },
  MPN:          { level: 2, label: 'GTIN/모델번호 누락', hint: '바코드(GTIN) 또는 모델번호(품번) 입력 — 미입력 시 노출 낮음' },
  LOSER:        { level: 2, label: '아이템위너 아님(타사)', hint: '동일 상품이면 가격·배송 점검, 상이한 상품이면 「분리 요청 문의 작성」' },
  SELF_LOSER:   { level: 2, label: '자사 상품에 위너 뺏김', hint: '내 다른 상품과 같은 페이지에서 경쟁 중 → 중복 상품 정리 또는 결합 요청' },
  SPLIT:        { level: 2, label: '옵션 분리됨', hint: '같은 등록상품의 옵션이 여러 노출상품으로 나뉨 → 「결합 요청 문의 작성」' },
  NO_BRAND:     { level: 1, label: '브랜드 누락', hint: '브랜드 입력 또는 규정에 맞게 「브랜드 없음」 표기' },
  OUT_OF_STOCK: { level: 1, label: '재고 0', hint: '재고 보충 또는 판매중지 (잦은 품절은 노출 저하 원인)' },
  PRODUCT_ID_CHANGED: { level: 2, label: '노출상품ID 변경', hint: '다른 상품페이지로 결합/매칭되었을 수 있음 → 분리 또는 결합 필요 여부 확인' },
};

// 여러 후보 키 중 첫 번째로 값이 있는 것 반환
const first = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

// 객체 형태 값이면 code/type/status 등에서 스칼라 값 추출
const scalar = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return first(v, ['code', 'type', 'status', 'value', 'name', 'barcode']) ?? '';
  return v;
};
const arr = (v) => (Array.isArray(v) ? v : []);

// 상품의 옵션 배열 (없으면 상품 자체를 1개 옵션으로 취급)
function itemsOf(p) {
  const a = first(p, ['vendorInventoryItems', 'vendorItems', 'items', 'options']);
  return Array.isArray(a) && a.length ? a : [p];
}

// WING productList를 옵션(vendorItem) 단위 행으로 평탄화
// 실제 필드 (2026-11 확인): 상품 = vendorInventoryId, productName, brand, productStatus, vendorId
//                          옵션 = vendorInventoryItems[].vendorItemId, itemName, barcode, valid, stockQuantity, salePrice,
//                                 exposureStatuses[], violationTypeDetails[], _status(노출 상태), _detail(상세)
export function normalize(productList) {
  const rows = [];
  for (const p of productList || []) {
    const sellerProductId = String(scalar(first(p, ['vendorInventoryId', 'sellerProductId'])) || '');
    const productName = String(scalar(first(p, ['productName', 'vendorInventoryName', 'sellerProductName', 'name'])) || '');
    const pBrand = scalar(first(p, ['brand', 'brandName']));
    const categoryCode = String(scalar(first(p, ['displayCategoryCode'])) || '');   // 노출 카테고리 코드 (인기 키워드 조회용)
    const categoryName = String(scalar(first(p, ['categoryName'])) || '');
    const unitSold = Number(scalar(first(p, ['viUnitSoldAgg']))) || 0;                // 상품 판매수량 집계 (WING 제공값)
    for (const it of itemsOf(p)) {
      const st = it._status || {};
      const det = it._detail || {};
      const vendorItemId = String(scalar(first(it, ['vendorItemId', 'vendorInventoryItemId'])) || '');
      const display = String(st.displayStatus || scalar(first(it, ['exposureStatus', 'exposureStatusType'])) || '');
      const stock = first(it, ['stockQuantity', 'quantity']);
      rows.push({
        key: vendorItemId || `${sellerProductId}#${rows.length}`,
        vendorId: String(p.vendorId || ''),
        sellerProductId,
        vendorItemId,
        productId: String(det.productId || scalar(first(it, ['productId'])) || scalar(first(p, ['productId'])) || ''),
        itemId: String(det.itemId || st.productItemId || ''),
        productName,
        itemName: String(scalar(first(it, ['itemName', 'optionName', 'vendorItemName'])) || ''),
        brand: String(scalar(first(it, ['brand', 'brandName'])) || pBrand || ''),
        barcode: String(scalar(first(it, ['barcode'])) || ''),
        externalSku: String(it.externalSkuCode || ''),
        salePrice: Number(scalar(first(it, ['salePrice', 'price']))) || null,
        stock: stock === undefined ? null : Number(scalar(stock)),
        categoryCode, categoryName, unitSold,
        productStatus: String(p.productStatus || ''),   // ON_SALE / PARTIAL_ON_SALE / SUSPENDED
        valid: String(it.valid || ''),                  // VALID / INVALID (INVALID = 판매 불가 옵션)
        exposureRaw: display,
        exposure: STATUS_MAP[display] || '',
        hasStatus: !!it._status,
        hasDetail: !!it._detail,
        winner: st.buyboxWinner === true,
        selfLoser: st.selfLoser === true,
        suppressed: st.suppressed === true || det.hasCdsSuppressed === true,
        suppressedTypes: arr(st.suppressedTypes).concat(arr(det.cdsSuppressTags)).map(String),
        attrViolation: st.attributesViolation === true || it.nonValidVariation === true,
        exposureStatuses: arr(it.exposureStatuses).map(String),
        violations: arr(it.violationTypeDetails).map((v) => ({ type: String(v.violationType || ''), reason: String(v.violationReason || '') })),
        missingAttrs: arr(det.missingRequiredAttributeNames).map(String),
        filterFlags: [],
      });
    }
  }
  return rows;
}

// 판매중지 상품 / 판매 불가(INVALID) 옵션 여부
export const isInactive = (r) => r.productStatus === 'SUSPENDED' || r.valid === 'INVALID';

// WING 자체 필터 결과에 포함된 행 표시 (구버전·데모 호환. 옵션ID 일치하는 행만 표시)
export function applyFilterMembership(rows, filterResults) {
  const flagByFilter = { [FILTERS.SUPPRESSED]: 'SUPPRESSED', [FILTERS.ATTR]: 'ATTR', [FILTERS.NON_ITEM_WINNER]: 'LOSER' };
  const byItem = new Map(rows.map((r) => [r.vendorItemId, r]));
  for (const [filter, res] of Object.entries(filterResults || {})) {
    const flag = flagByFilter[filter];
    if (!flag || !res || !res.list) continue;
    for (const fr of normalize(res.list)) {
      const hit = fr.vendorItemId && byItem.get(fr.vendorItemId);
      if (hit && !hit.filterFlags.includes(flag)) hit.filterFlags.push(flag);
    }
  }
  return rows;
}

// 행별 문제 판정 (쿠팡이 내려준 판정 데이터를 우선 사용)
export function diagnose(rows) {
  // 옵션 분리 감지: 같은 등록상품ID의 옵션들이 서로 다른 노출상품ID를 가진 경우
  const pidsBySeller = new Map();
  for (const r of rows) {
    if (!r.productId || isInactive(r)) continue;
    if (!pidsBySeller.has(r.sellerProductId)) pidsBySeller.set(r.sellerProductId, new Set());
    pidsBySeller.get(r.sellerProductId).add(r.productId);
  }
  for (const r of rows) {
    const issues = new Set(r.filterFlags);
    const vTypes = new Set(r.violations.map((v) => v.type));
    const es = new Set(r.exposureStatuses);
    const reasons = [];

    if (r.exposure === 'SUPPRESSED' || r.suppressed) issues.add('SUPPRESSED');
    if (r.exposure === 'ATTR' || r.attrViolation || es.has('NON_VALID_VARIATION') || vTypes.has('NO_VA_V2') || vTypes.has('ATTR')) issues.add('ATTR');
    if (es.has('MISSING_OPTION_TABLE_ATTR') || vTypes.has('MOTA_V2') || vTypes.has('MOTA')) issues.add('MOTA');
    if (vTypes.has('MPN') || vTypes.has('GTIN')) issues.add('MPN');
    if (r.exposure === 'LOSER') issues.add(r.selfLoser ? 'SELF_LOSER' : 'LOSER');
    if (r.missingAttrs.length) issues.add('ATTR');
    const pids = pidsBySeller.get(r.sellerProductId);
    if (pids && pids.size > 1 && !isInactive(r)) { issues.add('SPLIT'); r.splitCount = pids.size; }
    if (!r.brand) issues.add('NO_BRAND');
    if (r.stock === 0 && !isInactive(r)) issues.add('OUT_OF_STOCK');

    // 위반 사유 (카드·CSV 표시용)
    for (const v of r.violations) reasons.push((VIOLATION_LABELS[v.type] || v.type) + (v.reason ? ` · ${REASON_LABELS[v.reason] || v.reason}` : ''));
    if (r.missingAttrs.length) reasons.push('누락 속성: ' + r.missingAttrs.join(', '));
    if (r.suppressedTypes.length) reasons.push('노출제한 사유: ' + r.suppressedTypes.join(', '));
    if (r.splitCount) reasons.push(`노출상품 ${r.splitCount}개로 분리`);
    r.reasons = [...new Set(reasons)];

    r.issues = [...issues].sort((a, b) => ISSUE_DEFS[b].level - ISSUE_DEFS[a].level);
    r.level = r.issues.length ? ISSUE_DEFS[r.issues[0]].level : 0;
  }
  return rows;
}

// 요약 통계
export function summarize(rows) {
  const counts = {};
  for (const k of Object.keys(ISSUE_DEFS)) counts[k] = 0;
  for (const r of rows) for (const i of r.issues || []) counts[i]++;
  return {
    products: new Set(rows.map((r) => r.sellerProductId)).size,
    items: rows.length,
    healthy: rows.filter((r) => !r.issues.length).length,
    critical: rows.filter((r) => r.level === 3).length,
    ignored: rows.reduce((n, r) => n + ((r.ignoredIssues && r.ignoredIssues.length) || 0), 0), // 무시된 문제 수
    counts,
  };
}

// ── 무시 기능 ─────────────────────────────────────────────
// 무시 키 = 옵션ID + 문제 유형. 같은 옵션에서 같은 문제가 다시 발생해도 계속 무시됨.
// 다른 유형의 문제가 새로 생기면 무시되지 않고 정상적으로 표시됨.
export const ignoreKey = (r, issue) => `${r.vendorItemId || r.key}|${issue}`;

// 무시 목록 저장용 메타 정보 (상품이 목록에서 사라져도 무시 목록에 표시할 수 있도록)
export function ignoreEntry(r, issue) {
  return {
    issue, at: new Date().toISOString(),
    sellerProductId: r.sellerProductId, vendorItemId: r.vendorItemId, productId: r.productId,
    productName: r.productName, itemName: r.itemName,
  };
}

// 무시 여부: 옵션별 무시(ignores) 또는 유형 전체 무시 규칙(ignoreTypes)
export const isIgnored = (r, issue, ignores = {}, ignoreTypes = {}) => !!(ignoreTypes[issue] || ignores[ignoreKey(r, issue)]);

// 무시 적용: issues = 처리 대상 문제, ignoredIssues = 무시된 문제 (원본 행은 변경하지 않음)
// ignoreTypes = { 문제유형: { at } } → 모든 상품(이후 새로 생기는 상품 포함)에서 해당 유형 무시
export function applyIgnores(rows, ignores = {}, ignoreTypes = {}) {
  return rows.map((r) => {
    const issues = r.issues.filter((i) => !isIgnored(r, i, ignores, ignoreTypes));
    const ignoredIssues = r.issues.filter((i) => isIgnored(r, i, ignores, ignoreTypes));
    return { ...r, issues, ignoredIssues, level: issues.length ? ISSUE_DEFS[issues[0]].level : 0 };
  });
}

// 무시 목록 + 최신 점검에서의 현재 상태 (present: 지금도 발생 중인지)
export function ignoredList(ignores = {}, rows = []) {
  const byKey = new Map(rows.map((r) => [r.vendorItemId || r.key, r]));
  return Object.entries(ignores)
    .filter(([, e]) => e && ISSUE_DEFS[e.issue])
    .map(([key, e]) => {
      const row = byKey.get(key.slice(0, key.lastIndexOf('|')));
      return { key, ...e, ...(row ? { productId: row.productId || e.productId, productName: row.productName || e.productName } : {}), present: !!(row && row.issues.includes(e.issue)) };
    })
    .sort((a, b) => (b.present - a.present) || ISSUE_DEFS[b.issue].level - ISSUE_DEFS[a.issue].level || String(b.at).localeCompare(String(a.at)));
}

// 이전 스냅샷과 현재 스냅샷 비교 (진단 완료된 행 배열)
export function diffSnapshots(prev, curr) {
  const changes = [];
  if (!prev) return changes;
  const pm = new Map(prev.map((r) => [r.key, r]));
  const cm = new Map(curr.map((r) => [r.key, r]));
  for (const r of curr) {
    const o = pm.get(r.key);
    if (!o) { changes.push({ type: 'NEW_ITEM', row: r }); continue; }
    // 노출상품ID 변경 = 결합/매칭 의심
    if (o.productId && r.productId && o.productId !== r.productId) {
      changes.push({ type: 'PRODUCT_ID_CHANGED', row: r, from: o.productId, to: r.productId });
      if (!r.issues.includes('PRODUCT_ID_CHANGED')) {
        r.issues.push('PRODUCT_ID_CHANGED');
        r.issues.sort((a, b) => ISSUE_DEFS[b].level - ISSUE_DEFS[a].level);
      }
      r.level = Math.max(r.level, ISSUE_DEFS.PRODUCT_ID_CHANGED.level);
    }
    for (const i of r.issues) if (i !== 'PRODUCT_ID_CHANGED' && !o.issues.includes(i)) changes.push({ type: 'ISSUE_NEW', row: r, issue: i });
    for (const i of o.issues) if (i !== 'PRODUCT_ID_CHANGED' && !r.issues.includes(i)) changes.push({ type: 'ISSUE_RESOLVED', row: r, issue: i });
  }
  for (const o of prev) if (!cm.has(o.key)) changes.push({ type: 'REMOVED_ITEM', row: o });
  return changes;
}

// 쿠팡에서 고객에게 보이는 옵션인지 (아이템위너/위너 아님 상태만 상품 페이지에 노출됨)
// 노출제한(BUP/BAP_SUPPRESSION)·상품정보 수정필요·미노출(DASH) 옵션의 옵션ID로는 상품 페이지가 열리지 않음
export const isDisplayed = (r) => r.exposure === 'WINNER' || r.exposure === 'LOSER';

// 노출상품ID별로 링크에 쓸 「현재 노출 중인 옵션ID」 색인 (아이템위너 우선)
export function buildLinkIndex(rows) {
  const idx = new Map();
  for (const r of rows || []) {
    if (!r.productId || !r.vendorItemId || !isDisplayed(r)) continue;
    const cur = idx.get(r.productId);
    if (!cur || (cur.exposure !== 'WINNER' && r.exposure === 'WINNER')) idx.set(r.productId, { vendorItemId: r.vendorItemId, exposure: r.exposure });
  }
  return idx;
}

// 행에서 이동할 링크 생성
// - coupang: 실제 쿠팡 상품 페이지 /vp/products/{노출상품ID}?vendorItemId={옵션ID}
//            이 옵션이 노출 중이면 이 옵션ID, 아니면 같은 상품 페이지에서 노출 중인 다른 옵션ID 사용
//            같은 페이지에 노출 중인 옵션이 없으면 링크 없음 (coupangHidden = true)
// - search:  쿠팡 검색 결과 (상품명으로 검색 → 노출 순위·경쟁 상품 확인용)
// - wing:    WING 상품 수정 화면 (등록상품ID)  / wingList: WING 상품 조회 목록에서 검색
export function productLinks(r, linkIndex) {
  const digits = (v) => (/^\d+$/.test(String(v || '')) ? String(v) : '');
  const pid = digits(r.productId);
  const vid = digits(r.vendorItemId);
  const sid = digits(r.sellerProductId);
  const q = (r.productName || '').trim();
  let useVid = '', viaOther = false, coupangHidden = false;
  if (pid) {
    if (!linkIndex || isDisplayed(r)) useVid = vid; // 색인이 없으면(구버전 호출) 기존 방식
    else {
      const alt = linkIndex.get(pid);
      if (alt) { useVid = digits(alt.vendorItemId); viaOther = useVid !== vid; }
      else coupangHidden = true;
    }
  }
  return {
    coupang: pid && !coupangHidden ? `https://www.coupang.com/vp/products/${pid}${useVid ? `?vendorItemId=${useVid}` : ''}` : '',
    viaOther,       // true = 이 옵션은 미노출이라 같은 페이지의 다른 옵션으로 연결
    coupangHidden,  // true = 이 상품 페이지 전체가 쿠팡에 노출되지 않음
    search: q ? `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` : '',
    wing: wingModifyUrl(sid),                                                                         // 상품 수정 화면 직접
    wingList: sid ? `https://wing.coupang.com/vendor-inventory/list?searchKeywordType=ALL&searchKeywords=${sid}` : '', // 상품 조회 목록
  };
}

// WING 온라인 문의 (helpseller.coupangcorp.com 으로 이동됨)
export const WING_QNA_URL = 'https://wing.coupang.com/partner/qna/faq/list';
// 온라인 문의 작성: 요청 유형 「[마켓플레이스/로켓그로스] 상품 정보가 잘못 노출되고 있습니다.」
export const INQUIRY_FORM_URL = 'https://helpseller.coupangcorp.com/hc/ko/requests/new?ticket_form_id=360000651672';

// WING 상품 수정 화면 (등록상품 단위)
export const wingModifyUrl = (sellerProductId) =>
  /^\d+$/.test(String(sellerProductId || '')) ? `https://wing.coupang.com/tenants/seller-web/vendor-inventory/modify?vendorInventoryId=${sellerProductId}` : '';

// 온라인 문의 폼 자동 입력용 데이터 (content/inquiry-fill.js 가 사용)
// kind: 'sep' = 상이한 상품 분리, 'merge' = 옵션 결합
export function inquiryPayload(kind, rows) {
  const r0 = rows[0];
  const req = kind === 'merge' ? mergeRequest(rows) : separationRequest(r0);
  const pids = [...new Set(rows.map((r) => r.productId).filter(Boolean))];
  return {
    kind,
    subject: req.title,
    description: req.body,
    optionName: kind === 'merge' ? rows.map((r) => r.itemName || r.vendorItemId).join(', ') : (r0.itemName || r0.vendorItemId),
    productId: kind === 'merge' ? pids.join(', ') : (r0.productId || ''),
    productName: r0.productName,
    vendorId: r0.vendorId,
    text: req.text,
    createdAt: Date.now(),
  };
}

// ── 온라인 문의 요청서 (A5 분리 / A6 결합) ──
// 상이한 상품과 잘못 매칭된 옵션의 분리 요청서
export function separationRequest(r) {
  const title = `[상이한 상품 분리 요청] 옵션ID ${r.vendorItemId}`;
  const body = [
    '안녕하세요.',
    '아래 옵션이 상이한 상품과 잘못 결합(매칭)되어 있어 분리를 요청드립니다.',
    '',
    `- 업체코드: ${r.vendorId || '(업체코드)'}`,
    `- 등록상품ID: ${r.sellerProductId}`,
    `- 옵션ID: ${r.vendorItemId}`,
    `- 노출상품ID: ${r.productId || '(확인 필요)'}`,
    `- 상품명: ${r.productName}${r.itemName ? ` / 옵션: ${r.itemName}` : ''}`,
    `- 브랜드: ${r.brand || '-'}`,
    `- 판매자상품코드: ${r.externalSku || '-'}`,
    '',
    '상이한 점: (브랜드 / 모델번호 / 구성·수량 / 사양 중 다른 점을 구체적으로 적어주세요)',
    '',
    '증빙 자료(상품 사진, 상표권 등록증 등)를 첨부합니다.',
    '확인 후 분리 부탁드립니다. 감사합니다.',
  ].join('\n');
  return { title, body, text: `${title}\n\n${body}` };
}

// 여러 노출상품으로 나뉜 같은 등록상품의 옵션 결합 요청서
export function mergeRequest(rows) {
  const r0 = rows[0];
  const byPid = new Map();
  for (const r of rows) {
    const k = r.productId || '(미확인)';
    if (!byPid.has(k)) byPid.set(k, []);
    byPid.get(k).push(r.itemName || r.vendorItemId);
  }
  const title = `[옵션 결합 요청] 등록상품ID ${r0.sellerProductId}`;
  const body = [
    '안녕하세요.',
    '동일한 상품의 옵션이 여러 노출상품(상품 페이지)으로 분리되어 있어 하나의 상품 페이지로 결합을 요청드립니다.',
    '',
    `- 업체코드: ${r0.vendorId || '(업체코드)'}`,
    `- 등록상품ID: ${r0.sellerProductId}`,
    `- 상품명: ${r0.productName}`,
    `- 브랜드: ${r0.brand || '-'}`,
    '- 현재 분리 상태:',
    ...[...byPid.entries()].map(([pid, names]) => `  · 노출상품ID ${pid}: ${names.join(', ')}`),
    '',
    '모두 같은 브랜드·모델의 옵션(색상/사이즈/수량 차이)입니다. 확인 후 결합 부탁드립니다. 감사합니다.',
  ].join('\n');
  return { title, body, text: `${title}\n\n${body}` };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// 문제 목록 CSV (엑셀에서 한글이 깨지지 않도록 BOM 포함)
export function toCSV(rows) {
  const head = ['심각도', '문제', '상세 사유', '조치 방법', '등록상품ID', '옵션ID', '노출상품ID', '상품명', '옵션명', '브랜드', '바코드', '판매자상품코드', '판매가', '재고', '판매상태', '노출상태코드'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.level, r.issues.map((i) => ISSUE_DEFS[i].label).join(' / '), (r.reasons || []).join(' / '), r.issues.map((i) => ISSUE_DEFS[i].hint).join(' | '),
      r.sellerProductId, r.vendorItemId, r.productId, r.productName, r.itemName, r.brand, r.barcode, r.externalSku,
      r.salePrice ?? '', r.stock ?? '', r.productStatus, r.exposureRaw,
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// 상품이 없는 계정에서 화면을 체험하기 위한 데모 데이터 (실제 WING 응답 구조를 모방)
export function demoScan(seed = 1) {
  const brands = ['데모브랜드', '', '데모브랜드', '데일리홈', '데모브랜드'];
  const display = ['ITEM_WINNER', 'ITEM_WINNER', 'ITEM_LOSER', 'ITEM_WINNER', 'ATTRIBUTE_VIOLATION', 'ITEM_WINNER'];
  const viol = [null, [{ violationType: 'MOTA_V2', violationReason: 'LOW_IMP' }], null, [{ violationType: 'MPN', violationReason: 'LOW_IMP' }], null, null, [{ violationType: 'NO_VA_V2', violationReason: null }]];
  const list = [];
  for (let i = 0; i < 12; i++) {
    const items = [];
    const n = 1 + (i % 3);
    for (let j = 0; j < n; j++) {
      const k = i * 3 + j;
      const ds = display[(k + seed) % display.length];
      const v = viol[(k + seed) % viol.length];
      items.push({
        vendorItemId: 80000000000 + k,
        itemName: `옵션 ${j + 1}`,
        externalSkuCode: `DEMO-${k}`,
        barcode: k % 4 === 0 ? '' : `880${String(1000000000 + k)}`,
        valid: i === 11 ? 'INVALID' : 'VALID',
        salePrice: 9900 + k * 1000,
        stockQuantity: k % 7 === 0 ? 0 : 20 + k,
        exposureStatuses: v && v[0].violationType === 'MOTA_V2' ? ['MISSING_OPTION_TABLE_ATTR'] : [],
        violationTypeDetails: v,
        _status: { displayStatus: ds, buyboxWinner: ds === 'ITEM_WINNER', selfLoser: ds === 'ITEM_LOSER' && i === 4, suppressed: false, suppressedTypes: [], attributesViolation: ds === 'ATTRIBUTE_VIOLATION', productItemId: 20000000000 + k },
        _detail: {
          // 상품 5는 옵션이 두 노출상품으로 분리된 예시, 상품 3은 2회차 점검에서 노출상품ID 변경
          productId: 7000000000 + i + (i === 5 && j === 2 ? 500 : 0) + (seed > 1 && i === 2 ? 99 : 0),
          itemId: 20000000000 + k,
          missingRequiredAttributeNames: k === 4 ? ['색상', '수량'] : [],
          cdsSuppressTags: [], hasCdsSuppressed: k === 9,
        },
      });
    }
    const cats = [[82224, '낚시찌'], [82205, '낚시 소품'], [82224, '낚시찌'], [82061, '낚시 공구']];
    const [cc, cn] = cats[i % cats.length];
    list.push({ vendorInventoryId: 15000000 + i, vendorId: 'A00000000', productName: `데모 상품 ${i + 1}`, brand: brands[i % brands.length], displayCategoryCode: cc, categoryName: cn, viUnitSoldAgg: (i * 7) % 30, productStatus: i === 10 ? 'SUSPENDED' : 'ON_SALE', vendorInventoryItems: items });
  }
  return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), demo: true, all: { list, totalCount: list.length }, filters: {}, detailCount: list.length, detailTargets: list.length };
}

// core.js 로직 테스트: node tests/core.test.mjs
import {
  normalize, applyFilterMembership, diagnose, summarize, diffSnapshots, toCSV, demoScan, isInactive,
  ignoreKey, ignoreEntry, applyIgnores, ignoredList, isIgnored, productLinks, buildLinkIndex, inquiryPayload, wingModifyUrl, separationRequest, mergeRequest,
} from '../lib/core.js';
import assert from 'node:assert/strict';

// 실제 WING 응답 구조 (2026-11 확인, 값은 가공)
const real = [{
  vendorInventoryId: 15641481102, vendorId: 'A00000001', productName: '실제구조 상품', brand: '브랜드A', productStatus: 'ON_SALE',
  vendorInventoryItems: [
    { vendorItemId: 92986189240, itemName: '레드', barcode: '', valid: 'VALID', stockQuantity: 949, salePrice: 1090, externalSkuCode: 'PSG200',
      exposureStatuses: null, violationTypeDetails: null,
      _status: { displayStatus: 'ITEM_LOSER', buyboxWinner: false, selfLoser: false, productItemId: 24076170113 },
      _detail: { productId: 7748870624, itemId: 24076170113, missingRequiredAttributeNames: [], cdsSuppressTags: [] } },
    { vendorItemId: 92986189179, itemName: '블루', barcode: '', valid: 'VALID', stockQuantity: 0, salePrice: 1090,
      exposureStatuses: ['MISSING_OPTION_TABLE_ATTR'], violationTypeDetails: [{ violationType: 'MOTA_V2', violationReason: 'LOW_IMP' }, { violationType: 'MPN', violationReason: 'LOW_IMP' }],
      _status: { displayStatus: 'ITEM_LOSER', buyboxWinner: false, selfLoser: true },
      _detail: { productId: 8904324850, itemId: 26004096960, missingRequiredAttributeNames: ['색상'], cdsSuppressTags: [] } },
    { vendorItemId: 1, itemName: '판매불가', valid: 'INVALID', stockQuantity: 0, _status: { displayStatus: 'DASH' } },
  ],
}, {
  vendorInventoryId: 2, productName: '판매중지 상품', brand: '', productStatus: 'SUSPENDED',
  vendorInventoryItems: [{ vendorItemId: 3, valid: 'INVALID', stockQuantity: 0, _status: { displayStatus: 'DASH' } }],
}];
const all = normalize(real);
assert.equal(all.length, 4);
const active = all.filter((r) => !isInactive(r));
assert.equal(active.length, 2, '판매중지·INVALID 제외');
const rr = diagnose(active);
const [a1, a2] = rr;
assert.equal(a1.productId, '7748870624');
assert.equal(a1.itemId, '24076170113');
assert.deepEqual(a1.issues.sort(), ['LOSER', 'SPLIT'].sort(), JSON.stringify(a1.issues));
assert.ok(a2.issues.includes('SELF_LOSER') && a2.issues.includes('MOTA') && a2.issues.includes('MPN') && a2.issues.includes('ATTR') && a2.issues.includes('SPLIT') && a2.issues.includes('OUT_OF_STOCK'), JSON.stringify(a2.issues));
assert.ok(!a2.issues.includes('LOSER'));
assert.ok(a2.reasons.includes('옵션 필수속성 누락 · 노출 낮음') && a2.reasons.includes('누락 속성: 색상') && a2.reasons.includes('노출상품 2개로 분리'), JSON.stringify(a2.reasons));
assert.ok(!a1.issues.includes('NO_BRAND'));
// 판매중지 포함 시 OUT_OF_STOCK은 비활성 옵션에 붙지 않음
assert.ok(!diagnose(normalize(real)).find((r) => r.vendorItemId === '3').issues.includes('OUT_OF_STOCK'));

// 링크
const L = productLinks(a1);
assert.equal(L.coupang, 'https://www.coupang.com/vp/products/7748870624?vendorItemId=92986189240');
assert.equal(L.wing, 'https://wing.coupang.com/tenants/seller-web/vendor-inventory/modify?vendorInventoryId=15641481102');
assert.ok(L.wingList.endsWith('searchKeywords=15641481102'));
assert.equal(wingModifyUrl('x'), '');
const L2 = productLinks({ productId: '', vendorItemId: 'x<y', productName: '' });
assert.equal(L2.coupang, ''); assert.equal(L2.search, ''); assert.equal(L2.wing, '');

// 쿠팡 링크: 실제 사례 (2026-11-16 확인)
// 같은 노출상품 8521745748에서 92180833559(ITEM_WINNER)는 열리고 92180833564(BAP_SUPPRESSION)는 열리지 않음
const caseRows = diagnose(normalize([{ vendorInventoryId: 15452657801, productName: '사례', brand: 'B', productStatus: 'ON_SALE', vendorInventoryItems: [
  { vendorItemId: 92180833559, valid: 'VALID', stockQuantity: 5, _status: { displayStatus: 'ITEM_WINNER' }, _detail: { productId: 8521745748 } },
  { vendorItemId: 92180833564, valid: 'VALID', stockQuantity: 5, _status: { displayStatus: 'BAP_SUPPRESSION' }, _detail: { productId: 8521745748 } },
  { vendorItemId: 92180833999, valid: 'VALID', stockQuantity: 5, _status: { displayStatus: 'ATTRIBUTE_VIOLATION' }, _detail: { productId: 9999999999 } },
] }]));
const LI = buildLinkIndex(caseRows);
const [okRow, supRow, hidRow] = caseRows;
assert.equal(productLinks(okRow, LI).coupang, 'https://www.coupang.com/vp/products/8521745748?vendorItemId=92180833559');
const sl = productLinks(supRow, LI);
assert.equal(sl.coupang, 'https://www.coupang.com/vp/products/8521745748?vendorItemId=92180833559', '노출제한 옵션은 같은 페이지의 노출 옵션으로 연결');
assert.equal(sl.viaOther, true);
const hl = productLinks(hidRow, LI);
assert.equal(hl.coupang, ''); assert.equal(hl.coupangHidden, true);
// 무시 목록 항목(노출 상태 없음)도 색인으로 연결
assert.equal(productLinks({ productId: '8521745748', vendorItemId: '92180833564' }, LI).coupang, 'https://www.coupang.com/vp/products/8521745748?vendorItemId=92180833559');

// 요청서
const sep = separationRequest(a1);
assert.ok(sep.title.includes('92986189240') && sep.body.includes('업체코드: A00000001') && sep.body.includes('노출상품ID: 7748870624'));
const mg = mergeRequest(rr);
assert.ok(mg.body.includes('노출상품ID 7748870624: 레드') && mg.body.includes('노출상품ID 8904324850: 블루'));

// 온라인 문의 자동 입력 데이터
const ps = inquiryPayload('sep', [a1]);
assert.equal(ps.optionName, '레드'); assert.equal(ps.productId, '7748870624'); assert.equal(ps.vendorId, 'A00000001');
assert.ok(ps.subject.startsWith('[상이한 상품 분리 요청]') && ps.description.includes('옵션ID: 92986189240'));
const pm = inquiryPayload('merge', rr);
assert.equal(pm.optionName, '레드, 블루'); assert.equal(pm.productId, '7748870624, 8904324850');
assert.ok(pm.subject.startsWith('[옵션 결합 요청]'));

// 데모 데이터 + 스냅샷 비교
const run = (seed) => {
  const raw = demoScan(seed);
  return diagnose(applyFilterMembership(normalize(raw.all.list).filter((r) => !isInactive(r)), raw.filters));
};
const a = run(1), b = run(2);
const s = summarize(a);
console.log('summary', s);
assert.equal(s.products, 10);
for (const k of ['ATTR', 'MOTA', 'MPN', 'LOSER', 'SELF_LOSER', 'SPLIT', 'NO_BRAND', 'OUT_OF_STOCK', 'SUPPRESSED']) assert.ok(s.counts[k] > 0, k);
const ch = diffSnapshots(a, b);
const types = ch.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {});
console.log('changes', types);
assert.ok(types.PRODUCT_ID_CHANGED >= 1 && types.ISSUE_NEW >= 1 && types.ISSUE_RESOLVED >= 1);

// 무시 기능: 같은 옵션·같은 문제는 다음 점검에서도 계속 무시, 다른 문제는 표시
const r0 = b.find((r) => r.issues.length >= 2);
const ign = { [ignoreKey(r0, r0.issues[0])]: ignoreEntry(r0, r0.issues[0]) };
const v1 = applyIgnores(b, ign).find((r) => r.key === r0.key);
assert.deepEqual(v1.ignoredIssues, [r0.issues[0]]);
assert.equal(v1.issues.length, r0.issues.length - 1);
assert.equal(summarize(applyIgnores(b, ign)).ignored, 1);
const il = ignoredList(ign, run(2));
assert.equal(il.length, 1); assert.equal(il[0].present, true);
assert.equal(ignoredList(ign, [])[0].present, false);
// 알 수 없는(삭제된) 유형의 무시 항목은 목록에서 제외
assert.equal(ignoredList({ 'x|NO_ID': { issue: 'NO_ID' } }, []).length, 0);
// 유형 전체 무시
const tv = applyIgnores(b, {}, { NO_BRAND: { at: 'x' } });
assert.ok(tv.every((r) => !r.issues.includes('NO_BRAND')));
assert.equal(summarize(tv).ignored, summarize(b).counts.NO_BRAND);
assert.ok(isIgnored({ vendorItemId: '1' }, 'MPN', {}, { MPN: {} }));

const csv = toCSV(a.filter((r) => r.issues.length));
assert.ok(csv.startsWith('﻿') && csv.split('\r\n')[0].includes('상세 사유'));
console.log(csv.split('\r\n').slice(0, 3).join('\n'));
console.log('모든 테스트 통과');

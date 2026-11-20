// 쿠팡 판매자 온라인 문의(helpseller.coupangcorp.com) 작성 화면 자동 입력
// - 사이드 패널의 「문의 작성」 버튼이 chrome.storage.local.pendingInquiry 에 요청서를 저장하고 이 페이지를 연다
// - 이 스크립트는 라벨 텍스트로 입력칸을 찾아 값을 채우고, 안내 배너를 띄운다
// - 확인 체크박스·첨부 파일·제출은 절대 자동으로 하지 않는다 (사용자가 직접)
(() => {
  const MAX_AGE_MS = 10 * 60 * 1000; // 10분 이내에 만든 요청서만 사용
  const FORM_ID = '360000651672';    // [마켓플레이스/로켓그로스] 상품 정보가 잘못 노출되고 있습니다.

  // 라벨 텍스트 → 입력칸 찾기 (for 속성, 같은 필드 묶음, aria-label 순서로 시도)
  function findField(labelText) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const labels = [...document.querySelectorAll('label')];
    const label = labels.find((l) => norm(l.textContent) === labelText) || labels.find((l) => norm(l.textContent).startsWith(labelText));
    if (label) {
      if (label.htmlFor) {
        const el = document.getElementById(label.htmlFor);
        if (el) return el;
      }
      const box = label.closest('.form-field, [class*="field"], div');
      const el = box && box.querySelector('input[type="text"], input:not([type]), textarea');
      if (el) return el;
    }
    return document.querySelector(`[aria-label="${labelText}"]`);
  }

  // React 등에서 관리하는 입력칸도 값이 반영되도록 네이티브 setter + 이벤트 사용
  function setValue(el, value) {
    if (!el || value === undefined || value === null) return false;
    // 설명칸이 리치 텍스트 편집기(숨겨진 textarea + contenteditable)인 경우 편집기에도 입력
    if (el.tagName === 'TEXTAREA' && el.offsetParent === null) {
      const box = el.closest('.form-field, [class*="field"], div');
      const editor = box && box.querySelector('[contenteditable="true"]');
      if (editor) {
        editor.focus();
        editor.innerText = String(value);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function banner(html, ok) {
    const old = document.getElementById('cst-banner');
    if (old) old.remove();
    const div = document.createElement('div');
    div.id = 'cst-banner';
    div.style.cssText = `position:fixed;top:12px;right:12px;z-index:2147483647;max-width:420px;padding:12px 14px;border-radius:8px;
      font:13px/1.5 "Malgun Gothic",sans-serif;color:#1d2129;background:${ok ? '#eaf2ff' : '#fff4e5'};border:1px solid ${ok ? '#2f6bff' : '#f08c00'};box-shadow:0 4px 16px rgba(0,0,0,.15)`;
    div.innerHTML = `<b>coupang-store-tool</b><br>${html}<div style="text-align:right;margin-top:6px"><button type="button" style="border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 10px;cursor:pointer">닫기</button></div>`;
    div.querySelector('button').onclick = () => div.remove();
    document.body.appendChild(div);
  }

  async function run() {
    let data;
    try { data = await chrome.storage.local.get('pendingInquiry'); } catch (e) { return; }
    const req = data && data.pendingInquiry;
    if (!req || Date.now() - (req.createdAt || 0) > MAX_AGE_MS) return; // 확장에서 시작한 문의가 아니면 아무것도 하지 않음

    // 요청 유형이 선택되지 않은 화면이면 안내만
    if (!location.search.includes(`ticket_form_id=${FORM_ID}`) && !findField('옵션명')) {
      banner('요청 유형에서 <b>「[마켓플레이스/로켓그로스] 상품 정보가 잘못 노출되고 있습니다.」</b>를 선택하면 자동 입력됩니다.', false);
      return;
    }

    // 입력칸이 그려질 때까지 최대 15초 대기
    let tries = 0;
    while (!findField('옵션명') && tries < 30) { await new Promise((r) => setTimeout(r, 500)); tries++; }

    const fields = [
      ['제목', req.subject],
      ['설명', req.description],
      ['옵션명', req.optionName],
      ['상품 ID (Product ID)', req.productId],
      ['상품명', req.productName],
      ['판매자 코드(Vendor ID)', req.vendorId],
    ];
    const filled = [], missed = [];
    for (const [label, value] of fields) {
      if (!value) continue;
      (setValue(findField(label), value) ? filled : missed).push(label);
    }
    await chrome.storage.local.remove('pendingInquiry'); // 한 번만 사용

    const kind = req.kind === 'merge' ? '옵션 결합' : '상이한 상품 분리';
    banner(
      `<b>${kind}</b> 요청서를 자동 입력했습니다: ${filled.join(', ') || '없음'}` +
      (missed.length ? `<br><span style="color:#c00">입력칸을 찾지 못함: ${missed.join(', ')} (클립보드에 복사된 내용을 붙여넣으세요)</span>` : '') +
      '<br><br>제출 전에 직접 해주세요:<br>① 설명의 <b>「상이한 점」</b> 작성 (분리 요청인 경우)<br>② 상단 확인 체크박스 확인·체크<br>③ 증빙 사진·상표권 등 첨부<br>④ 내용 확인 후 제출',
      missed.length === 0,
    );
  }

  run();
})();

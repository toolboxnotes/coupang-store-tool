// 사이드 패널 UI: 요약 / 문제 목록(처리 대상·무시 목록) / 변경 내역 / 설정
import { ISSUE_DEFS, toCSV, productLinks, ignoreKey, ignoreEntry, applyIgnores, ignoredList, summarize, isIgnored, inquiryPayload, INQUIRY_FORM_URL, buildLinkIndex } from './lib/core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { hour12: false }) : '-');
$('ver').textContent = 'v' + chrome.runtime.getManifest().version; // 헤더에 버전 표시

let current = null;   // 최신 스냅샷
let ignores = {};     // 옵션별 무시 { 무시키: 메타 정보 }
let ignoreTypes = {}; // 유형 전체 무시 규칙 { 문제유형: { at } }
const selected = new Set(); // 일괄 무시용 선택된 행 key
let view = [];        // 무시가 적용된 행 (issues = 처리 대상, ignoredIssues = 무시됨)
let viewSummary = null;
let linkIndex = new Map(); // 노출상품ID → 노출 중인 옵션ID (쿠팡 링크용)
let mode = 'active';  // 문제 목록 표시 모드: active(처리 대상) / ignored(무시 목록)
let shown = 100;      // 표시 개수
let adSpend = new Map(); // 옵션ID → { spend, sales, campaigns } (최근 광고 점검의 광고 중인 문제 상품)

// ── 탭 전환 ──
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// 「상품」 탭 = 문제 목록 / 변경 내역 (하위 전환)
let lastProd = 'issues';
function switchTab(name) {
  if (name === 'product') name = lastProd;
  const group = name === 'issues' || name === 'changes' ? 'product' : name;
  if (group === 'product') lastProd = name;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === group));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${name}`));
  document.querySelectorAll('.prodSeg button').forEach((x) => x.classList.toggle('on', x.dataset.psub === name));
}
document.querySelectorAll('.prodSeg button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.psub)));
window.switchTab = switchTab; // 다른 패널(요약 할 일)에서 사용
function setMode(m) {
  mode = m; shown = 100; selected.clear();
  $('modeActive').classList.toggle('on', m === 'active');
  $('modeIgnored').classList.toggle('on', m === 'ignored');
  renderIssues();
}
$('modeActive').addEventListener('click', () => setMode('active'));
$('modeIgnored').addEventListener('click', () => setMode('ignored'));

for (const [k, d] of Object.entries(ISSUE_DEFS)) $('issueFilter').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(d.label)}</option>`);
$('issueFilter').insertAdjacentHTML('beforeend', '<option value="__AD">광고 중인 문제 (광고비 발생)</option>');
for (let h = 0; h < 24; h++) $('scanHour').insertAdjacentHTML('beforeend', `<option value="${h}">${h}</option>`);

// ── 버튼 ──
$('scanBtn').addEventListener('click', async () => {
  $('scanBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'scan' });
  $('scanBtn').disabled = false;
});
$('issueFilter').addEventListener('change', () => { shown = 100; selected.clear(); renderIssues(); });
$('search').addEventListener('input', () => { shown = 100; selected.clear(); renderIssues(); });

// ── 일괄 무시 ──
// 전체 선택: 현재 필터·검색 결과 전체 (화면에 아직 안 보이는 「더 보기」 항목 포함)
$('selAll').addEventListener('change', () => {
  selected.clear();
  if ($('selAll').checked) for (const r of filteredRows()) selected.add(r.key);
  renderIssues();
});
// 선택 항목 무시: 유형 필터가 선택돼 있으면 그 유형만, 아니면 선택한 옵션의 현재 문제 전부
$('ignoreSel').addEventListener('click', async () => {
  const f = ISSUE_DEFS[$('issueFilter').value] ? $('issueFilter').value : '';   // 「광고 중인 문제」 필터는 유형이 아님
  const rows = filteredRows().filter((r) => selected.has(r.key));
  if (!rows.length) return;
  const what = f ? `「${ISSUE_DEFS[f].label}」 문제` : '현재 문제 전부';
  if (!confirm(`선택한 ${rows.length}개 옵션의 ${what}를 무시할까요?\n같은 옵션의 같은 문제는 이후 점검에서도 계속 무시됩니다.`)) return;
  for (const r of rows) for (const i of (f ? [f] : r.issues)) ignores[ignoreKey(r, i)] = ignoreEntry(r, i);
  selected.clear();
  await saveIgnores();
});
// 유형 전체 무시 규칙: 모든 상품(이후 새 상품 포함)에서 이 유형 무시
$('ignoreType').addEventListener('click', async () => {
  const f = $('issueFilter').value;
  if (!f || !ISSUE_DEFS[f]) return;
  if (!confirm(`「${ISSUE_DEFS[f].label}」 유형을 모든 상품에서 무시할까요?\n이후 새로 생기는 상품에도 적용되며, 무시 목록의 「유형 무시 규칙」에서 해제할 수 있습니다.`)) return;
  ignoreTypes[f] = { at: new Date().toISOString() };
  selected.clear();
  await chrome.storage.local.set({ ignoreTypes });
});
$('exportBtn').addEventListener('click', () => {
  if (!current) return;
  const date = current.at.slice(0, 10);
  if (mode === 'active') download(`coupang-store-tool_${date}.csv`, toCSV(filteredRows()), 'text/csv;charset=utf-8');
  else download(`coupang-store-tool_무시목록_${date}.csv`, toCSV(filteredIgnored().map((e) => ({ ...e, issues: [e.issue], level: ISSUE_DEFS[e.issue].level }))), 'text/csv;charset=utf-8');
});
$('exportSample').addEventListener('click', () => {
  if (!current || !current.sample) return alert('샘플이 없습니다. 실제 모드에서 먼저 한 번 점검하세요.');
  download('coupang-store-tool_sample.json', JSON.stringify(current.sample, null, 2), 'application/json');
});
$('saveSettings').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'saveSettings',
    settings: {
      autoScan: $('autoScan').checked, adsReminder: $('adsReminder').checked, scanHour: Number($('scanHour').value), notify: $('notify').checked,
      demoMode: $('demoMode').checked, delayMs: Math.max(1500, Number($('delayMs').value) || 2000), adsDelayMs: Math.max(3000, Number($('adsDelayMs').value) || 4000),
      excludeInactive: $('excludeInactive').checked, collectDetail: $('collectDetail').checked,
    },
  });
  $('saveSettings').textContent = '저장됨 ✓';
  setTimeout(() => ($('saveSettings').textContent = '설정 저장'), 1500);
});
$('clearData').addEventListener('click', async () => {
  if (!confirm('모든 점검 기록을 삭제할까요? (무시 목록은 유지됩니다)')) return;
  await chrome.runtime.sendMessage({ type: 'clearData' });
  load();
});

// 파일 다운로드
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 무시 목록 저장 ──
async function saveIgnores() {
  await chrome.storage.local.set({ ignores });
}
async function ignoreIssues(row, issues) {
  for (const i of issues) ignores[ignoreKey(row, i)] = ignoreEntry(row, i);
  await saveIgnores();
}
async function unignore(keys) {
  for (const k of keys) delete ignores[k];
  await saveIgnores();
}
async function removeTypeRule(type) {
  delete ignoreTypes[type];
  await chrome.storage.local.set({ ignoreTypes });
}

// ── 필터 ──
const matchQuery = (r, q) => !q || [r.productName, r.itemName, r.sellerProductId, r.vendorItemId, r.productId].join(' ').toLowerCase().includes(q);

// 처리 대상 행 (무시된 문제 제외)
function filteredRows() {
  if (!current) return [];
  const f = $('issueFilter').value;
  const q = $('search').value.trim().toLowerCase();
  return view
    .filter((r) => r.issues.length)
    .filter((r) => !f || (f === '__AD' ? adSpend.has(String(r.vendorItemId)) : r.issues.includes(f)))
    .filter((r) => matchQuery(r, q))
    .sort((a, b) => b.level - a.level || ((adSpend.get(String(b.vendorItemId)) || {}).spend || 0) - ((adSpend.get(String(a.vendorItemId)) || {}).spend || 0));
}

// 무시 목록 (최신 점검 기준 현재 상태 포함)
function filteredIgnored() {
  const f = $('issueFilter').value;
  const q = $('search').value.trim().toLowerCase();
  return ignoredList(ignores, current ? current.rows : [])
    .filter((e) => !f || e.issue === f)
    .filter((e) => matchQuery(e, q));
}

// 문제 태그 (처리 대상 모드에서는 태그별 ✕ 로 개별 무시 가능)
function tags(r, withIgnore) {
  return r.issues.map((i) => `<span class="tag l${ISSUE_DEFS[i].level}">${esc(ISSUE_DEFS[i].label)}${
    withIgnore ? `<button class="tx" data-ign="${esc(i)}" data-row="${esc(r.key)}" title="이 문제만 무시">✕</button>` : ''}</span>`).join('');
}

// ── 요약 ──
function renderOverview() {
  if (!current) {
    $('cards').innerHTML = '';
    $('breakdown').innerHTML = '<div class="empty">아직 점검 기록이 없습니다.<br>Chrome에서 WING에 로그인한 뒤 「지금 점검」을 누르세요.<br>계정에 상품이 없다면 설정에서 데모 모드로 체험할 수 있습니다.</div>';
    $('snapInfo').textContent = '';
    return;
  }
  const s = viewSummary;
  $('cards').innerHTML = [
    ['상품', s.products, ''], ['옵션', s.items, ''], ['심각한 문제', s.critical, 'red'], ['정상', s.healthy, 'green'],
  ].map(([l, n, c]) => `<div class="card ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  $('breakdown').innerHTML = Object.entries(ISSUE_DEFS)
    .map(([k, d]) => `<div class="bd ${ignoreTypes[k] ? 'ign' : ''}" data-k="${k}" ${ignoreTypes[k] ? 'data-ignored="1"' : ''}><span><i class="dot l${d.level}"></i>${esc(d.label)}${ignoreTypes[k] ? '<span class="rtag">🔕 유형 무시 중</span>' : ''}</span><b>${s.counts[k] || 0}</b></div>`).join('')
    + `<div class="bd ign" data-ignored="1"><span>🔕 무시된 문제 (현재 발생 중)</span><b>${s.ignored}</b></div>`;
  // 항목 클릭 → 해당 문제로 필터링된 목록으로 이동
  $('breakdown').querySelectorAll('.bd').forEach((el) => el.addEventListener('click', () => {
    $('issueFilter').value = el.dataset.k || '';
    setMode(el.dataset.ignored ? 'ignored' : 'active');
    switchTab('issues');
  }));
  const notes = [];
  if (current.demo) notes.push('(데모 데이터)');
  if (current.truncated) notes.push('상품이 많아 앞 200페이지만 읽었습니다');
  if (current.excluded) notes.push(`판매중지·판매불가 옵션 ${current.excluded}개 제외`);
  if (current.detailTargets) notes.push(`상세 수집 ${current.detailCount}/${current.detailTargets}개 상품`);
  if (current.filterErrors && current.filterErrors.length) notes.push(current.filterErrors.join(', '));
  $('snapInfo').textContent = `점검 시각: ${fmt(current.at)} ${notes.join(' / ')}`;
}

// ── 문제 목록 ──
function renderIssues() {
  const active = filteredRows();
  const ign = filteredIgnored();
  $('cntActive').textContent = current ? view.filter((r) => r.issues.length).length : 0;
  $('cntIgnored').textContent = ignoredList(ignores, []).length + Object.keys(ignoreTypes).filter((t) => ISSUE_DEFS[t]).length;
  // 일괄 무시 바 상태
  $('bulkBar').style.display = mode === 'active' && active.length ? '' : 'none';
  for (const k of [...selected]) if (!active.some((r) => r.key === k)) selected.delete(k);
  $('selAll').checked = active.length > 0 && selected.size === active.length;
  $('selAll').indeterminate = selected.size > 0 && selected.size < active.length;
  $('selInfo').textContent = selected.size ? `(${selected.size}/${active.length})` : `(${active.length})`;
  $('ignoreSel').disabled = !selected.size;
  $('ignoreSel').textContent = selected.size ? `선택 ${selected.size}건 무시` : '선택 항목 무시';
  const f = ISSUE_DEFS[$('issueFilter').value] ? $('issueFilter').value : '';
  $('ignoreType').disabled = !f;
  $('ignoreType').textContent = f ? `「${ISSUE_DEFS[f].label}」 항상 무시` : '이 유형 항상 무시';
  if (mode === 'active') renderActive(active);
  else renderIgnored(ign);
}

function renderActive(rows) {
  if (!current) { $('issueList').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
  if (!rows.length) { $('issueList').innerHTML = '<div class="empty">처리할 문제가 없습니다 🎉</div>'; return; }
  $('issueList').innerHTML = rows.slice(0, shown).map((r) => `
    <div class="item pick ${selected.has(r.key) ? 'selected' : ''}" data-key="${esc(r.key)}" title="클릭하면 선택/해제됩니다">
      <input type="checkbox" class="sel" data-sel="${esc(r.key)}" ${selected.has(r.key) ? 'checked' : ''} title="일괄 무시 선택" />
      <div class="t">${esc(r.productName)} ${r.itemName ? '· ' + esc(r.itemName) : ''}</div>
      <div class="ids">등록상품ID ${esc(r.sellerProductId)} · 옵션ID ${esc(r.vendorItemId)} · 노출상품ID ${esc(r.productId || '-')}</div>
      <div>${tags(r, true)}${adSpend.has(String(r.vendorItemId)) ? (() => { const a = adSpend.get(String(r.vendorItemId)); return `<span class="tag adtag" title="${esc(a.campaigns.map((c) => c.name).join(', '))}">광고 중 · 광고비 ${Math.round(a.spend).toLocaleString('ko-KR')}원</span>`; })() : ''}</div>
      ${r.reasons && r.reasons.length ? `<div class="reasons">${r.reasons.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="hint">${esc(ISSUE_DEFS[r.issues[0]].hint)}</div>
      ${r.ignoredIssues.length ? `<div class="hint">🔕 무시 중: ${r.ignoredIssues.map((i) => esc(ISSUE_DEFS[i].label)).join(', ')}</div>` : ''}
      <div class="acts">${linkButtons(r)}${requestButtons(r)}<button class="ig" data-ignall="${esc(r.key)}" title="이 옵션의 현재 문제를 모두 무시">무시</button></div>
    </div>`).join('') + more(rows.length);
}

function renderIgnored(list) {
  // 유형 전체 무시 규칙
  const types = Object.entries(ignoreTypes).filter(([t]) => ISSUE_DEFS[t]);
  const rules = types.length ? `<div class="rules"><div class="t">유형 무시 규칙 (모든 상품에 적용)</div>${types.map(([t, v]) => `
    <div class="rule"><span><span class="tag l${ISSUE_DEFS[t].level}">${esc(ISSUE_DEFS[t].label)}</span>
      <span class="muted">현재 ${view.filter((r) => r.ignoredIssues.includes(t)).length}건 · ${esc(fmt(v.at))}</span></span>
      <button class="unig" data-untype="${esc(t)}">규칙 해제</button></div>`).join('')}</div>` : '';
  if (!list.length) {
    $('issueList').innerHTML = rules + (types.length ? '' : `<div class="empty">무시한 문제가 없습니다.<br>처리 대상 카드의 「무시」, 태그의 ✕, 또는 「전체 선택」 후 일괄 무시로 추가할 수 있습니다.</div>`);
    return;
  }
  const header = `<div class="acts" style="margin:0 0 8px"><span class="muted">같은 옵션의 같은 문제는 다시 발생해도 계속 무시됩니다.</span>
    <button class="unig" data-unignall="1">표시된 ${list.length}건 모두 해제</button></div>`;
  $('issueList').innerHTML = rules + header + list.slice(0, shown).map((e) => `
    <div class="item ${e.present ? '' : 'dim'}">
      <div class="t">${esc(e.productName)} ${e.itemName ? '· ' + esc(e.itemName) : ''}</div>
      <div class="ids">등록상품ID ${esc(e.sellerProductId)} · 옵션ID ${esc(e.vendorItemId)} · 무시한 날짜 ${esc(fmt(e.at))}</div>
      <div><span class="tag l${ISSUE_DEFS[e.issue].level}">${esc(ISSUE_DEFS[e.issue].label)}</span>
        <span class="st ${e.present ? 'on' : 'off'}">${e.present ? '현재 발생 중' : '최근 점검에서 미발생'}</span></div>
      <div class="acts">${linkButtons(e)}<button class="unig" data-unign="${esc(e.key)}">무시 해제</button></div>
    </div>`).join('') + more(list.length);
}

const more = (n) => (n > shown ? `<div class="more"><button id="moreBtn">더 보기 (총 ${n}건)</button></div>` : '');

// ── 변경 내역 ──
function renderChanges() {
  if (!current) { $('changeList').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
  const all = current.changes || [];
  if (!all.length) { $('changeList').innerHTML = '<div class="empty">지난 점검 대비 변경 사항이 없습니다 (또는 첫 점검입니다)</div>'; return; }
  const f = $('changeFilter').value;
  const ch = all.filter((c) => !f || c.type === f);
  const label = (c) => {
    switch (c.type) {
      case 'ISSUE_NEW': return `🔴 새 문제: ${ISSUE_DEFS[c.issue].label}`;
      case 'ISSUE_RESOLVED': return `🟢 해결됨: ${ISSUE_DEFS[c.issue].label}`;
      case 'PRODUCT_ID_CHANGED': return `🟠 노출상품ID 변경: ${c.from} → ${c.to}`;
      case 'NEW_ITEM': return '➕ 신규 옵션';
      default: return '➖ 사라진 옵션';
    }
  };
  // 이 변경과 관련된 문제 유형 (무시 대상)
  const issueOf = (c) => (c.type === 'PRODUCT_ID_CHANGED' ? 'PRODUCT_ID_CHANGED' : c.type === 'ISSUE_NEW' ? c.issue : null);
  const changeIgnored = (c) => {
    const issue = issueOf(c);
    return !!(issue && isIgnored(c.row, issue, ignores, ignoreTypes));
  };
  // 조치 안내
  const guide = (c) => {
    if (c.type === 'PRODUCT_ID_CHANGED') return '다른 판매자 상품 페이지에 붙었으면 → 분리 요청 / 내 옵션이 다른 페이지로 나뉘었으면 → 결합 요청 / 정상적인 변경이면 → 무시';
    if (c.type === 'ISSUE_NEW') return ISSUE_DEFS[c.issue].hint;
    if (c.type === 'REMOVED_ITEM') return '삭제·판매중지되었거나 점검 대상에서 제외된 옵션입니다';
    return '';
  };
  const order = { PRODUCT_ID_CHANGED: 0, ISSUE_NEW: 1, ISSUE_RESOLVED: 2, NEW_ITEM: 3, REMOVED_ITEM: 4 };
  if (!ch.length) { $('changeList').innerHTML = '<div class="empty">조건에 맞는 변경 사항이 없습니다</div>'; return; }
  $('changeList').innerHTML = [...ch]
    .sort((a, b) => (changeIgnored(a) - changeIgnored(b)) || order[a.type] - order[b.type])
    .slice(0, 300).map((c) => {
      const ig = changeIgnored(c);
      const issue = issueOf(c);
      const vr = view.find((x) => x.key === c.row.key); // 현재 점검 기준 행 (요청서 버튼 판단용)
      let reqs = '';
      if (c.type === 'PRODUCT_ID_CHANGED' && vr) {
        // 노출상품ID 변경: 옵션 분리 상태면 결합 요청, 아니면 분리 요청
        reqs = vr.issues.includes('SPLIT') || vr.issues.includes('SELF_LOSER')
          ? `<button class="rq" data-req="merge" data-row="${esc(vr.key)}">결합 요청 문의 작성</button>`
          : `<button class="rq" data-req="sep" data-row="${esc(vr.key)}">분리 요청 문의 작성</button>`;
      } else if (c.type === 'ISSUE_NEW' && vr) reqs = requestButtons(vr);
      const g = guide(c);
      return `
    <div class="item ${ig ? 'dim' : ''}"><div class="t">${esc(label(c))}${ig ? ' (무시됨)' : ''}</div>
    <div>${esc(c.row.productName)} ${c.row.itemName ? '· ' + esc(c.row.itemName) : ''}</div>
    <div class="ids">등록상품ID ${esc(c.row.sellerProductId)} · 옵션ID ${esc(c.row.vendorItemId)}</div>
    ${g && !ig ? `<div class="hint">${esc(g)}</div>` : ''}
    <div class="acts">${linkButtons(c.row)}${ig ? '' : reqs}
      ${vr && vr.issues.length ? `<button class="lk2" data-goto="${esc(c.row.vendorItemId)}">문제 목록에서 보기</button>` : ''}
      ${issue ? (ig
        ? `<button class="unig" data-unign="${esc(ignoreKey(c.row, issue))}">무시 해제</button>`
        : `<button class="ig" data-ign="${esc(issue)}" data-row="${esc(c.row.key)}" title="이 옵션의 「${esc(ISSUE_DEFS[issue].label)}」를 무시 (다음 점검에서도 계속)">무시</button>`) : ''}
    </div></div>`;
    }).join('');
}

// ── 링크 ──
// 카드 하단 이동 버튼
function linkButtons(r) {
  const l = productLinks(r, linkIndex);
  const b = [];
  if (l.coupang) b.push(`<button class="lk" data-url="${esc(l.coupang)}" title="${l.viaOther ? '이 옵션은 쿠팡에 노출되지 않아, 같은 상품 페이지의 노출 중인 옵션으로 엽니다' : '쿠팡 상품 페이지 열기'}">${l.viaOther ? '쿠팡 상품페이지(다른 옵션)' : '쿠팡 상품페이지'} ↗</button>`);
  else if (l.coupangHidden) b.push(`<span class="nolink" title="이 상품 페이지에 현재 노출 중인 옵션이 없어 쿠팡에서 열 수 없습니다">쿠팡 미노출</span>`);
  if (l.search) b.push(`<button class="lk" data-url="${esc(l.search)}">쿠팡 검색 ↗</button>`);
  if (l.wing) b.push(`<button class="lk" data-url="${esc(l.wing)}" title="WING 상품 수정 화면을 엽니다">WING 수정 ↗</button>`);
  return b.join('');
}

// ── 온라인 문의 작성 (A5 분리 / A6 결합) ──
// 버튼 → 요청서를 클립보드에 복사 + 저장 → 온라인 문의 작성 화면을 열면 content/inquiry-fill.js 가 자동 입력
function requestButtons(r) {
  const b = [];
  if (r.issues.includes('LOSER')) b.push(`<button class="rq" data-req="sep" data-row="${esc(r.key)}" title="상이한 상품과 잘못 매칭된 경우: 온라인 문의를 열고 분리 요청서를 자동 입력합니다 (제출은 직접)">분리 요청 문의 작성</button>`);
  if (r.issues.includes('SPLIT') || r.issues.includes('SELF_LOSER')) b.push(`<button class="rq" data-req="merge" data-row="${esc(r.key)}" title="옵션이 여러 상품 페이지로 나뉜 경우: 온라인 문의를 열고 결합 요청서를 자동 입력합니다 (제출은 직접)">결합 요청 문의 작성</button>`);
  return b.join('');
}
async function copyRequest(btn) {
  const row = view.find((x) => x.key === btn.dataset.row);
  if (!row) return;
  const kind = btn.dataset.req;
  const rows = kind === 'merge' ? view.filter((x) => x.sellerProductId === row.sellerProductId) : [row];
  const payload = inquiryPayload(kind, rows);
  try { await navigator.clipboard.writeText(payload.text); } catch (e) { /* 클립보드 실패해도 자동 입력은 진행 */ }
  await chrome.storage.local.set({ pendingInquiry: payload });
  chrome.tabs.create({ url: INQUIRY_FORM_URL, active: true });
  const old = btn.textContent;
  btn.textContent = '문의 화면 여는 중… (클립보드에도 복사됨)';
  setTimeout(() => (btn.textContent = old), 3000);
}

// ── 클릭 처리 (이벤트 위임): 무시 / 무시 해제 / 더 보기 / 링크 이동 ──
$('issueList').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#moreBtn')) { shown += 100; renderIssues(); return; }
  const sel = t.closest('[data-sel]'); // 일괄 선택 체크박스
  if (sel) {
    if (sel.checked) selected.add(sel.dataset.sel); else selected.delete(sel.dataset.sel);
    renderIssues();
    return;
  }
  const ut = t.closest('[data-untype]'); // 유형 규칙 해제
  if (ut) { if (confirm(`「${ISSUE_DEFS[ut.dataset.untype].label}」 유형 무시 규칙을 해제할까요?`)) await removeTypeRule(ut.dataset.untype); return; }

  const tx = t.closest('[data-ign]'); // 태그 ✕: 문제 1개 무시
  if (tx) {
    const row = view.find((r) => r.key === tx.dataset.row);
    if (row) await ignoreIssues(row, [tx.dataset.ign]);
    return;
  }
  const all = t.closest('[data-ignall]'); // 카드 「무시」: 현재 문제 전부 무시
  if (all) {
    const row = view.find((r) => r.key === all.dataset.ignall);
    if (row) await ignoreIssues(row, row.issues);
    return;
  }
  const un = t.closest('[data-unign]'); // 무시 해제
  if (un) { await unignore([un.dataset.unign]); return; }
  if (t.closest('[data-unignall]')) {
    const list = filteredIgnored();
    if (confirm(`표시된 ${list.length}건의 무시를 모두 해제할까요?`)) await unignore(list.map((x) => x.key));
    return;
  }
  if (t.closest('.lk')) { openLink(e); return; } // 이동 버튼만 링크 열기
  const rq = t.closest('[data-req]'); // 요청서 복사
  if (rq) { await copyRequest(rq); return; }
  // 처리 대상 카드 빈 곳 클릭 → 체크박스 선택/해제 (텍스트 드래그 선택 중에는 무시)
  const card = t.closest('.item.pick');
  if (card && !(window.getSelection && String(window.getSelection()).length)) {
    const k = card.dataset.key;
    if (selected.has(k)) selected.delete(k); else selected.add(k);
    renderIssues();
  }
});
// 변경 내역 카드 버튼: 링크 / 요청서 / 무시 / 무시 해제 / 문제 목록으로 이동
$('changeList').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('.lk')) { openLink(e); return; }
  const rq = t.closest('[data-req]');
  if (rq) { await copyRequest(rq); return; }
  const ig = t.closest('[data-ign]');
  if (ig) {
    const row = (current.rows || []).find((r) => r.key === ig.dataset.row) || (current.changes || []).map((c) => c.row).find((r) => r.key === ig.dataset.row);
    if (row) await ignoreIssues(row, [ig.dataset.ign]);
    return;
  }
  const un = t.closest('[data-unign]');
  if (un) { await unignore([un.dataset.unign]); return; }
  const go = t.closest('[data-goto]');
  if (go) {
    $('issueFilter').value = '';
    $('search').value = go.dataset.goto;
    setMode('active');
    switchTab('issues');
  }
});
$('changeFilter').addEventListener('change', renderChanges);

// 이동 버튼(.lk) → 새 탭으로 열기
function openLink(e) {
  const el = e.target.closest('.lk[data-url]');
  if (el && el.dataset.url) chrome.tabs.create({ url: el.dataset.url, active: true });
}

// ── 상태 표시 ──
function renderStatus(st) {
  const el = $('status');
  el.className = 'status';
  if (!st) { el.textContent = '준비됨'; return; }
  if (st.state === 'running') {
    el.classList.add('running');
    const p = st.progress;
    const step = p ? (p.phase === 'list' ? `상품 목록·노출 상태 ${p.done}/${p.total} 페이지` : `상세 정보 ${p.done}/${p.total} 상품`) : '시작 중';
    el.textContent = `점검 중… ${step} (상품이 많으면 몇 분 걸립니다)`;
    $('scanBtn').disabled = true;
    return;
  }
  $('scanBtn').disabled = false;
  if (st.state === 'error') { el.classList.add('error'); el.textContent = `점검 실패: ${st.message}`; return; }
  el.textContent = `마지막 점검 완료: ${fmt(st.at)}`;
}

function rebuild() {
  view = current ? applyIgnores(current.rows, ignores, ignoreTypes) : [];
  linkIndex = buildLinkIndex(current ? current.rows : []);
  viewSummary = current ? summarize(view) : null;
  renderOverview(); renderIssues(); renderChanges();
}

async function load() {
  const data = await chrome.storage.local.get(['snapshots', 'status', 'settings', 'ignores', 'ignoreTypes', 'adsSnapshots']);
  const ads = (data.adsSnapshots || [])[(data.adsSnapshots || []).length - 1];
  adSpend = new Map();
  for (const p of (ads && ads.products) || []) {
    if (!p.spend) continue;
    const a = adSpend.get(String(p.vendorItemId)) || { spend: 0, sales: 0, campaigns: [] };
    a.spend += p.spend; a.sales += p.sales || 0; a.campaigns.push({ id: p.campaignId, name: p.campaignName });
    adSpend.set(String(p.vendorItemId), a);
  }
  const snapshots = data.snapshots || [];
  const settings = data.settings || {};
  current = snapshots.length ? snapshots[snapshots.length - 1] : null;
  ignores = data.ignores || {};
  ignoreTypes = data.ignoreTypes || {};
  renderStatus(data.status);
  rebuild();
  $('autoScan').checked = settings.autoScan !== false;
  $('adsReminder').checked = settings.adsReminder !== false;
  $('scanHour').value = String(settings.scanHour ?? 9);
  $('notify').checked = settings.notify !== false;
  $('demoMode').checked = !!settings.demoMode;
  $('excludeInactive').checked = settings.excludeInactive !== false;
  $('collectDetail').checked = settings.collectDetail !== false;
  $('delayMs').value = settings.delayMs ?? 2000;
  $('adsDelayMs').value = settings.adsDelayMs ?? 4000;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.adsSnapshots && !changes.snapshots) { load(); return; }
  if ((changes.ignores || changes.ignoreTypes) && !changes.snapshots && !changes.status) {
    if (changes.ignores) ignores = changes.ignores.newValue || {};
    if (changes.ignoreTypes) ignoreTypes = changes.ignoreTypes.newValue || {};
    rebuild();
    return;
  }
  if (changes.snapshots || changes.status) load();
});
load();

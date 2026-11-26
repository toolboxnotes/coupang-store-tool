// 사이드 패널 「광고」 탭
//  - 캠페인: 광고 점검(B1) · 캠페인 분석(B2) · 제안(B3)
//  - (캠페인 안) AI 스마트 광고 vs 나머지 캠페인 비교, 제외 키워드·제외 상품·노출 상태
//  - 키워드: 광고 보고서(엑셀/CSV) 업로드 → 키워드별 성과 → 제외 키워드 추천
//  - 수정 사항: 변경안 목록 → 사용자 동의 후 적용(일예산·목표 ROAS·ON/OFF) / 제외 키워드는 복사 + 편집 화면
import { ISSUE_DEFS } from './lib/core.js';
import {
  AD_FLAGS, AD_DEFAULTS, analyzeCampaigns, summarizeAds, adsCSV, adCampaignUrl, breakEvenRoas,
  aiSmartComparison, SERVING_HINTS, CHANGE_FIELDS, proposeChanges, negKeywordAdvice, PLAN_RULE_DEFAULTS, recentChangeIndex, budgetUse, evaluateEffects, EFFECT_LABELS, adProductIssues, validateChange, changeWarning, adEditUrl,
  parseCSV, parseKeywordReport, analyzeKeywords, negKeywordChanges, keywordsCSV, demoKeywordReport,
} from './lib/adcore.js';

const $ = (id) => document.getElementById(id);
const ISSUE_LABELS = Object.fromEntries(Object.entries(ISSUE_DEFS).map(([k, d]) => [k, d.label]));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const won = (n) => `${Math.round(n || 0).toLocaleString('ko-KR')}원`;
const pct = (n) => `${(n || 0).toLocaleString('ko-KR')}%`;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { hour12: false }) : '-');
const day = (ms) => { const d = new Date(Number(ms) + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const fieldVal = (field, v) => (v === '' || v === null || v === undefined ? '-' : field === 'budget' ? won(v) : field === 'roasTarget' ? pct(v) : String(v));
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let snap = null;          // 최신 광고 스냅샷
let margin = AD_DEFAULTS.marginRate;
let productRows = [];
let trendKeywords = [];    // 키워드 트렌드의 내 카테고리 인기 검색어 [{ keyword, categoryName, categoryRank }]      // 최신 상품 점검 행 (광고 중인 문제 상품 확인용)
let margins = {};          // 캠페인별 마진율 { 캠페인ID: % } (settings.adMargins)
let rows = [];            // 분석된 캠페인
let plan = [];            // 수정 사항 (chrome.storage.local.adPlan)
let kw = null;            // 키워드 분석 { rows, fileName }
let lastResults = {};     // 적용 결과 (key → result)

// ── 하위 탭 ──
document.querySelectorAll('#adSeg button').forEach((b) => b.addEventListener('click', () => showSub(b.dataset.sub)));
function showSub(name) {
  document.querySelectorAll('#adSeg button').forEach((x) => x.classList.toggle('on', x.dataset.sub === name));
  document.querySelectorAll('#tab-ads .sub').forEach((x) => (x.hidden = x.id !== `sub-${name}`));
}

for (const [k, d] of Object.entries(AD_FLAGS)) $('adFilter').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(d.label)}</option>`);

// ── 광고 점검 ──
$('adScanBtn').addEventListener('click', async () => {
  $('adScanBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'adsScan', days: Number($('adDays').value) });
  $('adScanBtn').disabled = false;
});
$('adMargin').addEventListener('change', async () => {
  margin = Math.min(95, Math.max(1, Number($('adMargin').value) || AD_DEFAULTS.marginRate));
  $('adMargin').value = margin;
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, adMarginRate: margin } });
  render();
});
for (const id of ['adFilter', 'adSort', 'adShowIdle']) $(id).addEventListener('change', renderList);
// 캠페인별 마진율 입력 (비우면 전체 마진율)
$('adList').addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-margin]');
  if (!inp) return;
  const id = inp.dataset.margin;
  const v = Number(inp.value);
  if (inp.value === '' || !(v >= 1 && v <= 95)) delete margins[id]; else margins[id] = Math.round(v * 10) / 10;
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, adMargins: margins } });
  load();
});
$('adExport').addEventListener('click', () => snap && download(`coupang-store-tool_광고_${snap.at.slice(0, 10)}.csv`, adsCSV(visibleRows())));

// 카드 버튼 (링크 열기 / 제외 키워드 보기)
document.getElementById('tab-ads').addEventListener('click', (e) => {
  const link = e.target.closest('[data-url]');
  if (link && link.dataset.url) { chrome.tabs.create({ url: link.dataset.url, active: true }); return; }
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const el = document.getElementById(tg.dataset.toggle); if (el) { el.hidden = !el.hidden; el.hidden ? openNeg.delete(tg.dataset.toggle) : openNeg.add(tg.dataset.toggle); } return; }
  const np = e.target.closest('[data-negplan]');
  if (np && kw) {
    const add = negKeywordChanges(kw.rows.filter((x) => String(x.campaignId) === np.dataset.negplan), rows);
    mergePlan(add).then(() => { np.textContent = add.length ? '수정사항에 추가됨 ✓' : '추가할 키워드 없음'; np.disabled = true; });
  }
});
const openNeg = new Set();   // 다시 그려도 열어 둔 상자 유지

function visibleRows() {
  const f = $('adFilter').value, showIdle = $('adShowIdle').checked, by = $('adSort').value;
  return rows
    .filter((r) => showIdle || r.isActive || r.spend > 0)
    .filter((r) => !f || (f === '__problem' ? r.level >= 1 : r.flags.includes(f)))
    .sort((a, b) => (by === 'roas' ? (a.spend > 0 ? a.roas : 1e9) - (b.spend > 0 ? b.roas : 1e9) : by === 'sales' ? b.sales - a.sales : b.spend - a.spend));
}

// 제외 키워드·제외 상품·노출 상태 + 「제외 키워드 · 추천」 상자
//  현재 제외 키워드 / 제외 추천(광고 보고서의 전환 없는 키워드) / 지켜볼 키워드(손익분기 미달) / 제외 해제 검토(인기 검색어인데 제외됨)
function detailHtml(r, scope = 'list') {
  const d = r.detail;
  if (!d) return '';
  const id = `neg-${scope}-${r.id}`;
  const hints = (d.servingHints || []).map((h) => SERVING_HINTS[h] || h);
  const a = negKeywordAdvice(r, { kwRows: kw ? kw.rows : [], trendKeywords });
  const chip = (t, cls = '', title = '') => `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
  const badge = [a.add.length ? `추천 ${a.add.length}` : '', a.release.length ? `해제 검토 ${a.release.length}` : ''].filter(Boolean).join(' · ');
  const box = `<div id="${id}" class="negbox" hidden>
      <div class="neghead">현재 제외 키워드 <b>${a.current.length}</b>/500</div>
      <div class="chips">${a.current.map((x) => chip(x.keyword, x.popular ? 'hot' : '', x.popular ? '내 카테고리 인기 검색어' : '')).join('') || '<span class="muted none">없음</span>'}</div>
      <div class="neghead">제외 추천 <span class="muted">전환 없이 광고비만 쓴 키워드</span></div>
      ${a.hasReport
        ? (a.add.length
          ? `<div class="chips">${a.add.slice(0, 60).map((x) => chip(`${x.keyword} ${won(x.spend)}`, 'add', `클릭 ${x.clicks || 0}`)).join('')}</div>
             <div class="links"><button class="rq" data-negplan="${esc(r.id)}">수정사항에 추가 (${Math.min(a.add.length, 500 - a.current.length)}개)</button></div>`
          : '<div class="muted">추천할 키워드가 없습니다.</div>')
        : '<div class="muted">「광고 → 키워드」에서 광고 보고서를 올리면 이 캠페인에서 전환 없이 광고비만 쓴 키워드를 추천합니다.</div>'}
      ${a.watch.length ? `<div class="neghead">지켜볼 키워드 <span class="muted">전환은 있지만 손익분기 미달 — 바로 제외하지 말고 확인</span></div>
        <div class="chips">${a.watch.slice(0, 30).map((x) => chip(`${x.keyword} ROAS ${x.roas}%`, 'watch', `광고비 ${won(x.spend)} · 주문 ${x.orders}`)).join('')}</div>` : ''}
      <div class="neghead">제외 해제 검토 <span class="muted">내 카테고리 인기 검색어인데 제외됨</span></div>
      ${a.hasTrends
        ? (a.release.length
          ? `<div class="chips">${a.release.map((x) => chip(x.keyword, 'hot', `${x.category} 인기 ${x.rank}위`)).join('')}</div>
             <div class="muted">내 상품과 관련 있는 검색어라면 편집 화면에서 제외를 풀어 보세요.</div>`
          : '<div class="muted">해당 없음</div>')
        : '<div class="muted">「키워드 트렌드」에서 인기 키워드를 조회하면 확인할 수 있습니다.</div>'}
      ${r.groupId ? `<div class="links"><button class="lk" data-url="${esc(adEditUrl(r.id, r.groupId, r.isAiSmart))}">제외 키워드 편집 화면 ↗</button></div>` : ''}
    </div>`;
  return `<div class="ids">제외 키워드 ${a.current.length}/500 · 제외 상품 ${d.excludedProducts}개${hints.length ? ` · <span class="warnline">${esc(hints.join(', '))}</span>` : ''}</div>
    <button class="lk2" data-toggle="${id}">제외 키워드 · 추천${badge ? ` <b class="negbadge">${esc(badge)}</b>` : ''}</button>${box}`;
}

function render() {
  renderPlanCount();
  if (!snap) {
    $('adCards').innerHTML = ''; $('adDaily').innerHTML = ''; $('adToolbar').style.display = 'none';
    $('adList').innerHTML = '<div class="empty">아직 광고 점검 기록이 없습니다.<br>「광고 점검」을 누르세요. 광고센터에 로그인되어 있어야 합니다.</div>';
    $('aiBox').innerHTML = '<div class="empty">광고 점검 후 표시됩니다</div>';
    renderPlan();
    return;
  }
  $('adToolbar').style.display = '';
  rows = analyzeCampaigns(snap.rows.map((r) => ({ ...r })), { marginRate: margin, margins });
  const s = summarizeAds(rows, { marginRate: margin });
  $('adCards').className = 'cards ads';
  $('adCards').innerHTML = [
    ['광고비', won(s.spend), ''], ['광고 전환 매출', won(s.sales), ''],
    ['ROAS', pct(s.roas), s.roas < s.breakEven ? 'red' : 'green', `손익분기 ${pct(s.breakEven)}`],
    ['전환 주문', `${s.orders.toLocaleString('ko-KR')}건`, '', `전환율 ${s.cvr}%`],
    ['클릭률', `${s.ctr}%`, '', `클릭 ${s.clicks.toLocaleString('ko-KR')}`],
    ['개선 여지 광고비', won(s.wasted), s.wasted ? 'red' : '', '손익분기 미달·전환 없음'],
  ].map(([l, n, c, sub]) => `<div class="card ${c}"><div class="n" style="font-size:15px;white-space:nowrap">${n}</div><div class="l">${l}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`).join('');
  $('adDaily').innerHTML = snap.daily.length ? `<table class="daily"><tr><th>날짜</th><th>광고비</th><th>전환 매출</th><th>주문</th><th>ROAS</th></tr>${
    snap.daily.map((d) => `<tr><td>${day(d.date)}</td><td>${d.spend.toLocaleString('ko-KR')}</td><td>${d.sales.toLocaleString('ko-KR')}</td><td>${d.orders}</td><td class="${d.roas < s.breakEven ? 'bad' : 'good'}">${d.roas}%</td></tr>`).join('')}</table>` : '';
  for (const opt of $('adFilter').options) {
    if (AD_FLAGS[opt.value]) opt.textContent = `${AD_FLAGS[opt.value].label} (${s.counts[opt.value]})`;
    if (opt.value === '__problem') opt.textContent = `문제 있는 캠페인 (${rows.filter((r) => r.level >= 1).length})`;
  }
  renderList(); renderAi(); renderAdProducts(); renderKeywords(); renderPlan();
}

function renderList() {
  if (!snap) return;
  const list = visibleRows();
  if (!list.length) { $('adList').innerHTML = '<div class="empty">조건에 맞는 캠페인이 없습니다</div>'; return; }
  $('adList').innerHTML = list.slice(0, 200).map((r) => { const be = r.breakEven; return `
    <div class="item">
      <div class="t">${esc(r.name)}${r.isAiSmart ? ' 🤖' : ''}<span class="onoff ${r.isActive ? 'on' : 'off'}">${r.isActive ? 'ON' : 'OFF'}</span></div>
      <div class="ids">캠페인ID ${esc(r.id)} · 목표 ROAS ${r.roasTarget ? pct(r.roasTarget) : '-'} · 일 예산 ${r.budget ? won(r.budget) : '-'}${r.isActive && budgetUse(r, snap.days) != null ? ` · 예산 소진율 ${budgetUse(r, snap.days)}%` : ''}</div>
      <div class="ids mg">마진율 <input type="number" min="1" max="95" data-margin="${esc(r.id)}" value="${r.ownMargin ? r.marginRate : ''}" placeholder="${margin}" title="비워 두면 전체 마진율(${margin}%) 사용" />% · 손익분기 ROAS ${pct(be)}${r.ownMargin ? ' (캠페인 마진율)' : ''}</div>
      <div class="met">
        <span>광고비<b>${won(r.spend)}</b></span><span>전환 매출<b>${won(r.sales)}</b></span>
        <span>ROAS<b style="color:${r.spend && r.roas < be ? 'var(--red)' : 'inherit'}">${r.spend ? pct(r.roas) : '-'}</b></span><span>주문<b>${r.orders}</b></span>
        <span>노출<b>${r.impressions.toLocaleString('ko-KR')}</b></span><span>클릭률<b>${r.ctr}%</b></span>
        <span>전환율<b>${r.cvr}%</b></span><span>CPC<b>${won(r.cpc)}</b></span>
      </div>
      ${detailHtml(r)}
      ${r.flags.length ? `<div>${r.flags.map((f) => `<span class="tag l${AD_FLAGS[f].level}">${esc(AD_FLAGS[f].label)}</span>`).join('')}</div>
      <div class="hint">${r.flags.map((f) => '· ' + esc(AD_FLAGS[f].tip)).join('<br>')}</div>` : ''}
      <div class="acts"><button class="lk" data-url="${esc(adCampaignUrl(r.id))}">광고센터에서 열기 ↗</button>
        ${r.groupId ? `<button class="lk" data-url="${esc(adEditUrl(r.id, r.groupId, r.isAiSmart))}">설정 편집 ↗</button>` : ''}</div>
    </div>`; }).join('') + (list.length > 200 ? '<div class="muted">상위 200개만 표시 (CSV에는 전체 포함)</div>' : '');
  for (const id of openNeg) { const el = document.getElementById(id); if (el) el.hidden = false; }
}

// ── AI 스마트 비교 ──
// 광고 중인데 상품에 문제가 있는 옵션 (노출 제한·품절·아이템위너 아님·속성 오류)
function renderAdProducts() {
  const box = $('adProdBox');
  if (!snap) { box.innerHTML = ''; return; }
  if (!snap.products) { box.innerHTML = '<div class="box muted">광고 중인 문제 상품: 0.7.1 이후 광고 점검부터 확인됩니다.</div>'; return; }
  const list = adProductIssues(snap, productRows);
  const note = snap.productIndexIncomplete ? `<div class="ids">AI 스마트 등 광고가 많은 캠페인은 광고 목록을 여러 번에 나눠 모읍니다 (남은 광고그룹 ${snap.productIndexIncomplete}개 → 다음 광고 점검 때 이어서).</div>` : '';
  if (!list.length) { box.innerHTML = `<div class="box"><b>광고 중인 문제 상품</b> <span class="muted">없음 (문제 옵션 ${snap.productTargets || 0}개 확인)</span>${note}</div>`; return; }
  const total = list.reduce((a, x) => a + x.spend, 0);
  box.innerHTML = `<details class="box" open><summary><b>⚠ 광고 중인 문제 상품 ${list.length}개</b> <span class="muted">기간 광고비 ${won(total)}</span></summary>
    <div class="ids">상품이 노출 제한·품절·아이템위너 아님 상태면 광고비가 나가도 팔리기 어렵습니다. 상품 문제를 해결하거나 캠페인에서 이 상품을 빼세요 (AI 스마트: 설정 편집 → 특정 상품 제외).</div>${note}
    ${list.slice(0, 50).map((x) => {
      const camp = rows.find((r) => String(r.id) === x.campaigns[0].id);
      return `<div class="item"><div class="t">${esc(x.row.productName)} <span class="muted">${esc(x.row.itemName || '')}</span></div>
        <div class="ids">옵션ID ${esc(x.vendorItemId)} · 문제: ${x.issues.map((i) => esc(ISSUE_LABELS[i] || i)).join(', ')}</div>
        <div class="ids">광고비 ${won(x.spend)} · 매출 ${won(x.sales)} · 주문 ${x.orders} · 캠페인: ${x.campaigns.map((c) => esc(`${c.name} ${won(c.spend)}`)).join(', ')}</div>
        ${camp && camp.groupId ? `<div class="links"><button class="lk" data-url="${esc(adEditUrl(camp.id, camp.groupId, camp.isAiSmart))}">캠페인 설정 편집 ↗</button></div>` : ''}</div>`;
    }).join('')}</details>`;
}

function renderAi() {
  if (!snap) return;
  const cmp = aiSmartComparison(rows, { marginRate: margin, margins });
  if (!cmp) { $('aiBox').innerHTML = '<div class="empty">AI 스마트 캠페인이 없습니다</div>'; return; }
  const A = cmp.ai, O = cmp.others, c = cmp.campaign;
  const row = (l, a, o) => `<tr><td>${l}</td><td>${a}</td><td>${o}</td></tr>`;
  $('aiBox').innerHTML = `
    <details class="box aiwrap"><summary><b>🤖 AI 스마트 비교</b> <span class="muted">ROAS ${A.spend ? pct(A.roas) : '-'} vs 나머지 ${O.spend ? pct(O.roas) : '-'}</span></summary>
    <div>
      <b>🤖 ${esc(c.name)}</b> <span class="onoff ${c.isActive ? 'on' : 'off'}">${c.isActive ? 'ON' : 'OFF'}</span>
      <div class="ids">일예산 ${c.budget ? won(c.budget) : '-'} · 목표 ROAS ${c.roasTarget ? pct(c.roasTarget) : '-'} · 손익분기 ${pct(c.breakEven || breakEvenRoas(margin))} · 키워드·입찰가 자동 운영</div>
      <table class="cmp">
        <tr><th></th><th>AI 스마트</th><th>나머지 캠페인 (${O.n}개)</th></tr>
        ${row('광고비', won(A.spend), won(O.spend))}
        ${row('광고비 비중', pct(cmp.share), pct(100 - cmp.share))}
        ${row('전환 매출', won(A.sales), won(O.sales))}
        ${row('ROAS', pct(A.roas), pct(O.roas))}
        ${row('클릭률', A.ctr + '%', O.ctr + '%')}
        ${row('전환율', A.cvr + '%', O.cvr + '%')}
        ${row('CPC', won(A.cpc), won(O.cpc))}
      </table>
      <b>분석·제안</b>
      <ul class="notes">${cmp.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="hint">AI 스마트에서 바꿀 수 있는 것: 일예산 · 목표 ROAS · 특정 상품 제외 · 제외 키워드 (키워드와 입찰가는 쿠팡이 자동 운영)</div>
      ${detailHtml(c, 'ai')}
      <div class="acts"><button class="lk" data-url="${esc(adCampaignUrl(c.id))}">광고센터에서 열기 ↗</button>
        ${c.groupId ? `<button class="lk" data-url="${esc(adEditUrl(c.id, c.groupId, true))}">설정 편집(제외 상품·키워드) ↗</button>` : ''}</div>
    </div></details>`;
}

// ── 키워드 보고서 ──
$('kwOpenReport').addEventListener('click', () => chrome.tabs.create({ url: 'https://advertising.coupang.com/marketing-reporting/billboard/reports/pa', active: true }));
$('kwInsight').addEventListener('click', () => chrome.tabs.create({ url: 'https://advertising.coupang.com/marketing-reporting/insights', active: true }));
$('kwDemo').addEventListener('click', () => loadKeywordTable(demoKeywordReport(), '데모 보고서'));
$('kwFile').addEventListener('change', async () => {
  const f = $('kwFile').files[0];
  if (!f) return;
  try {
    let table;
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      if (!window.XLSX) throw new Error('엑셀 읽기 모듈을 불러오지 못했습니다');
      const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
      // 키워드 열이 있는 시트 선택
      const sheets = wb.SheetNames.map((n) => window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }));
      table = sheets.find((t) => t.some((r) => r.some((c) => /키워드/.test(String(c))))) || sheets[0];
    } else table = parseCSV(await decodeText(f));
    loadKeywordTable(table, f.name);
  } catch (e) { $('kwInfo').textContent = `파일을 읽지 못했습니다: ${e.message}`; }
  $('kwFile').value = '';
});
// 엑셀에서 저장한 CSV는 EUC-KR(CP949)일 수 있음
async function decodeText(file) {
  const buf = await file.arrayBuffer();
  const utf = new TextDecoder('utf-8').decode(buf);
  return utf.includes('�') ? new TextDecoder('euc-kr').decode(buf) : utf;
}
function loadKeywordTable(table, name) {
  const parsed = parseKeywordReport(table);
  if (parsed.error) { $('kwInfo').textContent = parsed.error; return; }
  kw = { rows: parsed.rows, fileName: name, columns: parsed.columns };
  renderKeywords();
}
$('kwFilter').addEventListener('change', renderKeywords);
$('kwToPlan').addEventListener('click', async () => {
  if (!kw) return;
  const add = negKeywordChanges(kw.rows, rows);
  if (!add.length) { $('kwInfo').textContent = '추가할 제외 키워드가 없습니다 (낭비 키워드가 없거나 이미 제외됨)'; return; }
  await mergePlan(add);
  $('kwInfo').textContent = `${add.length}개 캠페인에 제외 키워드 추가안을 만들었습니다 → 「수정 사항」 탭`;
  showSub('plan');
});
$('kwExport').addEventListener('click', () => kw && download(`coupang-store-tool_키워드_${new Date().toISOString().slice(0, 10)}.csv`, keywordsCSV(kw.rows)));

function renderKeywords() {
  if (!kw) { $('kwToolbar').hidden = true; $('kwList').innerHTML = ''; return; }
  analyzeKeywords(kw.rows, rows, { marginRate: margin, margins });
  if (!renderKeywords.busy) { renderKeywords.busy = true; renderList(); renderKeywords.busy = false; }   // 캠페인 카드의 제외 추천 갱신
  $('kwToolbar').hidden = false;
  const waste = kw.rows.filter((r) => r.flag === 'WASTE' && !r.alreadyExcluded);
  $('kwInfo').textContent = `${kw.fileName}: 키워드 ${kw.rows.length}개 · 낭비 키워드 ${waste.length}개 (광고비 ${won(waste.reduce((a, r) => a + r.spend, 0))}) · 전환 기준 열: ${kw.columns.orders || '-'}`;
  const f = $('kwFilter').value;
  const list = kw.rows.filter((r) => !f || (f === 'EXCLUDED' ? r.alreadyExcluded : r.flag === f));
  const lab = { WASTE: '낭비', LOSS: '손익분기 미달', GOOD: '우수' };
  $('kwList').innerHTML = list.slice(0, 300).map((r) => {
    return `<div class="item"><div class="kwrow"><span class="k">${esc(r.keyword)}${r.flag ? `<span class="flag ${r.flag}">${lab[r.flag]}</span>` : ''}${r.alreadyExcluded ? '<span class="flag EX">제외됨</span>' : ''}</span><span>${won(r.spend)}</span>
      <span class="ids">${esc(r.campaignName || r.campaignId)} · 클릭 ${r.clicks} · 주문 ${r.orders} · ROAS ${r.spend ? r.roas + '%' : '-'}</span></div></div>`;
  }).join('') || '<div class="empty">조건에 맞는 키워드가 없습니다</div>';
}

// ── 수정 사항 ──
async function savePlan() { await chrome.storage.local.set({ adPlan: plan }); }
async function mergePlan(changes) {
  for (const c of changes) {
    const i = plan.findIndex((p) => p.key === c.key);
    if (i >= 0) plan[i] = { ...plan[i], ...c };
    else plan.push({ selected: false, ...c });
  }
  await savePlan(); renderPlan();
}
function renderPlanCount() { $('planCnt').textContent = plan.length; }

// 변경안 기준 (설정 adPlanRules)
let planRules = { ...PLAN_RULE_DEFAULTS };
const ruleInputs = { roasStep: 'ruleRoasStep', budgetStep: 'ruleBudgetStep', minOrders: 'ruleMinOrders', cooldownDays: 'ruleCooldown', learnDays: 'ruleLearn' };
function renderRules() { for (const [k, id] of Object.entries(ruleInputs)) $(id).value = planRules[k]; }
for (const [k, id] of Object.entries(ruleInputs)) {
  $(id).addEventListener('change', async () => {
    const el = $(id);
    const v = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value)));
    planRules[k] = Number.isFinite(v) ? v : PLAN_RULE_DEFAULTS[k];
    el.value = planRules[k];
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, adPlanRules: planRules } });
  });
}

$('planAuto').addEventListener('click', async () => {
  if (!snap) { $('planMsg').textContent = '먼저 광고 점검을 하세요'; return; }
  const { adApplyLog = [] } = await chrome.storage.local.get('adApplyLog');
  const add = proposeChanges(rows, { marginRate: margin, margins, ...planRules, days: snap.days, recent: recentChangeIndex(adApplyLog) });
  await mergePlan(add);
  const be = breakEvenRoas(margin);
  const head = add.length ? `진단 결과로 변경안 ${add.length}개를 만들었습니다 (마진율 ${margin}% → 손익분기 ROAS ${be}%). 값을 확인·수정하고 적용할 항목을 선택하세요.` : `진단 결과로 만들 변경안이 없습니다 (마진율 ${margin}% → 손익분기 ROAS ${be}%)`;
  const sk = add.skipped || [];
  $('planMsg').innerHTML = esc(head) + (sk.length ? `<br><span class="muted">변경하지 않은 캠페인 ${sk.length}개: ${sk.slice(0, 12).map((x) => esc(`${x.campaignName} — ${x.reason}`)).join('<br>')}${sk.length > 12 ? '<br>…' : ''}</span>` : '')
    + (be >= 700 ? `<br><span class="warnline">전체 마진율 ${margin}%로 손익분기 ROAS가 ${be}%입니다. 실제 마진(광고비 제외 전 이익률)과 맞는지 확인하고, 상품마다 다르면 캠페인 카드에서 캠페인별 마진율을 넣으세요.</span>` : '')
    + (Object.keys(margins).length ? `<br><span class="muted">캠페인별 마진율 ${Object.keys(margins).length}개 적용</span>` : '');
});
$('planClear').addEventListener('click', async () => {
  if (!plan.length || !confirm('수정 사항 목록을 비울까요? (광고 설정은 바뀌지 않습니다)')) return;
  plan = []; lastResults = {}; await savePlan(); renderPlan();
});

function renderPlan() {
  renderPlanCount();
  if (!plan.length) { $('planList').innerHTML = '<div class="empty">수정 사항이 없습니다.<br>「진단 결과로 변경안 만들기」, 키워드 탭의 「제외 키워드 추가안 만들기」, 또는 수정안 CSV 올리기로 추가하세요.</div>'; $('planApply').disabled = true; return; }
  $('planApply').disabled = !plan.some((c) => c.selected && CHANGE_FIELDS[c.field].auto);
  $('planList').innerHTML = plan.map((c, i) => {
    const F = CHANGE_FIELDS[c.field];
    const err = validateChange(c), warn = changeWarning(c), res = lastResults[c.key];
    const input = c.field === 'negKeywords'
      ? `<textarea class="to" data-i="${i}">${esc(c.to)}</textarea>`
      : c.field === 'isActive'
        ? `<select class="to" data-i="${i}"><option ${c.to === 'ON' ? 'selected' : ''}>ON</option><option ${c.to === 'OFF' ? 'selected' : ''}>OFF</option></select>`
        : `<input class="to" data-i="${i}" type="number" value="${esc(c.to)}" />${F.unit}`;
    return `<div class="item plan">
      <div class="t">${F.auto ? `<input type="checkbox" data-sel="${i}" ${c.selected ? 'checked' : ''} /> ` : ''}${esc(c.campaignName)} · ${esc(F.label)}</div>
      <div class="ids">캠페인ID ${esc(c.campaignId)}${c.groupId ? ` · 광고그룹 ${esc(c.groupId)}` : ''} · ${c.source === 'upload' ? '업로드' : c.source === 'keyword' ? '키워드 분석' : '진단'}</div>
      <div class="row2">${c.field === 'negKeywords' ? '' : `현재 <b>${esc(fieldVal(c.field, c.from))}</b> →`} ${input}</div>
      <div class="hint">${esc(c.reason || '')}</div>
      ${err ? `<div class="warnline">⛔ ${esc(err)}</div>` : warn ? `<div class="warnline">⚠ ${esc(warn)}</div>` : ''}
      ${res ? `<div class="res ${res.ok ? 'ok' : 'ng'}">${res.ok ? '✅' : '❌'} ${esc(res.message)}${res.actual !== undefined && res.actual !== null ? ` (확인된 값: ${esc(fieldVal(c.field, res.actual))})` : ''}</div>` : ''}
      <div class="acts">
        ${c.field === 'negKeywords' ? `<button class="rq" data-neg="${i}">복사 + 편집 화면 열기</button>` : ''}
        <button class="ig" data-del="${i}">삭제</button>
      </div></div>`;
  }).join('');
}

$('planList').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.sel !== undefined) { plan[Number(t.dataset.sel)].selected = t.checked; await savePlan(); renderPlan(); return; }
  if (t.classList.contains('to')) {
    const c = plan[Number(t.dataset.i)];
    c.to = c.field === 'budget' || c.field === 'roasTarget' ? Number(t.value) : t.value;
    await savePlan(); renderPlan();
  }
});
$('planList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { plan.splice(Number(del.dataset.del), 1); await savePlan(); renderPlan(); return; }
  const neg = e.target.closest('[data-neg]');
  if (neg) {
    const c = plan[Number(neg.dataset.neg)];
    const list = String(c.to).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    try { await navigator.clipboard.writeText(list.join('\n')); } catch (err) { /* 무시 */ }
    const camp = rows.find((r) => r.id === String(c.campaignId));
    const url = adEditUrl(c.campaignId, c.groupId, camp && camp.isAiSmart);
    alert(`제외 키워드 ${list.length}개를 복사했습니다 (한 줄에 하나).\n\n열리는 편집 화면의 「키워드 제외 → 제외 키워드 입력」에 붙여넣고 「추가」, 마지막 단계에서 「완료」를 눌러 저장하세요.\n제외 키워드는 캠페인당 최대 500개입니다.`);
    if (url) chrome.tabs.create({ url, active: true });
  }
});

// 선택 항목 적용 (사용자 동의 필수)
$('planApply').addEventListener('click', async () => {
  const sel = plan.filter((c) => c.selected && CHANGE_FIELDS[c.field].auto);
  const bad = sel.filter((c) => validateChange(c));
  if (bad.length) { alert(`값을 확인하세요:\n${bad.map((c) => `· ${c.campaignName} ${CHANGE_FIELDS[c.field].label}: ${validateChange(c)}`).join('\n')}`); return; }
  if (!sel.length) return;
  const lines = sel.map((c) => `· ${c.campaignName} — ${CHANGE_FIELDS[c.field].label}: ${fieldVal(c.field, c.from)} → ${fieldVal(c.field, c.to)}${changeWarning(c) ? `  (⚠ ${changeWarning(c)})` : ''}`);
  if (!confirm(`다음 ${sel.length}개 변경을 쿠팡 광고센터에 적용합니다.\n실제 광고 운영(광고비 지출)이 바뀝니다.\n\n${lines.join('\n')}\n\n적용할까요?`)) return;
  $('planApply').disabled = true; $('planMsg').textContent = '적용 중… (항목마다 적용 후 다시 조회해 확인합니다)';
  const res = await chrome.runtime.sendMessage({ type: 'adsApply', changes: sel });
  if (!res || !res.ok) { $('planMsg').textContent = `적용 실패: ${res && res.error === 'ADS_AUTH' ? '광고센터 로그인이 필요합니다' : (res && res.error) || '알 수 없는 오류'}`; renderPlan(); return; }
  for (const r of res.results) lastResults[r.key] = r;
  const ok = res.results.filter((r) => r.ok).length;
  $('planMsg').textContent = `적용 완료: 성공 ${ok}개 / 실패·미확인 ${res.results.length - ok}개. 성공한 항목은 목록에서 빠집니다.`;
  plan = plan.filter((c) => !(lastResults[c.key] && lastResults[c.key].ok));
  await savePlan(); renderPlan(); renderLog();
});

// 적용 기록 + 변경 효과 (적용 전 하루 평균 vs 적용 후 하루 평균)
async function renderLog() {
  const { adApplyLog = [], adsSnapshots = [] } = await chrome.storage.local.get(['adApplyLog', 'adsSnapshots']);
  const eff = new Map(evaluateEffects(adApplyLog, adsSnapshots, { marginRate: margin, margins, waitDays: planRules.cooldownDays }).map((e) => [e.at + '|' + e.campaignId + '|' + e.field, e]));
  const mline = (m) => `광고비 ${won(m.spend)} · 매출 ${won(m.sales)} · ROAS ${m.roas}% · 이익 ${won(m.profit)}`;
  const effHtml = (e) => {
    if (!e) return '';
    const lab = EFFECT_LABELS[e.status];
    if (e.status === 'WAIT') return `<div class="ids eff">⏳ ${lab} (${e.daysSince}/${planRules.cooldownDays}일)</div>`;
    if (e.status === 'NEED_SCAN') return `<div class="ids eff">🔎 ${lab}: 기간 「최근 7일」로 광고 점검하면 적용 후 성과와 비교합니다</div>`;
    if (!e.afterM) return `<div class="ids eff">${lab}</div>`;
    return `<div class="eff ${e.status}"><b>${e.status === 'BETTER' ? '📈' : e.status === 'WORSE' ? '📉' : '➖'} ${lab}</b> <span class="ids">(하루 평균, 마진율 기준 이익)</span>
      <div class="ids">적용 전: ${mline(e.beforeM)}</div><div class="ids">적용 후: ${mline(e.afterM)}</div></div>`;
  };
  $('logList').innerHTML = adApplyLog.slice().reverse().slice(0, 100).map((l) =>
    `<div class="item"><div class="ids">${esc(fmt(l.at))}${l.demo ? ' (데모)' : ''}</div><div>${l.ok ? '✅' : '❌'} ${esc(l.campaignName)} · ${esc(CHANGE_FIELDS[l.field] ? CHANGE_FIELDS[l.field].label : l.field)}: ${esc(fieldVal(l.field, l.from))} → ${esc(fieldVal(l.field, l.to))}</div><div class="ids">${esc(l.message)}</div>${l.ok && !l.demo ? effHtml(eff.get(l.at + '|' + l.campaignId + '|' + l.field)) : ''}</div>`).join('') || '<div class="muted">기록 없음</div>';
}

function renderStatus(st) {
  const el = $('adStatus');
  el.className = 'status';
  if (st && st.state === 'running') {
    el.classList.add('running');
    const p = st.progress;
    if (p && p.phase === 'cooldown') { el.textContent = '광고센터 응답이 막혀 1분 쉬었다가 다시 시도합니다…'; $('adScanBtn').disabled = true; return; }
    if (st.waiting === 'login') { el.textContent = '광고센터 로그인 대기 중… 열린 화면에서 「쿠팡 마켓플레이스 & 로켓그로스 판매자 → 로그인하기」를 누르면 자동으로 점검을 시작합니다. (최대 3분)'; $('adScanBtn').disabled = true; return; }
    el.textContent = `광고 점검 중… ${p ? (p.phase === 'metrics' ? `캠페인 성과 ${p.done}/${p.total}` : p.phase === 'details' ? `광고그룹 상세 ${p.done}/${p.total}` : p.phase === 'products' ? `광고 상품 목록 ${p.done}/${p.total}` : `캠페인 ${p.done}개 확인`) : '광고센터 화면으로 이동 중'}`;
    $('adScanBtn').disabled = true;
    return;
  }
  $('adScanBtn').disabled = false;
  const line = snap ? `점검 시각: ${fmt(snap.at)} · 기간 ${snap.days}일 (${day(snap.start)}~${day(snap.end)})` : '';
  if (st && st.state === 'error') { el.classList.add('error'); el.textContent = st.code === 'TOO_SOON' ? `${st.message} ${line}` : `광고 점검 실패: ${st.message}`; return; }
  const note = [snap && snap.demo ? '(데모 데이터)' : '', snap && snap.errors && snap.errors.length ? snap.errors.join(', ') : ''].filter(Boolean).join(' ');
  if (st && st.warning) el.classList.add('error');
  el.textContent = snap ? `${st && st.warning ? st.warning + ' · ' : ''}${line} ${note}` : '';
}

async function load() {
  const { adsSnapshots = [], adsStatus, settings = {}, adPlan = [], snapshots = [], trendsSnapshot = null } = await chrome.storage.local.get(['adsSnapshots', 'adsStatus', 'settings', 'adPlan', 'snapshots', 'trendsSnapshot']);
  trendKeywords = trendsSnapshot ? (trendsSnapshot.categories || []).flatMap((c) => (c.keywords || []).map((k, i) => ({ keyword: k, categoryName: c.name, categoryRank: i + 1 }))) : [];
  const lp = snapshots[snapshots.length - 1];
  productRows = lp ? lp.rows || [] : [];
  snap = adsSnapshots.length ? adsSnapshots[adsSnapshots.length - 1] : null;
  margin = Number(settings.adMarginRate) || AD_DEFAULTS.marginRate;
  margins = { ...(settings.adMargins || {}) };
  planRules = { ...PLAN_RULE_DEFAULTS, ...(settings.adPlanRules || {}) };
  renderRules();
  plan = adPlan;
  $('adMargin').value = margin;
  if (snap) $('adDays').value = String(snap.days || 7);
  render(); renderStatus(adsStatus); renderLog();
}

chrome.storage.onChanged.addListener((c) => { if (c.adsSnapshots || c.adsStatus || c.snapshots || c.trendsSnapshot) load(); });
load();

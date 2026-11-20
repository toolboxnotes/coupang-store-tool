// 사이드 패널 「광고 → 인기 키워드」
//  내 상품 카테고리(최신 상품 점검 결과) → WING 쿠팡 인기 상품 검색의 카테고리 인기 검색어 → 키워드별 상위 상품·내 상품 순위
//  추천: 인기 검색어인데 내 상품이 순위 밖·하위권이거나 제외 키워드로 막혀 있는 키워드 (수요 큰 순)
import { categoriesFromRows, rowsHaveCategory, analyzeTrends, TREND_FLAGS, pvRange, trendsCSV, trendsKeywordUrl, TRENDS_PAGE_URL } from './lib/trendcore.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Math.round(n || 0).toLocaleString('ko-KR');
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { hour12: false }) : '-');

let productRows = [];
let adRows = [];
let cats = [];
let trends = null;
let analysis = null;
let selected = null; // 선택한 카테고리 코드 (settings.trendCodes)

function renderCats() {
  const box = $('trCats');
  if (!productRows.length) { box.innerHTML = '<div class="muted">상품 점검 결과가 없습니다. 먼저 「지금 점검」을 실행하세요.</div>'; $('trRun').disabled = true; return; }
  if (!rowsHaveCategory(productRows)) { box.innerHTML = '<div class="muted">점검 결과에 카테고리 정보가 없습니다. 「지금 점검」을 한 번 다시 실행하세요.</div>'; $('trRun').disabled = true; return; }
  $('trRun').disabled = false;
  const sel = new Set(selected && selected.length ? selected : cats.slice(0, 3).map((c) => c.code));
  box.innerHTML = cats.slice(0, 40).map((c) => `<label><input type="checkbox" value="${esc(c.code)}" ${sel.has(c.code) ? 'checked' : ''}/> ${esc(c.name)} <span class="muted">판매중 ${c.active}/${c.products}개${c.sold ? ` · 판매 ${num(c.sold)}` : ''}</span></label>`).join('')
    + (cats.length > 40 ? `<div class="muted">외 ${cats.length - 40}개 카테고리 (상품 수가 적은 순으로 생략)</div>` : '');
}
function checkedCodes() { return [...$('trCats').querySelectorAll('input:checked')].map((x) => x.value); }

$('trCats').addEventListener('change', async () => {
  let codes = checkedCodes();
  if (codes.length > 15) { $('trStatus').textContent = '카테고리는 한 번에 15개까지 선택할 수 있습니다'; const last = $('trCats').querySelectorAll('input:checked'); last[last.length - 1].checked = false; codes = checkedCodes(); }
  selected = codes;
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, trendCodes: codes } });
});

$('trRun').addEventListener('click', async () => {
  const codes = checkedCodes();
  if (!codes.length) { $('trStatus').textContent = '조회할 카테고리를 선택하세요'; return; }
  const detail = $('trDetail').checked;
  const sec = Math.min(60, codes.length * 10) * (detail ? 4.5 : 0) + codes.length * 4;
  $('trStatus').textContent = `조회 시작… (예상 약 ${Math.max(1, Math.round(sec / 60))}분)`;
  $('trRun').disabled = true;
  await chrome.runtime.sendMessage({ type: 'trends', codes, detail });
  $('trRun').disabled = false;
});
$('trOpen').addEventListener('click', () => chrome.tabs.create({ url: TRENDS_PAGE_URL, active: true }));
$('trView').addEventListener('change', renderList);
$('trExport').addEventListener('click', () => analysis && download(`coupang-store-tool_인기키워드_${new Date().toISOString().slice(0, 10)}.csv`, trendsCSV(analysis.keywords.filter((r) => !r.duplicate))));

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 카드 버튼: 링크 열기 / 키워드 복사
$('trList').addEventListener('click', async (e) => {
  const link = e.target.closest('[data-url]');
  if (link) { chrome.tabs.create({ url: link.dataset.url, active: true }); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = '복사됨'; setTimeout(() => (cp.textContent = '복사'), 1200); } catch (err) { /* 무시 */ } }
});

function card(r, showCat) {
  const d = r.detail;
  const flags = r.flags.map((f) => `<span class="flag ${f}" title="${esc(TREND_FLAGS[f].tip)}">${esc(TREND_FLAGS[f].label)}</span>`).join('');
  const main = r.flags.find((f) => ['EXCLUDED', 'MISSING', 'LOW', 'TOP'].includes(f));
  const stats = d
    ? `판매 1위 상품 28일 조회수 ${pvRange(d.topPvLower, d.topPvUpper)} · 상위 10개 평균 ${num(d.avgPv10)} · 가격 중앙값 ${num(d.priceMedian)}원 · 평균 리뷰 ${num(d.avgReviews10)}`
    : '상세 미조회 (「키워드별 상세」를 켜고 다시 조회)';
  const mine = d ? (d.myRank ? `내 상품 <b>${d.myRank}위</b>${d.myItem && d.myItem.productName ? ` · ${esc(d.myItem.productName)}` : ''}${r.myPrice ? ` · 내 가격 ${num(r.myPrice)}원` : ''}` : '내 상품 <b>60위 밖</b>') : '';
  return `<div class="item">
    <div class="kwrow"><span class="k">${esc(r.keyword)}${flags}</span><span class="ids">${showCat ? esc(r.categoryName) + ' ' : ''}인기 ${r.categoryRank}위</span></div>
    <div class="ids">${stats}</div>
    ${mine ? `<div>${mine}</div>` : ''}
    ${r.excludedIn.length ? `<div class="ids">제외 키워드로 설정된 캠페인: ${esc(r.excludedIn.join(', '))}</div>` : ''}
    ${main ? `<div class="ids">→ ${esc(TREND_FLAGS[main].tip)}</div>` : ''}
    ${d && d.related && d.related.length ? `<div class="trrel">${d.related.map((k) => `<span data-url="${esc(trendsKeywordUrl(k))}" title="쿠팡 인기 상품 검색에서 보기">${esc(k)}</span>`).join('')}</div>` : ''}
    <div class="toolbar"><button data-copy="${esc(r.keyword)}">복사</button><button data-url="${esc(trendsKeywordUrl(r.keyword))}">검색 결과 보기 ↗</button></div>
  </div>`;
}

function renderList() {
  if (!analysis || !analysis.keywords.length) { $('trToolbar').hidden = true; $('trList').innerHTML = ''; return; }
  $('trToolbar').hidden = false;
  const v = $('trView').value;
  let html = '';
  if (v === 'rec') {
    const list = analysis.recommend;
    html = `<div class="trhead">보강 추천 ${list.length}개 <span class="muted">(제외 키워드 충돌 → 수요 큰 순)</span></div>`
      + (list.map((r) => card(r, true)).join('') || '<div class="empty">보강할 키워드가 없습니다 (모두 내 상품 상위권)</div>');
  } else if (v === 'cat') {
    for (const c of analysis.categories) {
      const list = analysis.keywords.filter((r) => r.categoryCode === c.code);
      html += `<div class="trhead">${esc(c.name)} <span class="muted">내 상품 ${c.products || '-'}개</span></div>` + (list.map((r) => card(r, false)).join('') || '<div class="empty">인기 검색어 없음</div>');
    }
  } else {
    const list = analysis.keywords.filter((r) => !r.duplicate && r.flags.includes(v));
    html = list.map((r) => card(r, true)).join('') || '<div class="empty">해당 키워드가 없습니다</div>';
  }
  $('trList').innerHTML = html;
}

let lastStatus = null;
function renderStatusLine() {
  const st = lastStatus;
  const el = $('trStatus');
  el.className = 'status';
  if (st && st.state === 'running') {
    el.classList.add('running');
    const p = st.progress;
    el.textContent = p && p.phase === 'cooldown' ? '쿠팡 응답이 막혀 40초 쉬었다가 다시 시도합니다…'
      : `조회 중… ${p ? (p.phase === 'categories' ? `카테고리 ${p.done}/${p.total}` : `키워드 상세 ${p.done}/${p.total}`) : 'WING 여는 중'}`;
    $('trRun').disabled = true;
    return;
  }
  $('trRun').disabled = !productRows.length || !rowsHaveCategory(productRows);
  if (st && st.state === 'error') { el.classList.add('error'); el.textContent = `조회 실패: ${st.message}`; return; }
  if (!trends) { el.textContent = ''; return; }
  const n = analysis ? analysis.keywords.filter((r) => !r.duplicate).length : 0;
  if (st && st.warning) el.classList.add('error');
  el.textContent = `${st && st.warning ? st.warning + ' · ' : ''}조회 시각: ${fmt(trends.finishedAt || trends.at)} · 카테고리 ${trends.categories.length}개 · 키워드 ${n}개${trends.demo ? ' (데모 데이터)' : ''}${trends.errors && trends.errors.length ? ` · ${trends.errors.slice(0, 3).join(', ')}` : ''}`;
}

async function load() {
  const { snapshots = [], adsSnapshots = [], trendsSnapshot = null, trendsStatus = null, settings = {} } =
    await chrome.storage.local.get(['snapshots', 'adsSnapshots', 'trendsSnapshot', 'trendsStatus', 'settings']);
  const last = snapshots[snapshots.length - 1];
  productRows = last ? last.rows || [] : [];
  const ad = adsSnapshots[adsSnapshots.length - 1];
  adRows = ad ? ad.rows || [] : [];
  cats = categoriesFromRows(productRows);
  if (selected === null) selected = settings.trendCodes || [];
  trends = trendsSnapshot;
  if (trends) {
    // 카테고리 상품 수는 현재 점검 결과 기준으로 표시
    const byCode = Object.fromEntries(cats.map((c) => [c.code, c]));
    trends = { ...trends, categories: trends.categories.map((c) => ({ ...c, ...(byCode[c.code] ? { products: byCode[c.code].products } : {}) })) };
  }
  analysis = trends ? analyzeTrends(trends, productRows, adRows) : null;
  lastStatus = trendsStatus;
  renderCats(); renderStatusLine(); renderList();
}
chrome.storage.onChanged.addListener((c) => { if (c.snapshots || c.adsSnapshots || c.trendsSnapshot || c.trendsStatus) load(); });
load();

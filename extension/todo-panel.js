// 사이드 패널 「요약」 → 오늘 할 일
//  상품 점검·광고 점검·수정사항·변경 효과를 모아 지금 처리할 일을 보여 줌. 항목을 누르면 해당 화면으로 이동.
import { isIgnored } from './lib/core.js';
import { analyzeCampaigns, evaluateEffects, AD_DEFAULTS, adProductIssues } from './lib/adcore.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const won = (n) => `${Math.round(n || 0).toLocaleString('ko-KR')}원`;
const DAY = 86400000;

async function render() {
  const { snapshots = [], adsSnapshots = [], adPlan = [], adApplyLog = [], settings = {}, ignores = {}, ignoreTypes = {} } =
    await chrome.storage.local.get(['snapshots', 'adsSnapshots', 'adPlan', 'adApplyLog', 'settings', 'ignores', 'ignoreTypes']);
  const items = [];   // { level: 2 빨강 / 1 주황 / 0 회색, text, go }
  const now = Date.now();

  // 상품
  const cur = snapshots[snapshots.length - 1];
  if (!cur) items.push({ level: 1, text: '아직 상품 점검을 하지 않았습니다 → 「지금 점검」', go: null });
  else {
    const ch = (cur.changes || []).filter((c) => !(c.issue && isIgnored(c.row, c.issue, ignores, ignoreTypes)));
    const pid = ch.filter((c) => c.type === 'PRODUCT_ID_CHANGED').length;
    const neu = ch.filter((c) => c.type === 'ISSUE_NEW').length;
    if (pid) items.push({ level: 2, text: `노출상품ID가 바뀐 옵션 ${pid}개 (타사 상품에 매칭됐을 수 있음)`, go: 'changes' });
    if (neu) items.push({ level: 1, text: `새로 생긴 문제 ${neu}건`, go: 'changes' });
    const age = Math.floor((now - Date.parse(cur.at)) / DAY);
    if (age >= 2) items.push({ level: 1, text: `마지막 상품 점검 후 ${age}일 지났습니다 → 「지금 점검」`, go: null });
  }

  // 광고
  const ads = adsSnapshots.filter((x) => !x.demo || settings.demoMode);
  const last = ads[ads.length - 1];
  const margin = Number(settings.adMarginRate) || AD_DEFAULTS.marginRate;
  const margins = settings.adMargins || {};
  if (last) {
    const rows = analyzeCampaigns(last.rows.map((r) => ({ ...r })), { marginRate: margin, margins });
    const on = rows.filter((r) => r.isActive);
    const off = on.filter((r) => r.flags.includes('NO_CONV'));
    const loss = on.filter((r) => r.flags.includes('LOSS'));
    if (off.length) items.push({ level: 2, text: `전환 없이 광고비만 쓰는 캠페인 ${off.length}개 (${won(off.reduce((a, r) => a + r.spend, 0))})`, go: 'ads' });
    if (loss.length) items.push({ level: 2, text: `손익분기 미달 캠페인 ${loss.length}개`, go: 'ads' });
    const ap = cur ? adProductIssues(last, cur.rows || []) : [];
    if (ap.length) items.push({ level: 2, text: `광고 중인데 노출 제한·품절·아이템위너 아닌 상품 ${ap.length}개 (광고비 ${won(ap.reduce((a, x) => a + x.spend, 0))})`, go: 'issues' });
    const age = Math.floor((now - Date.parse(last.at)) / DAY);
    if (age >= 7) items.push({ level: 1, text: `마지막 광고 점검 후 ${age}일 지났습니다 → 「광고 → 광고 점검」`, go: 'ads' });
  } else items.push({ level: 0, text: '광고 점검 기록이 없습니다 → 「광고 → 광고 점검」', go: 'ads' });

  const pending = adPlan.filter((c) => c.selected).length;
  if (pending) items.push({ level: 1, text: `적용하려고 선택한 수정사항 ${pending}개`, go: 'ads' });
  const eff = evaluateEffects(adApplyLog, adsSnapshots, { marginRate: margin, margins, waitDays: (settings.adPlanRules && settings.adPlanRules.cooldownDays) || 7 });
  const done = eff.filter((e) => ['BETTER', 'WORSE', 'SAME'].includes(e.status));
  const need = eff.filter((e) => e.status === 'NEED_SCAN');
  const worse = done.filter((e) => e.status === 'WORSE');
  if (worse.length) items.push({ level: 2, text: `변경 후 오히려 나빠진 캠페인 ${worse.length}개 → 되돌릴지 확인`, go: 'ads' });
  if (need.length) items.push({ level: 1, text: `변경 효과 확인 가능 ${need.length}건 → 기간 「최근 7일」로 광고 점검`, go: 'ads' });

  items.sort((a, b) => b.level - a.level);
  $('todo').innerHTML = `<div class="todohead">오늘 할 일</div>` + (items.length
    ? items.map((x, i) => `<div class="todoitem l${x.level}" ${x.go ? `data-go="${x.go}"` : ''} data-i="${i}">${esc(x.text)}${x.go ? ' <span class="muted">›</span>' : ''}</div>`).join('')
    : '<div class="todoitem l0">처리할 일이 없습니다 👍</div>');
}

$('todo').addEventListener('click', (e) => {
  const it = e.target.closest('[data-go]');
  if (it && window.switchTab) window.switchTab(it.dataset.go);
});
chrome.storage.onChanged.addListener((c) => {
  if (c.snapshots || c.adsSnapshots || c.adPlan || c.adApplyLog || c.settings || c.ignores || c.ignoreTypes) render();
});
render();

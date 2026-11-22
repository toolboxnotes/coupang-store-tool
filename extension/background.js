// 백그라운드 서비스 워커: 점검 실행, 자동 점검 예약, 스냅샷 저장, 알림
import { wingListPageInPage, wingDetailBatchInPage } from './lib/wing.js';
import { adsScanInPage } from './lib/ads.js';
import { adsApplyInPage } from './lib/adsWrite.js';
import { trendsInPage } from './lib/trends.js';
import { categoriesFromRows, rowsHaveCategory, demoTrends, TRENDS_PAGE_URL } from './lib/trendcore.js';
import { AD_PRODUCT_ISSUES, normalizeAds, demoAds, validateChange } from './lib/adcore.js';
import { normalize, isInactive, applyFilterMembership, diagnose, summarize, diffSnapshots, demoScan, ISSUE_DEFS, isIgnored, applyIgnores } from './lib/core.js';

const DEFAULT_SETTINGS = { autoScan: true, adsReminder: true, scanHour: 9, demoMode: false, pageSize: 50, delayMs: 2000, keepSnapshots: 7, notify: true, excludeInactive: true, collectDetail: true };
const WING_LIST_URL = 'https://wing.coupang.com/vendor-inventory/list';

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); // 아이콘 클릭 시 사이드 패널 열기
  await scheduleAlarm();
});
chrome.runtime.onStartup.addListener(scheduleAlarm);

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// 매일 지정 시각에 자동 점검 (Chrome이 켜져 있을 때만 실행됨)
async function scheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear('ads-reminder');
  if (s.adsReminder) {
    const t = new Date(); t.setHours(s.scanHour, 30, 0, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    chrome.alarms.create('ads-reminder', { when: t.getTime(), periodInMinutes: 24 * 60 });
  }
  await chrome.alarms.clear('daily-scan');
  if (!s.autoScan) return;
  const next = new Date();
  next.setHours(s.scanHour, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('daily-scan', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'daily-scan') runScan('auto');
  if (a.name === 'ads-reminder') adsReminder();
});

// 매주 광고 점검 알림: 마지막 광고 점검이 7일 넘었으면 알림 (광고센터는 자동 점검하지 않음 — 차단 방지)
async function adsReminder() {
  const s = await getSettings();
  if (!s.adsReminder || s.demoMode) return;
  const { adsSnapshots = [], adsReminderAt = 0 } = await chrome.storage.local.get(['adsSnapshots', 'adsReminderAt']);
  const real = adsSnapshots.filter((x) => !x.demo);
  if (!real.length) return;                                   // 광고 점검을 한 번도 안 했으면 알리지 않음
  const last = Date.parse(real[real.length - 1].at);
  const now = Date.now();
  if (now - last < 7 * 86400000 || now - adsReminderAt < 6 * 86400000) return;
  await chrome.storage.local.set({ adsReminderAt: now });
  chrome.notifications.create('ads-reminder', {
    type: 'basic', iconUrl: 'icons/icon128.png', title: '광고 점검할 때입니다',
    message: `마지막 광고 점검 후 ${Math.floor((now - last) / 86400000)}일 지났습니다. 사이드 패널 「광고 → 광고 점검」으로 이번 주 성과와 변경 효과를 확인하세요.`,
  });
}

let running = false;

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
}

// 열려 있는 WING 탭을 사용하고, 없으면 백그라운드 탭을 열어 사용 (점검 후 자동으로 닫음)
async function findOrOpenWingTab() {
  const tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/*' });
  if (tabs.length) return { tab: tabs[0], opened: false };
  const tab = await chrome.tabs.create({ url: WING_LIST_URL, active: false });
  await new Promise((resolve) => {
    const listener = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 20000);
  });
  return { tab, opened: true };
}

// ── 상품 점검: 짧은 단계로 나눠 실행하고 단계마다 진행 상황(scanJob)을 저장 ──
//  - 「중지」: 지금 단계가 끝나면 멈춤 → 「이어서 점검」으로 계속 / 「처음부터」로 버림
//  - 로그인 만료·차단·네트워크 오류: 멈춤 상태로 저장 → 문제 해결 후 이어서 점검
//  - 브라우저 종료·PC 절전 등으로 백그라운드가 멈추면 다음 실행 때 「멈춤」으로 표시
const JOB_TTL = 12 * 3600000;        // 12시간이 지난 진행 상황은 버리고 처음부터
const DETAIL_BATCH = 15;             // 상세 정보 한 단계에 15개 (약 30초)
let stopRequested = false;

async function loadJob() {
  const { scanJob } = await chrome.storage.local.get('scanJob');
  if (!scanJob) return null;
  if (Date.now() - Date.parse(scanJob.startedAt) > JOB_TTL) { await chrome.storage.local.remove('scanJob'); return null; }
  return scanJob;
}
const saveJob = (job) => chrome.storage.local.set({ scanJob: { ...job, updatedAt: new Date().toISOString() } });
const jobProgress = (job) => job.stage === 'list'
  ? { phase: 'list', done: Math.max(0, job.page - 1), total: job.totalPages || 0 }
  : { phase: 'detail', done: job.detailDone, total: (job.detailTargets || []).length };

// 백그라운드가 다시 시작됐는데 상태가 「점검 중」이면 = 중간에 끊긴 것 → 멈춤으로 표시
(async () => {
  const { status } = await chrome.storage.local.get('status');
  if (status && status.state === 'running' && !running) {
    const job = await loadJob();
    await setStatus(job
      ? { state: 'paused', trigger: status.trigger, reason: 'INTERRUPTED', progress: jobProgress(job) }
      : { state: 'error', trigger: status.trigger, code: 'INTERRUPTED', message: '점검이 중간에 끊겼습니다 (브라우저 종료·절전 등). 다시 점검하세요.' });
  }
})();

async function wingTab(state) {
  if (state.tabId) {
    const t = await chrome.tabs.get(state.tabId).catch(() => null);
    if (t && /^https:\/\/wing\.coupang\.com\//.test(t.url || '')) return t;
  }
  const w = await findOrOpenWingTab();
  if (w.opened) state.opened = w.tab.id;
  state.tabId = w.tab.id;
  return w.tab;
}
async function inWing(state, func, args) {
  const tab = await wingTab(state);
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: [args] });
  if (!res || res.result == null) throw { code: 'INJECT' };
  return res.result;
}

export async function runScan(trigger = 'manual', opts = {}) {
  if (running) return { ok: false, error: 'BUSY' };
  running = true;
  stopRequested = false;
  const s = await getSettings();
  const state = { tabId: null, opened: null };
  let job = null;
  try {
    let raw;
    if (s.demoMode) {
      await setStatus({ state: 'running', trigger });
      const { snapshots = [] } = await chrome.storage.local.get('snapshots');
      raw = demoScan(snapshots.length + 1);
    } else {
      job = opts.fresh ? null : await loadJob();
      if (!job) {
        job = { id: Date.now(), trigger, startedAt: new Date().toISOString(), stage: 'list', page: 1, totalPages: null, totalCount: 0, list: [], statusError: null, detailTargets: null, detailDone: 0, detailError: null };
        await saveJob(job);
      }
      await setStatus({ state: 'running', trigger: job.trigger, progress: jobProgress(job), resumed: job.page > 1 || job.detailDone > 0 });

      // 1) 상품 목록 + 노출 상태 (페이지 단위)
      while (job.stage === 'list') {
        if (stopRequested) throw { code: 'STOPPED' };
        if (job.page > 1) await sleep(s.delayMs);
        const r = await inWing(state, wingListPageInPage, { page: job.page, pageSize: s.pageSize, collectStatus: true, delayMs: s.delayMs });
        if (r.error) throw { code: r.error.error || 'API' };
        job.list.push(...r.list);
        job.totalPages = r.totalPages;
        job.totalCount = r.totalCount;
        if (r.statusError && !job.statusError) job.statusError = r.statusError;
        job.page++;
        if (job.page > job.totalPages || job.page > 200 || !r.list.length) {
          job.truncated = job.totalPages > 200;
          job.stage = s.collectDetail ? 'detail' : 'done';
          job.detailTargets = job.list.filter((p) => p.productStatus !== 'SUSPENDED').slice(0, 600).map((p) => p.vendorInventoryId);
        }
        await saveJob(job);
        await setStatus({ state: 'running', trigger: job.trigger, progress: jobProgress(job) });
      }

      // 2) 상세 정보 (판매중 상품, 15개씩)
      const byId = new Map(job.list.map((p) => [String(p.vendorInventoryId), p]));
      while (job.stage === 'detail') {
        if (stopRequested) throw { code: 'STOPPED' };
        const ids = job.detailTargets.slice(job.detailDone, job.detailDone + DETAIL_BATCH);
        if (!ids.length) { job.stage = 'done'; break; }
        await sleep(s.delayMs);
        const r = await inWing(state, wingDetailBatchInPage, { ids, delayMs: s.delayMs });
        for (const [pid, m] of Object.entries(r.details || {})) {
          const p = byId.get(String(pid));
          if (p) for (const it of p.vendorInventoryItems || []) if (m[String(it.vendorItemId)]) it._detail = m[String(it.vendorItemId)];
        }
        job.detailDone += r.done || 0;
        if (r.error) {
          if (r.error.error === 'AUTH' || r.error.error === 'RATE' || r.error.error === 'NETWORK') { await saveJob(job); throw { code: r.error.error }; }
          job.detailError = r.error; job.stage = 'done';            // 기타 오류: 상세는 여기까지만
        }
        if (job.detailDone >= job.detailTargets.length) job.stage = 'done';
        await saveJob(job);
        await setStatus({ state: 'running', trigger: job.trigger, progress: jobProgress(job) });
      }
      raw = {
        all: { list: job.list, totalCount: job.totalCount, truncated: !!job.truncated }, filters: {},
        statusError: job.statusError, detailError: job.detailError,
        detailCount: job.detailDone, detailTargets: (job.detailTargets || []).length, finishedAt: new Date().toISOString(),
      };
    }

    const allRows = normalize(raw.all.list);
    // 판매중지 상품·판매 불가(INVALID) 옵션은 기본적으로 점검 대상에서 제외
    const rows = diagnose(applyFilterMembership(s.excludeInactive ? allRows.filter((r) => !isInactive(r)) : allRows, raw.filters));
    const excluded = allRows.length - rows.length;
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const prev = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const changes = diffSnapshots(prev && prev.rows, rows);
    const summary = summarize(rows);
    const filterErrors = [];
    if (raw.statusError) filterErrors.push('노출 상태(아이템위너) 일부 조회 실패');
    if (raw.detailError) filterErrors.push(`상세 정보 일부만 수집 (${raw.detailCount || 0}/${raw.detailTargets || 0})`);
    const snap = {
      id: Date.now(), at: raw.finishedAt || new Date().toISOString(), trigger: (job && job.trigger) || trigger, demo: !!raw.demo,
      summary, rows, changes, truncated: !!raw.all.truncated, filterErrors, excluded,
      totalProducts: raw.all.totalCount || 0, detailCount: raw.detailCount || 0, detailTargets: raw.detailTargets || 0,
      sample: raw.all.list && raw.all.list.length ? (raw.all.list.find((p) => p.productStatus !== 'SUSPENDED') || raw.all.list[0]) : null, // 필드 보정용 원본 샘플 1건
    };
    snapshots.push(snap);
    while (snapshots.length > s.keepSnapshots) snapshots.shift(); // 최근 N회만 보관
    await chrome.storage.local.set({ snapshots });
    await chrome.storage.local.remove('scanJob');
    await setStatus({ state: 'done', trigger: snap.trigger, lastId: snap.id });

    // 새로 생긴 주의 이상 문제가 있으면 알림 (무시 목록에 있는 문제는 제외)
    const { ignores = {}, ignoreTypes = {} } = await chrome.storage.local.get(['ignores', 'ignoreTypes']);
    const newBad = changes.filter((c) => {
      const issue = c.type === 'PRODUCT_ID_CHANGED' ? 'PRODUCT_ID_CHANGED' : c.issue;
      if (c.type !== 'PRODUCT_ID_CHANGED' && !(c.type === 'ISSUE_NEW' && ISSUE_DEFS[c.issue].level >= 2)) return false;
      return !isIgnored(c.row, issue, ignores, ignoreTypes);
    });
    if (s.notify && newBad.length) {
      const vs = summarize(applyIgnores(rows, ignores, ignoreTypes)); // 무시 제외 통계
      chrome.notifications.create(`sl-${snap.id}`, {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'coupang-store-tool: 새로운 문제 발견',
        message: `새 문제 ${newBad.length}건 (노출제한 ${vs.counts.SUPPRESSED}, 아이템위너 아님 ${vs.counts.LOSER}). 확장 아이콘을 눌러 확인하세요.`,
      });
    }
    return { ok: true, id: snap.id };
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    const tr = (job && job.trigger) || trigger;
    // 진행 상황이 있으면 「멈춤」(이어서 점검 가능), 없으면 오류
    if (job && ['STOPPED', 'AUTH', 'RATE', 'NETWORK', 'INJECT'].includes(code)) {
      await setStatus({ state: 'paused', trigger: tr, reason: code, progress: jobProgress(job) });
    } else {
      await setStatus({ state: 'error', trigger: tr, code, message: (e && e.message) || errorText(code) });
    }
    if (tr === 'auto' && code === 'AUTH' && s.notify) {
      chrome.notifications.create('sl-auth', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'coupang-store-tool: WING 로그인 필요', message: '자동 점검이 멈췄습니다. Chrome에서 WING에 로그인한 뒤 「이어서 점검」을 눌러주세요.' });
    }
    return { ok: false, error: code };
  } finally {
    running = false;
    stopRequested = false;
    if (state.opened) chrome.tabs.remove(state.opened).catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5))));

function errorText(code) {
  return {
    AUTH: 'WING 로그인이 만료되었습니다. Chrome에서 wing.coupang.com에 다시 로그인한 뒤 시도하세요.',
    RATE: 'WING 요청이 너무 많아 멈췄습니다. 30분쯤 뒤 이어서 점검하세요.',
    NETWORK: '네트워크 오류 또는 WING이 요청을 잠시 막아 멈췄습니다. 잠시 뒤 이어서 점검하세요.',
    API: 'WING이 오류를 반환해 중단했습니다. 화면 구조가 변경되었을 수 있습니다.',
    INJECT: 'WING 페이지에서 실행할 수 없습니다. WING 로그인 상태를 확인하세요.',
    STOPPED: '사용자가 점검을 멈췄습니다.',
    INTERRUPTED: '점검이 중간에 끊겼습니다 (브라우저 종료·절전·탭 닫힘 등).',
  }[code] || '알 수 없는 오류';
}

// ── 광고 점검 (B1) ─────────────────────────────────────────
const ADS_URL = 'https://advertising.coupang.com/marketing/dashboard/sales';
let adsRunning = false;
async function setAdsStatus(st) { await chrome.storage.local.set({ adsStatus: { ...st, at: new Date().toISOString() } }); }

// 광고 API(/marketing/tetris-api 등)는 /marketing/ 화면에서만 동작함.
// 새 「광고 홈」(/dashboard) 등 다른 화면에서 호출하면 500 오류(vendorMarket 없음) → /marketing/ 화면으로 이동해서 실행.
const isMarketingPage = (url) => /^https:\/\/advertising\.coupang\.com\/marketing\//.test(url || '');

async function findOrOpenAdsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://advertising.coupang.com/*' });
  const ok = tabs.find((t) => isMarketingPage(t.url));
  if (ok) return { tab: ok, opened: false };
  const tab = await chrome.tabs.create({ url: ADS_URL, active: false });
  await new Promise((resolve) => {
    const listener = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 20000);
  });
  await new Promise((r) => setTimeout(r, 1500)); // 로그인 리다이렉트 대기
  return { tab: await chrome.tabs.get(tab.id), opened: true };
}

// 광고 점검용: 광고센터 탭을 앞으로 가져와(없으면 새 탭) 화면을 보여 준 뒤 점검. 점검 후에도 탭은 닫지 않음.
// 로그인 화면이면 사용자가 로그인할 때까지 최대 3분 기다렸다가 이어서 점검.
function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeout);
  });
}

async function showAdsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://advertising.coupang.com/*' });
  let tab = tabs.find((t) => isMarketingPage(t.url)) || tabs.find((t) => !/\/user\/login/.test(t.url || '')) || tabs[0];
  if (tab) {
    // 광고 홈 등 /marketing/ 밖의 화면이면 매출 성장 대시보드로 이동
    const upd = isMarketingPage(tab.url) || /\/user\/login/.test(tab.url || '') ? { active: true } : { active: true, url: ADS_URL };
    tab = await chrome.tabs.update(tab.id, upd);
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else {
    const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = await chrome.tabs.create({ url: ADS_URL, active: true, ...(cur ? { windowId: cur.windowId } : {}) });
  }
  await waitTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1500)); // 로그인 리다이렉트 대기
  tab = await chrome.tabs.get(tab.id);
  if (/\/user\/login/.test(tab.url || '')) {
    await setAdsStatus({ state: 'running', waiting: 'login' });
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 2000));
      tab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!tab) throw { code: 'ADS_TAB_CLOSED' };
      if (!/\/user\/login/.test(tab.url || '') && /advertising\.coupang\.com/.test(tab.url || '')) break;
    }
    if (/\/user\/login/.test(tab.url || '')) throw { code: 'ADS_AUTH' };
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 1500));
    await setAdsStatus({ state: 'running' });
  }
  return ensureMarketingPage(tab);
}

// 탭이 /marketing/ 화면에 있고 로딩이 끝날 때까지 기다림 (로그인 후 광고 홈으로 돌아간 경우 포함)
async function ensureMarketingPage(tab) {
  if (!isMarketingPage(tab.url)) await chrome.tabs.update(tab.id, { url: ADS_URL });
  const end = Date.now() + 30000;
  for (;;) {
    tab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!tab) throw { code: 'ADS_TAB_CLOSED' };
    if (/\/user\/login/.test(tab.url || '')) throw { code: 'ADS_AUTH' };
    if (isMarketingPage(tab.url) && tab.status === 'complete') break;
    if (Date.now() > end) throw { code: 'INJECT' };
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500)); // 화면 초기화 대기
  return tab;
}

async function runAdsScan(days = 7) {
  if (adsRunning) return { ok: false, error: 'BUSY' };
  adsRunning = true;
  const s = await getSettings();
  let opened = null;
  try {
    const { adsSnapshots: prevSnaps = [] } = await chrome.storage.local.get('adsSnapshots');
    const prev = prevSnaps[prevSnaps.length - 1];
    // 연속 점검 방지: 직전 점검 후 3분 안에는 다시 점검하지 않음 (광고센터 차단 방지)
    if (!s.demoMode && prev && !prev.demo && Date.now() - Date.parse(prev.at) < 3 * 60000) {
      const left = Math.ceil((3 * 60000 - (Date.now() - Date.parse(prev.at))) / 60000);
      await setAdsStatus({ state: 'error', code: 'TOO_SOON', message: `방금 점검했습니다. 광고센터 차단을 피하려고 ${left}분 뒤에 다시 점검할 수 있습니다.` });
      return { ok: false, error: 'TOO_SOON' };
    }
    await setAdsStatus({ state: 'running' });
    let raw;
    if (s.demoMode) raw = demoAds(days);
    else {
      // 6시간 안에 조회한 광고그룹 상세(제외 키워드 등)는 재사용
      const cached = {};
      if (prev && !prev.demo) for (const r of prev.rows || []) if (r.detail && r.detail.at && Date.now() - Date.parse(r.detail.at) < 6 * 3600000) cached[r.id] = r.detail;
      // 상품 점검에서 문제가 있는 옵션 → 상품별 광고비 조회 대상 (광고 목록은 7일 저장해 재사용)
      const { snapshots: ps = [], adsIndex = {} } = await chrome.storage.local.get(['snapshots', 'adsIndex']);
      const lastP = ps[ps.length - 1];
      const productTargets = lastP ? (lastP.rows || []).filter((r) => (r.issues || []).some((i) => AD_PRODUCT_ISSUES.includes(i))).map((r) => r.vendorItemId) : [];
      const tab = await showAdsTab();
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: adsScanInPage,
        args: [{ days, delayMs: Math.max(3000, s.adsDelayMs || 4000), maxDetail: 20, skipDetailIds: Object.keys(cached),
          productTargets: productTargets.slice(0, 5000), adsIndex, maxListPages: 10 }] });
      raw = res && res.result;
      if (!raw) throw { code: 'INJECT' };
      if (raw.error) throw { code: raw.error };
      raw.details = { ...cached, ...(raw.details || {}) };
      if (raw.adsIndex && Object.keys(raw.adsIndex).length) {
        const { adsIndex: oldIdx = {} } = await chrome.storage.local.get('adsIndex');
        await chrome.storage.local.set({ adsIndex: { ...oldIdx, ...raw.adsIndex } });
      }
    }
    const { rows, daily } = normalizeAds(raw);
    const snap = { id: Date.now(), at: raw.finishedAt || new Date().toISOString(), demo: !!raw.demo, days, start: raw.start, end: raw.end, rows, daily, errors: raw.errors || [],
      products: (raw.products || []).filter((p) => p.spend > 0 || p.impressions > 0), productTargets: raw.productTargets || 0,
      productIndexIncomplete: Object.values(raw.adsIndex || {}).filter((x) => !x.complete).length };
    const { adsSnapshots = [] } = await chrome.storage.local.get('adsSnapshots');
    adsSnapshots.push(snap);
    while (adsSnapshots.length > 30) adsSnapshots.shift();   // 변경 효과 비교용으로 30회분 보관
    await chrome.storage.local.set({ adsSnapshots });
    const warn = raw.stopped === 'BLOCKED' ? '광고센터가 요청을 잠시 막아 일부만 조회했습니다. 30분쯤 뒤 다시 점검하세요.'
      : raw.detailRemaining ? `요청을 줄이기 위해 광고그룹 상세는 20개만 조회했습니다 (남은 ${raw.detailRemaining}개는 다음 점검 때).` : '';
    await setAdsStatus({ state: 'done', warning: warn });
    return { ok: true };
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    const msg = {
      ADS_AUTH: '3분 안에 광고센터 로그인이 확인되지 않았습니다. 열린 화면에서 「쿠팡 마켓플레이스 & 로켓그로스 판매자 → 로그인하기」를 누른 뒤 다시 시도하세요.',
      ADS_TAB_CLOSED: '광고센터 탭이 닫혀 점검을 중단했습니다.',
      BLOCKED: '광고센터가 요청을 잠시 막았습니다 (짧은 시간에 요청이 많았음). 30분쯤 뒤에 다시 점검하세요.',
      RATE: '요청이 너무 많아 중단했습니다. 30분 후 다시 시도하세요.',
      NETWORK: '네트워크 오류로 중단했습니다.',
      API: '광고센터가 오류를 반환해 중단했습니다. 화면 구조가 변경되었을 수 있습니다.',
      INJECT: '광고센터 페이지에서 실행할 수 없습니다.',
    }[code] || '알 수 없는 오류';
    await setAdsStatus({ state: 'error', code, message: msg });
    return { ok: false, error: code };
  } finally {
    adsRunning = false;
    if (opened) chrome.tabs.remove(opened).catch(() => {});
  }
}

// ── 광고 변경 적용 (사용자가 사이드 패널에서 확인·동의한 변경만) ──
// 자동 적용 대상: 일예산 / 목표 ROAS / ON/OFF. 적용 결과는 adApplyLog 에 기록.
async function runAdsApply(changes) {
  const s = await getSettings();
  const list = (changes || []).filter((c) => ['budget', 'roasTarget', 'isActive'].includes(c.field) && !validateChange(c));
  if (!list.length) return { ok: false, error: 'EMPTY' };
  let results;
  let opened = null;
  try {
    if (s.demoMode) results = list.map((c) => ({ key: c.key, ok: true, actual: c.to, message: '데모 모드: 실제로 변경하지 않음' }));
    else {
      const w = await findOrOpenAdsTab();
      opened = w.opened ? w.tab.id : null;
      if (/\/user\/login/.test(w.tab.url || '')) return { ok: false, error: 'ADS_AUTH' };
      const [res] = await chrome.scripting.executeScript({ target: { tabId: w.tab.id }, func: adsApplyInPage, args: [list] });
      const out = res && res.result;
      if (!out || out.error) return { ok: false, error: (out && out.error) || 'INJECT' };
      results = out.results;
    }
  } finally {
    if (opened) chrome.tabs.remove(opened).catch(() => {});
  }
  const at = new Date().toISOString();
  const { adApplyLog = [], adsSnapshots = [] } = await chrome.storage.local.get(['adApplyLog', 'adsSnapshots']);
  // 변경 효과 비교용: 적용 직전 광고 점검의 캠페인 성과를 함께 기록
  const lastAds = adsSnapshots[adsSnapshots.length - 1];
  const beforeOf = (id) => {
    const r = lastAds && (lastAds.rows || []).find((x) => String(x.id) === String(id));
    return r ? { at: lastAds.at, start: lastAds.start, end: lastAds.end, days: lastAds.days, spend: r.spend, sales: r.sales, orders: r.orders, impressions: r.impressions } : null;
  };
  for (const c of list) {
    const r = results.find((x) => x.key === c.key) || {};
    adApplyLog.push({ at, demo: !!s.demoMode, campaignId: c.campaignId, campaignName: c.campaignName, field: c.field, from: c.from, to: c.to, ok: !!r.ok, actual: r.actual ?? null, message: r.message || '', before: beforeOf(c.campaignId) });
  }
  while (adApplyLog.length > 300) adApplyLog.shift();
  await chrome.storage.local.set({ adApplyLog });
  return { ok: true, results };
}


// ── 인기 키워드 (WING 쿠팡 인기 상품 검색) ──
// 최신 상품 점검 결과의 카테고리 → 카테고리별 인기 검색어 → 키워드별 상위 상품·내 상품 순위
let trendsRunning = false;
async function setTrendsStatus(st) { await chrome.storage.local.set({ trendsStatus: { ...st, at: new Date().toISOString() } }); }

async function runTrends(opts = {}) {
  if (trendsRunning) return { ok: false, error: 'BUSY' };
  trendsRunning = true;
  const s = await getSettings();
  let opened = null;
  try {
    await setTrendsStatus({ state: 'running' });
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const last = snapshots[snapshots.length - 1];
    if (!last) throw { code: 'NO_SCAN' };
    if (!rowsHaveCategory(last.rows)) throw { code: 'OLD_SCAN' };
    const all = categoriesFromRows(last.rows);
    const codes = Array.isArray(opts.codes) && opts.codes.length ? opts.codes.map(String) : all.slice(0, 3).map((c) => c.code);
    const categories = all.filter((c) => codes.includes(String(c.code))).slice(0, 15);
    if (!categories.length) throw { code: 'NO_CATEGORY' };
    let raw;
    if (s.demoMode || last.demo) raw = demoTrends();
    else {
      // XSRF 쿠키가 확실히 있는 「쿠팡 인기 상품 검색」 화면에서 실행 (없으면 백그라운드 탭으로 열고 끝나면 닫음)
      const tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/tenants/rfm-ss/*' });
      let tab = tabs[0];
      if (!tab) {
        tab = await chrome.tabs.create({ url: TRENDS_PAGE_URL, active: false });
        opened = tab.id;
        await new Promise((resolve) => {
          const listener = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(resolve, 20000);
        });
        tab = await chrome.tabs.get(tab.id);
      }
      if (!/wing\.coupang\.com\/tenants\/rfm-ss/.test(tab.url || '')) throw { code: 'AUTH' };
      const mine = last.rows.filter((r) => !isInactive(r));
      // 24시간 안에 조회한 키워드 상세는 재사용 (요청 수 줄이기)
      const { trendsSnapshot: prevT } = await chrome.storage.local.get('trendsSnapshot');
      const fresh = {};
      for (const [k, v] of Object.entries((prevT && !prevT.demo && prevT.keywords) || {})) if (v.at && Date.now() - Date.parse(v.at) < 24 * 3600000) fresh[k] = v;
      opts.fresh = fresh;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: trendsInPage,
        args: [{ categories, detail: opts.detail !== false, limit: 60, delayMs: Math.max(3000, (s.delayMs || 1500) * 2), maxKeywords: 60, skipKeywords: Object.keys(fresh),
          myProductIds: [...new Set(mine.map((r) => r.productId).filter(Boolean))], myVendorItemIds: mine.map((r) => r.vendorItemId).filter(Boolean) }],
      });
      raw = res && res.result;
      if (!raw) throw { code: 'INJECT' };
      if (raw.error) throw { code: raw.error };
      raw.keywords = { ...(opts.fresh || {}), ...raw.keywords };
    }
    const snap = { ...raw, id: Date.now(), detail: opts.detail !== false, productScanAt: last.at };
    await chrome.storage.local.set({ trendsSnapshot: snap });
    const warn = raw.stopped === 'BLOCKED'
      ? `쿠팡이 요청을 잠시 막아 중단했습니다. 지금까지 결과는 저장했습니다. 30분쯤 뒤 다시 조회하면 남은 키워드${raw.remaining ? ` ${raw.remaining}개` : ''}만 조회합니다.`
      : raw.stopped === 'AUTH' ? 'WING 로그인이 끊겨 중단했습니다. 로그인 후 다시 조회하면 남은 키워드만 조회합니다.'
      : raw.remaining ? `요청을 줄이기 위해 한 번에 60개까지만 조회했습니다. 다시 조회하면 남은 ${raw.remaining}개를 조회합니다.` : '';
    await setTrendsStatus({ state: 'done', warning: warn });
    return { ok: true };
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    const msg = {
      NO_SCAN: '상품 점검 결과가 없습니다. 먼저 「지금 점검」을 실행하세요.',
      OLD_SCAN: '점검 결과에 카테고리 정보가 없습니다 (0.5.2 이전 점검). 「지금 점검」을 한 번 다시 실행하세요.',
      NO_CATEGORY: '조회할 카테고리를 선택하세요.',
      AUTH: 'WING 로그인이 필요합니다. Chrome에서 wing.coupang.com에 로그인한 뒤 다시 시도하세요.',
      BLOCKED: '쿠팡이 요청을 잠시 막았습니다 (짧은 시간에 요청이 많았음). 30분쯤 뒤에 다시 시도하세요.',
      INJECT: 'WING 화면에서 실행할 수 없습니다.',
    }[code] || '알 수 없는 오류';
    await setTrendsStatus({ state: 'error', code, message: msg });
    return { ok: false, error: code };
  } finally {
    trendsRunning = false;
    if (opened) chrome.tabs.remove(opened).catch(() => {});
  }
}

// 사이드 패널에서 오는 메시지 처리
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // WING 탭의 수집 진행 상황 → 상태에 반영 (사이드 패널에 표시)
  if (msg.type === 'adsProgress') {
    if (adsRunning) setAdsStatus({ state: 'running', progress: { phase: msg.phase, done: msg.done, total: msg.total } });
    return false;
  }
  if (msg.type === 'trendsProgress') {
    if (trendsRunning) setTrendsStatus({ state: 'running', progress: { phase: msg.phase, done: msg.done, total: msg.total } });
    return false;
  }
  (async () => {
    if (msg.type === 'scan') sendResponse(await runScan('manual', { fresh: !!msg.fresh }));
    else if (msg.type === 'scanStop') { stopRequested = running; sendResponse({ ok: true, running }); }
    else if (msg.type === 'scanDiscard') {
      if (!running) { await chrome.storage.local.remove('scanJob'); await setStatus({ state: 'idle' }); }
      sendResponse({ ok: !running });
    }
    else if (msg.type === 'adsScan') sendResponse(await runAdsScan(Number(msg.days) || 7));
    else if (msg.type === 'adsApply') sendResponse(await runAdsApply(msg.changes));
    else if (msg.type === 'trends') sendResponse(await runTrends({ codes: msg.codes, detail: msg.detail }));
    else if (msg.type === 'saveSettings') {
      await chrome.storage.local.set({ settings: { ...(await getSettings()), ...msg.settings } });
      await scheduleAlarm();
      sendResponse({ ok: true });
    } else if (msg.type === 'clearData') {
      await chrome.storage.local.remove(['snapshots', 'status', 'adsSnapshots', 'adsStatus', 'trendsSnapshot', 'trendsStatus', 'adCpcCache', 'adsIndex', 'scanJob']);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.notifications.onClicked.addListener(async () => {
  const win = await chrome.windows.getLastFocused();
  if (win && win.id) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
});

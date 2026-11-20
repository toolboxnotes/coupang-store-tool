// 광고센터 탭 안에서 실행되는 함수들 (chrome.scripting.executeScript로 주입). import·바깥 변수 참조 금지.
//
// ⚠ adsApplyInPage 는 실제 광고 설정을 변경합니다.
//    사이드 패널에서 사용자가 변경 목록을 확인하고 동의한 경우에만 호출됩니다.
//    광고센터 화면이 사용하는 것과 같은 단건 수정 요청만 사용합니다 (2026-11 확인):
//    - 일예산     POST /marketing/tetris-api/campaign/budget                         {campaign:{id, budget}}
//    - 목표 ROAS  POST /marketing/tetris-api/campaign/{캠페인}/ad-group/{그룹}/roasTarget {groupId, roasTarget}
//    - ON/OFF     POST /marketing/tetris-api/campaign/update                         {campaignId, isActive}
//    각 변경 후 다시 조회해서 실제로 바뀌었는지 확인합니다. 제외 키워드는 API로 바꾸지 않습니다 (사용자가 편집 화면에서 직접).
export async function adsApplyInPage(changes) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (0.8 + Math.random() * 0.5)))); // 불규칙 간격 (차단 방지)
  if (/\/user\/login/.test(location.pathname)) return { error: 'ADS_AUTH' };

  async function post(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 본문 없음 */ }
      return { ok: res.ok, status: res.status, json };
    } catch (e) { return { ok: false, status: 0 }; }
  }
  async function readCampaign(id) {
    const r = await post('/marketing/tetris-api/campaigns', {
      isDeleted: false, pagination: { page: 0, size: 10 }, sortedBy: 'ID', isSortDesc: 'DESC', budgetTypes: null, isActive: null, name: '',
      creationContext: null, objective: null, primaryOrderBy: 'DEFAULT', goalType: 'SALES', targetCampaignId: null, vendorItemId: null, tdeCardTypes: null, campaignIds: [Number(id)],
    });
    return r.ok && r.json && (r.json.campaigns || []).find((c) => String(c.id) === String(id));
  }
  async function readGroup(cid, gid) {
    try {
      const res = await fetch(`/marketing/tetris-api/campaign/${cid}/ad-group/${gid}`, { credentials: 'include' });
      return res.ok ? ((await res.json()).adGroup || null) : null;
    } catch (e) { return null; }
  }

  const results = [];
  let failures = 0;
  for (const c of changes) {
    if (failures >= 2) { results.push({ key: c.key, ok: false, message: '연속 실패로 중단' }); continue; } // 오류가 이어지면 중단
    let r;
    if (c.field === 'budget') r = await post('/marketing/tetris-api/campaign/budget', { campaign: { id: Number(c.campaignId), budget: Number(c.to) } });
    else if (c.field === 'roasTarget') r = await post(`/marketing/tetris-api/campaign/${c.campaignId}/ad-group/${c.groupId}/roasTarget`, { groupId: Number(c.groupId), roasTarget: Number(c.to) });
    else if (c.field === 'isActive') r = await post('/marketing/tetris-api/campaign/update', { campaignId: Number(c.campaignId), isActive: c.to === true || c.to === 'ON' });
    else { results.push({ key: c.key, ok: false, message: '자동 적용하지 않는 항목' }); continue; }

    await sleep(3000);
    // 실제 반영 확인
    let actual = null;
    if (c.field === 'roasTarget') { const g = await readGroup(c.campaignId, c.groupId); actual = g ? g.roasTarget : null; }
    else {
      const cp = await readCampaign(c.campaignId);
      if (cp) actual = c.field === 'budget' ? cp.calculatedBudget : (cp.isActive ? 'ON' : 'OFF');
    }
    const want = c.field === 'isActive' ? (c.to === true || c.to === 'ON' ? 'ON' : 'OFF') : Number(c.to);
    const verified = actual !== null && String(actual) === String(want);
    if (!r.ok) failures++;
    results.push({
      key: c.key, ok: r.ok && verified, status: r.status, actual,
      message: !r.ok ? `요청 실패 (HTTP ${r.status}${r.json && typeof r.json === 'string' ? ' ' + r.json : ''})` : verified ? '적용 확인' : `요청은 성공했지만 확인된 값이 다름 (현재 ${actual ?? '확인 불가'})`,
    });
    await sleep(4000);
  }
  return { results, finishedAt: new Date().toISOString() };
}

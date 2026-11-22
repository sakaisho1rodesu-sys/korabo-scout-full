// ==UserScript==
// @name         媒体変化チェック
// @namespace    korabo-media-monitor
// @version      2.0
// @description  求人媒体（現在はエン転職）の応募件数・応募者を 8:30/12:00/17:00 に読み取りGASへ送る（見るだけ・送信や変更はしない）
// @match        https://employment.en-japan.com/company/appcontrol/*
// @match        https://employment.en-japan.com/company_login/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/sakaisho1rodesu-sys/korabo-scout-full/main/media_monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/sakaisho1rodesu-sys/korabo-scout-full/main/media_monitor.user.js
// ==/UserScript==
(function () {
  'use strict';
  const CFG = {
    // GASのURLと合言葉は公開ファイルに書かず、メニュー「GASの接続を設定」で各プロファイルに保存する
    GAS_URL: GM_getValue('gasUrl', ''),
    SECRET: GM_getValue('secret', ''),
    SLOTS: ['08:30', '12:00', '17:00'],
    MAX_PAGES: 30,
    RELOAD_MIN: 20, // タブを開いたままでも画面を新しくする間隔（分）
  };
  const BASE = 'https://employment.en-japan.com';
  // 会社の番号（PK）は、いま開いている画面から取る。前の会社の番号を使い回さない
  const pkFromLinks = () => {
    const a = document.querySelector('a[href*="PK="]');
    return a ? new URL(a.getAttribute('href'), location.href).searchParams.get('PK') : '';
  };
  const PK = new URLSearchParams(location.search).get('PK') || pkFromLinks() || '';

  // ---- 媒体ごとの読み取り部分（今後 エン転職ダイレクト・doda・Indeed・マイナビ・求人ボックス を足す） ----
  // accountKey: その媒体で会社を見分ける番号。アカウント名は「媒体|番号」ごとに覚えるので、
  // 同じプロファイルで会社を入れ替えても混ざらない
  // 画面の「〇〇 管理者：」の直前から社名を取る（スカウトツールの誤送信ガードと同じ方法・実機確認済み）
  function pageCompanyName(doc) {
    const t = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
    let m = t.match(/([^\s]+)\s*管理者[:：]/);
    if (m) return m[1];
    m = t.match(/((?:株式会社|有限会社)[^\s]{1,30}|[^\s]{1,30}(?:株式会社|有限会社))/);
    return m ? m[1] : '';
  }
  const normName = n => (n || '').replace(/株式会社|有限会社|合同会社|\(株\)|（株）|[\s　・\-_/]/g, '');
  // PKはログインのたびに変わるため、会社の見分けには使わない（2026-11-22 実機で確認）
  const ADAPTER = {
    media: 'エン転職',
    accountKey: () => normName(pageCompanyName(document)),
    collect: () => collect(),
  };
  const mapKey = () => ADAPTER.media + '|' + (ADAPTER.accountKey() || '');
  const getAccount = () => (GM_getValue('accounts', {})[mapKey()] || '');
  function askAccount() {
    if (!ADAPTER.accountKey()) { alert('画面から社名が読み取れません。応募管理トップを開き直してください'); return ''; }
    const v = prompt(`この会社のアカウント名を入れてください（例：重谷建設_エン）\n媒体：${ADAPTER.media}　画面の社名：${ADAPTER.accountKey()}`, getAccount());
    if (!v) return '';
    const m = GM_getValue('accounts', {}); m[mapKey()] = v.trim(); GM_setValue('accounts', m);
    return v.trim();
  }
  GM_registerMenuCommand('アカウント名を設定（この会社）', askAccount);
  GM_registerMenuCommand('GASの接続を設定', () => {
    const u = prompt('GASのウェブアプリURL（/exec で終わるもの）', GM_getValue('gasUrl', ''));
    if (u) GM_setValue('gasUrl', u.trim());
    const k = prompt('合言葉（GASと同じ文字列）', GM_getValue('secret', ''));
    if (k) GM_setValue('secret', k.trim());
    alert('保存しました。画面を読み込み直すと反映されます');
  });
  GM_registerMenuCommand('今すぐ取得（テスト）', () => run('手動'));
  GM_registerMenuCommand(`バージョン確認（v${GM_info.script.version}）`, () => alert(`媒体変化チェック v${GM_info.script.version}`));

  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:8px;z-index:99999;background:#334;color:#fff;font:12px sans-serif;padding:4px 8px;border-radius:4px;opacity:.85';
  const label = document.createElement('span');
  const btn = document.createElement('button');
  btn.textContent = '今すぐ取得';
  btn.style.cssText = 'margin-left:8px;font:12px sans-serif;padding:2px 8px;cursor:pointer';
  btn.onclick = () => run('手動');
  badge.append(label, btn);
  document.body.appendChild(badge);
  const VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '';
  const show = t => { label.textContent = `変化チェック v${VER}：` + t; };
  show(GM_getValue('lastMsg', '待機中'));

  // ---- 取得 ----
  async function get(url) {
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    return { url: res.url, doc: new DOMParser().parseFromString(html, 'text/html'), html };
  }
  // ログイン中の管理画面には必ず「〇〇 管理者：」が出る。無ければログアウトとみなす
  // （エン転職はログアウト後もログイン画面へ飛ばさないことがあるため。2026-11-22 実機で判明）
  const isLoggedOut = r => /login|logout/i.test(r.url)
    || !!r.doc.querySelector('input[type="password"]')
    || !/管理者[:：]/.test(r.doc.body ? r.doc.body.textContent : '');
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  async function collect() {
    const top = await get(`${BASE}/company/appcontrol/?PK=${PK}`);
    if (isLoggedOut(top)) return { loggedIn: false };
    const topName = normName(pageCompanyName(top.doc));
    if (topName && ADAPTER.accountKey() && topName !== ADAPTER.accountKey()) throw new Error('画面の会社と取得先の会社が違います。画面を読み込み直してください');
    const links = [...top.doc.querySelectorAll('a[href*="applicant_list"]')];
    const jobs = new Map();
    links.forEach(a => {
      const id = new URL(a.getAttribute('href'), BASE).searchParams.get('WorkID');
      if (!id || jobs.has(id)) return;
      // 応募管理トップの table.jobList の1行＝1求人。行の文言に「掲載中」があるものだけを見る
      // （掲載終了・グレーアウトの求人は数えない。2026-11-22 実機確認）
      const row = a.closest('tr');
      const rowText = txt(row);
      const st = rowText.match(/掲載中|掲載終了|掲載予定|掲載停止/);
      if (!st || st[0] !== '掲載中') return;
      jobs.set(id, { workId: id, title: rowText.slice(0, rowText.indexOf(st[0])).trim().slice(0, 60) });
    });
    const outJobs = [], apps = [];
    for (const j of jobs.values()) {
      let url = `${BASE}/company/appcontrol/applicant_list/?WorkID=${j.workId}&PK=${PK}`;
      let total = 0, page = 0;
      const counts = { scout: 0, meet: 0, normal: 0 };
      let unacted = 0;
      const seen = new Set();
      while (url && page < CFG.MAX_PAGES && !seen.has(url)) {
        seen.add(url); page++;
        const r = await get(url);
        if (isLoggedOut(r)) return { loggedIn: false };
        if (page === 1) {
          const m = r.doc.body.textContent.match(/全\s*([\d,]+)\s*件/);
          total = m ? Number(m[1].replace(/,/g, '')) : 0;
        }
        r.doc.querySelectorAll('table.appList tr.js_applyTr').forEach(tr => {
          const dateT = txt(tr.querySelector('td.date'));
          const nameT = txt(tr.querySelector('td.name'));
          const prog = txt(tr.querySelector('td.progress'));
          const dm = dateT.match(/(\d{2})\/(\d{2})\/(\d{2})/);
          const type = /会ってみたい/.test(dateT) ? '会ってみたい' : /スカウト/.test(dateT) ? 'スカウト' : '通常';
          counts[type === '会ってみたい' ? 'meet' : type === 'スカウト' ? 'scout' : 'normal']++;
          const nm = nameT.match(/^(.*?)\s*(男性|女性)?\s*(\d+)歳\s*(.*)$/) || [];
          // 「--- 評価：--」のままなら未対応
          const acted = !/^-*\s*評価[:：]\s*-*$/.test(prog);
          if (!acted) unacted++;
          apps.push({
            workId: j.workId, title: j.title,
            name: (nm[1] || nameT).trim(), gender: nm[2] || '', age: nm[3] || '', area: (nm[4] || '').trim(),
            date: dm ? `20${dm[1]}/${dm[2]}/${dm[3]}` : dateT, type, acted, progress: prog,
          });
        });
        const next = [...r.doc.querySelectorAll('a')].find(a => /^(次|次へ|次のページ|>)$/.test(txt(a)));
        url = next ? new URL(next.getAttribute('href'), BASE).href : null;
      }
      outJobs.push({ workId: j.workId, title: j.title, total, counts, unacted });
    }
    return { loggedIn: true, jobs: outJobs, applicants: apps };
  }

  function send(payload) {
    return new Promise((ok, ng) => GM_xmlhttpRequest({
      method: 'POST', url: CFG.GAS_URL, headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify(payload), onload: r => ok(r.responseText), onerror: ng,
    }));
  }

  async function run(slot) {
    let account = getAccount();
    // 社名が出ていない画面（ログアウト後など）は、このプロファイルで最後に取得できた会社として扱う
    if (!account && !ADAPTER.accountKey()) account = GM_getValue('lastAccount', '');
    if (!account && slot === '手動') account = askAccount(); // 初めて見る会社なら手動のときだけ聞く
    if (!CFG.GAS_URL || !CFG.SECRET) { show('GASの接続が未設定です（Tampermonkeyメニューから設定）'); return; }
    if (!account) { show('この会社のアカウント名が未設定です（「今すぐ取得」で設定）'); return; }
    const onLogin = /company_login/.test(location.pathname);
    if (!PK && !onLogin) { show('PKが分かりません。応募管理トップを開いてください'); return; }
    show('取得中…');
    try {
      // ログイン画面が開いているなら、取りに行かずにログアウトとして記録する
      const data = onLogin ? { loggedIn: false } : await ADAPTER.collect();
      await send(Object.assign({ secret: CFG.SECRET, media: ADAPTER.media, account, accountKey: ADAPTER.accountKey(), slot }, data));
      GM_setValue('loggedOut', !data.loggedIn);
      if (data.loggedIn) GM_setValue('lastAccount', account);
      const msg = data.loggedIn ? `${slot} 取得OK（求人${data.jobs.length}件・応募者${data.applicants.length}名）` : `${slot} ログアウトを検知`;
      GM_setValue('lastMsg', account + '｜' + msg + ' ' + new Date().toLocaleTimeString('ja-JP'));
      show(GM_getValue('lastMsg'));
    } catch (e) { show('エラー：' + e); }
  }

  // ---- 時刻チェック（1分ごと） ----
  function tick() {
    const now = new Date();
    const today = now.toLocaleDateString('sv-SE'); // 日本時間の日付（YYYY-MM-DD）
    const hm = now.toTimeString().slice(0, 5);
    const done = GM_getValue('done', {});
    for (const s of CFG.SLOTS) {
      const key = today + ' ' + s;
      if (hm >= s && !done[key] && !CFG.SLOTS.some(x => x > s && hm >= x)) {
        done[key] = 1;
        Object.keys(done).forEach(k => { if (!k.startsWith(today)) delete done[k]; });
        GM_setValue('done', done);
        run(s);
        break;
      }
    }
  }
  // 同じアカウントで複数タブを開いていても1回だけ動くように、最初のタブだけ時刻チェックする
  const tabId = Math.random().toString(36).slice(2);
  setInterval(() => {
    const owner = GM_getValue('owner', null);
    if (!owner || owner.id === tabId || Date.now() - owner.t > 90000) {
      GM_setValue('owner', { id: tabId, t: Date.now() });
      tick();
    }
  }, 60000);
  if (!/company_login/.test(location.pathname)) setTimeout(() => location.reload(), CFG.RELOAD_MIN * 60000);
  // ログイン画面が開いている＝ログアウトしている。まだ記録していなければ、この時点で記録する
  // （ログアウト後に管理画面を開くとログイン画面へ移るため。2026-11-22 実機で判明）
  if (/company_login/.test(location.pathname)) {
    if (!GM_getValue('loggedOut', false) && GM_getValue('lastAccount', '')) setTimeout(() => run('ログアウト検知'), 2000);
    return; // ログイン画面では自動の再読み込みや取り直しはしない
  }
  // 前回ログアウトを検知していて、いまログインした画面が開けていれば自動で取り直す
  if (GM_getValue('loggedOut', false) && !document.querySelector('input[type="password"]') && !/login/i.test(location.href)) {
    setTimeout(() => run('入り直し後'), 3000);
  }
})();

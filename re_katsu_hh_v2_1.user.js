// ==UserScript==
// @name         Re就活 HH文章自動生成 v2.1
// @namespace    korabo.rekatsu
// @version      2.1
// @description  ヘッドハンティング送信ポップアップを開くと、候補者詳細から3欄の文章を自動生成して入力（送信は人が押す）
// @match        https://re-katsu.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ===== 設定（ここだけ書き換える） =====
  // GAS_URL は初回に画面で聞かれ、Tampermonkeyに保存されます（貼り直しても消えません）
  let GAS_URL = GM_getValue('rk_gas_url', '') || '';
  const TOKEN = 'korabo-rk-2611-xxxx';
  const THIN_MIN = 10; // レジュメの有効な文字（記号・未設定などを除く）がこれ未満なら、AIを使わずテンプレのままにする
  // テンプレート名に含まれる文字（Re就活のメールテンプレート名に「1回目HH」「2回目HH」を入れておく。複数あれば名前が最後のものを使う）
  const TEMPLATE_KEY = { 1: '1回目HH', 2: '2回目HH' };
  const ROUND_LABEL = { 1: '初回', 2: '2回目' };
  const ROUND_COLOR = { 1: '#1a6fd1', 2: '#8a3fc4' };
  let ROUND = Number(GM_getValue('rk_round', 1)) === 2 ? 2 : 1; // 最後に選んだ方を覚えている
  const LIMIT = 200; // 画面上限（全角換算）
  // =====================================

  // ポップアップ以外のRe就活画面では、動作確認用の小さな表示だけ出して終わる（クリックで消える）
  if (!/mng_sct_headhunting\.aspx/i.test(location.pathname)) {
    if (window.top === window && document.body) {
      const b = document.createElement('div');
      b.textContent = 'Re就活HH v2.1 稼働中（この画面では何もしません・クリックで消す）';
      b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#0b5;color:#fff;font:12px sans-serif;padding:3px 8px;border-radius:4px;opacity:.85;cursor:pointer';
      b.addEventListener('click', () => b.remove());
      document.body.appendChild(b);
    }
    return;
  }

  const P = 'ctl00_ContentPlaceHolder2_';
  const $ = (id) => document.getElementById(P + id);
  const FLAG = 'rk_tpl_applied';
  const BODY_ID = 'txtAreaBODY'; // メール本文欄
  let bodyMode = false;
  const FIELDS = [
    { key: 'resumePoint', id: 'txtRESUMEPOINT', label: '職務経歴書' },
    { key: 'prPoint', id: 'txtPRPOINT', label: '自己PR' },
    { key: 'hopePoint', id: 'txtHOPEPOINT', label: '期待' }
  ];
  let busy = true;
  console.log('[RK] re_katsu_hh v2.1 loaded ' + location.pathname + '');

  // ---- 画面パネル ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;width:300px;background:#fff;border:2px solid #0b5;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3);font:13px/1.5 sans-serif;padding:10px;color:#222';
  panel.innerHTML = '<div style="font-weight:bold">Re就活 HH自動生成 v2.1</div><div style="margin:6px 0"><span id="rk-round" style="display:inline-block;color:#fff;font-weight:bold;padding:2px 10px;border-radius:12px"></span> <button id="rk-sw" type="button" style="padding:2px 8px;margin-left:6px">切替</button></div><div id="rk-st" style="margin:6px 0">準備中…</div><div id="rk-cnt" style="color:#555"></div><div style="margin-top:8px"><button id="rk-re" type="button" style="padding:4px 10px">▶ 生成（再生成）</button></div>';
  document.body.appendChild(panel);
  function paintRound() {
    const e = panel.querySelector('#rk-round');
    e.textContent = '【' + ROUND_LABEL[ROUND] + '用】テンプレート';
    e.style.background = ROUND_COLOR[ROUND];
  }
  paintRound();
  // 状態の色：ok=緑（AIで入力済み） / warn=オレンジ（テンプレのまま） / ng=赤（失敗） / 無指定=灰（待機）
  function paintState(kind) {
    const c = { work: ['#1a6fd1', '#e8f1fd'], ok: ['#0b5', '#e9f9ef'], warn: ['#e09a00', '#fff6dd'], ng: ['#d33', '#fdeaea'], idle: ['#888', '#fff'] }[kind || 'idle'];
    panel.style.borderColor = c[0]; panel.style.background = c[1];
    const tg = (bodyMode ? [$(BODY_ID)] : []).concat(FIELDS.map((f) => $(f.id)));
    tg.forEach((el) => { if (el) el.style.background = (kind === 'ok') ? '#e9f9ef' : ''; });
  }
  paintState('idle');
  const setSt = (m, ng) => { const e = panel.querySelector('#rk-st'); e.textContent = m; e.style.color = ng === 'warn' ? '#b26a00' : (ng ? '#c00' : '#222'); };

  // ---- 文字数（全角=1 / 半角=0.5） ----
  const weight = (s) => { let n = 0; for (const ch of String(s || '')) { const c = ch.charCodeAt(0); n += (c <= 0x7e || (c >= 0xff61 && c <= 0xff9f)) ? 0.5 : 1; } return n; };
  function showCounts() {
    const parts = FIELDS.map((f) => { const w = weight(($(f.id) || {}).value); return f.label + ' ' + Math.ceil(w) + '/' + LIMIT + (w > LIMIT ? ' ⚠' : ''); });
    panel.querySelector('#rk-cnt').textContent = parts.join(' ｜ ');
    return FIELDS.every((f) => weight(($(f.id) || {}).value) <= LIMIT);
  }

  // ---- メールプリヘッダー（受信一覧で件名の横に見える一文）を本文から抽出して入れる ----
  function preheaderEl() {
    const byId = [...document.querySelectorAll('input[id],textarea[id]')].find((e) => /PRE_?HEAD/i.test(e.id));
    if (byId) return byId;
    const lab = [...document.querySelectorAll('th,td,label,span,div')].find((e) => e.children.length < 3 && /プリヘッダ/.test(e.textContent || '') && (e.textContent || '').length < 30);
    if (!lab) return null;
    let n = lab;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const f = n.querySelector('input[type=text],input:not([type]),textarea');
      if (f && f.id !== P + BODY_ID) return f;
      const sib = n.nextElementSibling && n.nextElementSibling.querySelector('input[type=text],input:not([type]),textarea');
      if (sib) return sib;
    }
    return null;
  }
  function extractPreheader(opening, body) {
    const greet = /^(.{0,30}様|お世話|はじめまして|初めまして|突然|株式会社|この度|こんにちは|ご連絡|再度|先日|[-─━=＝■◆●【])/;
    let src = String(opening || '').trim();
    if (!src) {
      const lines = String(body || '').split(/\n/).map((x) => x.trim()).filter((x) => x && !/\{\{/.test(x));
      src = lines.find((x) => x.length >= 15 && !greet.test(x)) || lines.find((x) => x.length >= 15) || '';
    }
    return src.replace(/\s+/g, ' ').split(/(?<=。)/)[0].replace(/。$/, '');
  }
  function fillPreheader(opening) {
    const el = preheaderEl();
    if (!el) return '';
    const bd = $(BODY_ID);
    let t = extractPreheader(opening, bd ? bd.value : '');
    if (!t) return '';
    const max = Number(el.getAttribute('maxlength')) || 0;
    if (max && t.length > max) t = t.slice(0, max - 1) + '…';
    el.value = t;
    ['input', 'keyup', 'change'].forEach((n) => el.dispatchEvent(new Event(n, { bubbles: true })));
    return t;
  }

  // ---- 候補者詳細（開いた元のモーダル）から本文を取る ----
  const textOf = (d) => { try { return d && d.body ? d.body.innerText : ''; } catch (e) { return ''; } };
  function collectDocs(w, out, depth) {
    if (!w || depth > 3) return;
    try { out.push(w.document); } catch (e) { return; }
    try { for (let i = 0; i < w.frames.length; i++) collectDocs(w.frames[i], out, depth + 1); } catch (e) {}
  }
  function findResume() {
    const trace = [];
    const roots = [];
    try {
      if (window.opener) {
        roots.push(window.opener);
        try { if (window.opener.top && window.opener.top !== window.opener) roots.push(window.opener.top); } catch (e) {}
      }
    } catch (e) {}
    trace.push('元画面=' + (window.opener ? 'あり' : 'なし'));
    const docs = [];
    roots.forEach((r) => collectDocs(r, docs, 0));
    trace.push('読めた画面=' + docs.length);
    // 1) 「詳しく見る」の候補者詳細
    for (const d of docs) {
      const t = textOf(d);
      const s0 = t.indexOf('職務経歴・自己PR');
      if (s0 >= 0) {
        const e = t.indexOf('ＷＥＢ履歴書の完成度', s0);
        return { text: t.slice(s0, e > s0 ? e : s0 + 4000).slice(0, 4000), src: 'detail', trace: trace };
      }
    }
    trace.push('詳細=なし');
    // 2) 一覧で選択済みの1名
    for (const d of docs) {
      try {
        const cb = [...d.querySelectorAll('input[id$="chkSelect"]')].filter((x) => x.checked);
        trace.push('選択行=' + cb.length);
        if (cb.length === 1) {
          const tb = cb[0].closest('table');
          const t = tb ? tb.innerText : '';
          if (t.length > 60) return { text: '職務経歴・自己PR（一覧の情報）\n' + t.slice(0, 4000), src: 'list', trace: trace };
        }
      } catch (e) {}
    }
    return { text: '', src: '', trace: trace };
  }

  function jobTitle() {
    const sel = $('drpLstRecr');
    const o = sel && sel.options[sel.selectedIndex];
    return (o && o.text && o.value) ? o.text.trim() : '';
  }

  // ---- テンプレート読み込み（再読込にも対応） ----
  async function ensureTemplate() {
    if (sessionStorage.getItem(FLAG) === '1') { sessionStorage.removeItem(FLAG); return; }
    const sel = $('drpLstMailTmp'), btn = $('BtnSelect');
    const hits = sel ? [...sel.options].filter((o) => o.text.includes(TEMPLATE_KEY[ROUND])) : [];
    const opt = hits.sort((a, b) => (a.text < b.text ? 1 : -1))[0];
    if (!opt) throw new Error('「' + TEMPLATE_KEY[ROUND] + '」を含むテンプレートが見つかりません');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sessionStorage.setItem(FLAG, '1');
    btn.click();
    await new Promise((r) => setTimeout(r, 3000)); // 再読込されればここで終わる
    sessionStorage.removeItem(FLAG);
  }

  // ---- GAS呼び出し ----
  function callGas(payload) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST', url: GAS_URL, headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify(payload), timeout: 90000,
        onload: (r) => { try { res(JSON.parse(r.responseText)); } catch (e) { rej(new Error('GAS応答が不正です［状態' + r.status + '：' + String(r.responseText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) + '］')); } },
        onerror: () => rej(new Error('通信エラー')), ontimeout: () => rej(new Error('タイムアウト'))
      });
    });
  }

  function setVal(id, v) {
    const el = $(id); el.value = v;
    ['input', 'keyup', 'change'].forEach((n) => el.dispatchEvent(new Event(n, { bubbles: true })));
  }

  // ---- レジュメの情報量（◯✕▼だけ、未設定だけの場合を除くため） ----
  function infoAmount(text) {
    const skipLabel = /^(勤務期間|雇用形態|最終学歴|希望|年収|勤務地|転職|職歴\d*$|在籍)/;
    const skipVal = /(未設定|特になし|こだわらない|なし|ひとことＰＲ)/;
    let n = 0;
    String(text || '').split(/\n/).forEach((line) => {
      const i = line.indexOf('\t');
      const label = (i >= 0 ? line.slice(0, i) : '').trim();
      const val = i >= 0 ? line.slice(i + 1) : line;
      if (i < 0 && /^(職務経歴・自己PR|自己ＰＲ|職歴\d+|希望条件)$/.test(line.trim())) return;
      if (skipLabel.test(label)) return;
      const v = val.replace(skipVal, '').replace(/[0-9０-９]/g, '');
      n += (v.match(/[ぁ-んァ-ヶ一-龠a-zA-Z]/g) || []).length;
    });
    return n;
  }

  // ---- 生成中の表示（青い枠・ボタン無効・経過秒） ----
  let workTimer = null;
  function startWork() {
    const b = panel.querySelector('#rk-re'), t0 = Date.now();
    b.disabled = true; b.textContent = '⏳ 生成中…';
    const tick = () => setSt('⏳ AIが文章を作成中です（' + Math.floor((Date.now() - t0) / 1000) + '秒）。通常10〜40秒かかります。この間は送信ボタンを止めています');
    tick(); workTimer = setInterval(tick, 1000);
  }
  function stopWork() {
    if (workTimer) { clearInterval(workTimer); workTimer = null; }
    const b = panel.querySelector('#rk-re'); b.disabled = false; b.textContent = '▶ 生成（再生成）';
  }

  async function generate() {
    busy = true;
    try {
      const found = findResume();
      const resume = found.text;
      if (!resume || resume.length < 30) {
        paintState('warn');
        setSt('候補者の情報を読み取れないため、テンプレートの文面のままです。内容を確認して送信できます。自動入力するには、一覧の「詳しく見る」を開いた状態で送信ボタンを押してください（' + found.trace.join(' / ') + '）', 'warn');
        return;
      }
      const amt = infoAmount(resume);
      if (amt < THIN_MIN) {
        paintState('warn');
        fillPreheader('');
        setSt('レジュメの情報が少ない（有効な文字 ' + amt + '）ため、AIは使わず、テンプレートの文面のままです。内容を確認して送信できます', 'warn');
        showCounts();
        return;
      }
      if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(GAS_URL)) {
        const u = (window.prompt('GASウェブアプリのURL（…/exec で終わるもの）を貼り付けてください。一度入れると保存されます。', '') || '').trim();
        if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(u)) throw new Error('GAS_URLが未設定です。「生成」を押してURLを貼り付けてください');
        GAS_URL = u; GM_setValue('rk_gas_url', u);
      }
      paintState('work');
      startWork();
      bodyMode = !!$(BODY_ID);
      const r = await callGas({ token: TOKEN, resumeText: resume, jobTitle: jobTitle(), round: ROUND, mode: bodyMode ? 'body' : 'fields' });
      if (!r.ok) throw new Error(r.error || '生成に失敗しました');
      if (bodyMode) {
        if (r.mode !== 'body' || !r.body) throw new Error('GASが本文差し込みに未対応です（v5を貼って、新バージョンで再デプロイしてください）');
        if (/\{\{(OPENING|INSERTION)\}\}/.test(r.body)) throw new Error('本文に未置換の目印が残りました。もう一度「生成」を押してください');
        setVal(BODY_ID, r.body);
        FIELDS.forEach((f) => { if (r[f.key]) setVal(f.id, r[f.key]); });
        if (r.subject && $('txtSUBJECT')) setVal('txtSUBJECT', r.subject);
        const ph = fillPreheader(r.opening);
        const okF = showCounts();
        const c = r.counts || [];
        panel.querySelector('#rk-cnt').textContent = '冒頭 ' + Math.round(c[0] || 0) + '字 ｜ 所感 ' + Math.round(c[1] || 0) + '字 ｜ 本文全体 ' + Math.round(c[2] || 0) + '/3000 ｜ 件名 ' + Math.round(c[6] || 0) + '/50 ｜ 3欄 ' + Math.round(c[3] || 0) + '・' + Math.round(c[4] || 0) + '・' + Math.round(c[5] || 0) + '/200';
        paintState(okF ? 'ok' : 'warn');
        setSt('✓ 完了：件名・' + (ph ? 'プリヘッダー・' : '') + '本文（冒頭の一言・所感）・3欄（職務経歴書・自己PR・期待）を入力しました。内容を確認して送信してください');
        return;
      }
      FIELDS.forEach((f) => setVal(f.id, r[f.key] || ''));
      const ok = showCounts();
      paintState(ok ? 'ok' : 'warn');
      setSt(ok ? ('✓ 完了：入力しました' + (found.src === 'list' ? '（一覧の情報から作成。自己PRは途中までです）' : '') + '。内容を確認して送信してください') : '文字数オーバーがあります。修正または再生成してください', !ok);
    } catch (e) {
      paintState('ng');
      setSt('生成に失敗しました（' + String(e.message || e) + '）。テンプレートの文面のままです。「生成」を押し直すか、確認してそのまま送信できます', true);
    } finally { stopWork(); busy = false; }
  }

  // ---- 送信ガード ----
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('#' + P + 'BtnSendVi');
    if (!b) return;
    if (busy) { ev.preventDefault(); ev.stopImmediatePropagation(); setSt('生成中のため送信を止めました。完了後に押してください', true); return; }
    const bd = $(BODY_ID);
    if (bd && /\{\{(OPENING|INSERTION)\}\}|\[link removed\]/.test(bd.value)) { ev.preventDefault(); ev.stopImmediatePropagation(); paintState('ng'); setSt('本文に「{{…}}」または「[link removed]」が残っているため、送信を止めました', true); return; }
    if (!showCounts()) { ev.preventDefault(); ev.stopImmediatePropagation(); setSt('文字数オーバーのため送信を止めました', true); }
  }, true);
  FIELDS.forEach((f) => { const el = $(f.id); if (el) el.addEventListener('input', showCounts); });
  panel.querySelector('#rk-re').addEventListener('click', () => { if (!busy) generate(); });
  panel.querySelector('#rk-sw').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    ROUND = ROUND === 1 ? 2 : 1; GM_setValue('rk_round', ROUND); paintRound(); paintState('idle');
    try { setSt('【' + ROUND_LABEL[ROUND] + '用】テンプレートに切り替え中…'); await ensureTemplate(); }
    catch (e) { setSt(String(e.message || e), true); paintState('ng'); busy = false; return; }
    busy = false; showCounts();
    setSt('【' + ROUND_LABEL[ROUND] + '用】テンプレートを読み込みました。「▶ 生成」で3欄をAIで作り直します');
  });

  (async () => {
    try { setSt('テンプレートを確認中…'); await ensureTemplate(); }
    catch (e) { setSt(String(e.message || e) + '（テンプレートは読み込まずに続けます）', 'warn'); busy = false; return; }
    busy = false;
    showCounts();
    if (!preheaderEl()) console.log('[RK] プリヘッダー欄が見つかりません');
    else if (!preheaderEl().value) fillPreheader('');
    setSt('【' + ROUND_LABEL[ROUND] + '用】テンプレートを読み込みました。違う場合は「切替」を押してください。内容を確認して「▶ 生成」を押すと、3欄をAIで作り直します');
  })();
})();

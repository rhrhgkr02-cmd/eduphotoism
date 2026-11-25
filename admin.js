/* =========================================================
   PHOTO BOOTH ✦ 선생님 모드 (admin.js)
   - 비밀번호 입장 → 입장 코드(4자리, 각 3일) 만들기 · 불러오기 · 삭제
   - 여러 선생님이 각자 '방'을 만들어 사용 (자기 방 사진만 보임)
   - 학생이 보낸 사진을 8초마다 확인해서 보여줌
   - [원본 다운로드] [바로 인쇄] [인쇄 완료 표시] [사진 삭제] [A4로 모아 인쇄]
   ========================================================= */
import { backend, MODE, TEST_PASSWORD, errorText } from './backend.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LAYOUT_NAME = { strip4: '세로 4컷', postcard: '엽서형 4컷', mini3: '미니 3컷' };
const PRINT_SIZE = { strip4: ['2in', '6in'], postcard: ['4in', '6in'], mini3: ['2in', '4.73in'] };
const POLL_MS = 8000;
/* A4 모아찍기: 실제 크기 그대로, 자르기 쉬운 배치 (단위 mm, A4 = 210×297)
   세로 4컷(2×6in)  → 눕혀서 한 장에 5개
   엽서형(4×6in)    → 눕혀서 한 장에 2개
   미니 3컷(2×4.7in) → 세워서 3×2 = 한 장에 6개 */
const A4_PLAN = {
  strip4:   { per: 5, w: 152.4, h: 50.8,  rot: true,  cols: 1 },
  postcard: { per: 2, w: 152.4, h: 101.6, rot: true,  cols: 1 },
  mini3:    { per: 6, w: 50.8,  h: 120.1, rot: false, cols: 3 }
};      // 새 사진 확인 간격 (바뀐 게 없으면 서버가 거의 일을 하지 않아요)

let ui = { show: () => {}, toast: () => {} };
let auth = null;          // { room: 방ID, name: 방 이름, password }
let timer = null, filter = 'all', items = [], codes = [], firstLoad = true, armed = null, ver = null, busy = false;
let viewCode = null;      // 불러온(보고 있는) 코드. null = 가장 최근 코드
let codeFilter = 'all';   // 'all' | '1234' : 사진 목록을 코드별로 보기
let formMode = 'login';   // 'login' | 'signup'
const armTimers = {};
const seen = new Set(), cards = new Map();
const selected = new Set();   // A4 모아찍기용으로 선택한 사진 id

const sess = {
  get() { try { return JSON.parse(sessionStorage.getItem('pb_tauth')); } catch (e) { return auth; } },
  set(v) { try { v ? sessionStorage.setItem('pb_tauth', JSON.stringify(v)) : sessionStorage.removeItem('pb_tauth'); } catch (e) {} }
};

/* ---------- 입장 / 새 방 만들기 ---------- */
export function enterTeacherLogin() {
  const saved = sess.get();
  if (saved) { auth = saved; ui.show('teacher'); return; }
  setFormMode('login');
  ['#tRoom', '#tPw', '#tPw2', '#tInvite'].forEach(s => { $(s).value = ''; });
  setTimeout(() => (MODE === 'remote' ? $('#tRoom') : $('#tPw')).focus(), 100);
}
function setFormMode(m) {
  formMode = m;
  const remote = MODE === 'remote', signup = m === 'signup';
  $('#tLoginErr').textContent = '';
  $('#tRoomWrap').hidden = !remote;
  $('#tPw2Wrap').hidden = !signup; $('#tInviteWrap').hidden = !signup;
  $('#tSwitch').hidden = !remote;
  $('#tFormTitle').textContent = signup ? '새 방 만들기' : '선생님 모드';
  $('#tLoginBtn').textContent = signup ? '방 만들고 입장하기' : '입장하기';
  $('#tSwitch').textContent = signup ? '← 이미 방이 있어요 (입장하기)' : '처음이세요? 새 방 만들기 →';
  $('#tPw').placeholder = signup ? '비밀번호 (4자 이상)' : '비밀번호';
  $('#tLoginHint').textContent = !remote
    ? (TEST_PASSWORD === '0000' ? '처음 비밀번호는 0000 이에요. (config.js에서 바꿀 수 있어요)' : '비밀번호를 입력하세요.')
    : signup ? '방 이름과 비밀번호를 정해 주세요. 가입 코드는 관리자 선생님께 받으세요.' : '내 방 이름과 비밀번호를 입력하세요.';
}
async function login(e) {
  e.preventDefault();
  const name = $('#tRoom').value.trim(), password = $('#tPw').value;
  const err = t => { $('#tLoginErr').textContent = t; };
  if (MODE === 'remote' && name.length < 2) return err('방 이름을 2글자 이상 입력해 주세요.');
  if (formMode === 'signup') {
    if (password.length < 4) return err('비밀번호는 4자 이상으로 정해 주세요.');
    if (password !== $('#tPw2').value) return err('비밀번호 확인이 서로 달라요.');
    if (!$('#tInvite').value.trim()) return err('가입 코드를 입력해 주세요.');
  }
  const btn = $('#tLoginBtn'); btn.disabled = true; err('');
  try {
    if (formMode === 'signup') await backend.createRoom(name, password, $('#tInvite').value.trim());
    const j = await backend.login({ name, password });
    auth = { room: j.room.id, name: j.room.name, password };
    sess.set(auth);
    if (formMode === 'signup') ui.toast(`'${j.room.name}' 방이 만들어졌어요! 다음부터는 방 이름과 비밀번호로 입장해요`);
    ui.show('teacher');
  } catch (e2) { err(errorText(e2)); }
  finally { btn.disabled = false; }
}

export function enterTeacher() {
  if (!auth) auth = sess.get();
  if (!auth) { ui.show('tlogin'); return; }
  $('#tModeBadge').hidden = MODE !== 'local';
  $('#tRoomName').textContent = MODE === 'remote' ? auth.name : '';
  $('#tRoomName').hidden = MODE !== 'remote';
  firstLoad = true; seen.clear(); viewCode = null; codeFilter = 'all'; armed = null; ver = null; syncFilterUI();
  cards.forEach(c => c.remove()); cards.clear(); items = []; codes = [];
  refresh();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}
export function leaveTeacher() { clearInterval(timer); timer = null; }

function logout() { auth = null; sess.set(null); leaveTeacher(); ui.show('home'); }

/* ---------- 데이터 불러오기 (바뀐 게 있을 때만 전체 목록을 받음) ---------- */
async function refresh(force) {
  if (busy || !auth) return;
  busy = true;
  try {
    const j = await backend.list(auth, force ? null : ver);
    setLive('on', 'LIVE');
    if (j.same) { if (!armed) renderCode(); return; }
    ver = j.v || null;
    codes = j.codes || []; items = j.items;
    let fresh = 0;
    items.forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); if (!firstLoad) { it._fresh = true; fresh++; } } });
    if (fresh) { ding(); ui.toast(`새 사진 ${fresh}장이 도착했어요 ✦`); }
    firstLoad = false;
    if (!armed) { renderCode(); renderGallery(); }
  } catch (err) {
    if (err.code === 'WRONG_PASSWORD') { logout(); ui.toast('비밀번호가 바뀌었어요. 다시 입장해 주세요'); return; }
    setLive('off', '연결 확인 중');
  } finally { busy = false; }
}
function setLive(cls, text) { const l = $('#tLive'); l.className = 'live ' + cls; $('#tLiveText').textContent = text; }

/* ---------- 입장 코드 (여러 개, 각 3일 보관 · 불러오기 · 삭제) ---------- */
function remainText(ms) {
  if (ms <= 0) return '만료됨';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return d ? `${d}일 ${h}시간 남음` : h ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}
const endText = t => new Date(t).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shownCode = () => codes.find(c => c.code === viewCode) || codes[0] || null;
const photoCount = code => items.filter(it => it.code === code).length;

/* 두 번 눌러야 실행 (실수 방지) */
function armed2(key, label, el) {
  if (armed === key) { armed = null; return true; }
  armed = key; el.textContent = label; el.classList.add('armed');
  clearTimeout(armTimers.t); armTimers.t = setTimeout(() => { if (armed === key) { armed = null; renderCode(); renderGallery(); } }, 3500);
  return false;
}

function renderCode() {
  const c = shownCode();
  $('#tCode').textContent = c ? c.code : '----';
  $('#tCode').classList.toggle('off', !c);
  $('#tCodeMeta').textContent = c ? `${remainText(c.expiresAt - Date.now())} · ${endText(c.expiresAt)}까지 · 사진 ${photoCount(c.code)}장`
    : '사용 중인 코드가 없어요. [새 코드 만들기]를 눌러 학생들에게 알려주세요.';
  $('#tCodeTag').textContent = c && codes.length > 1 ? (c === codes[0] ? '최근 코드' : '불러온 코드') : '';
  const list = $('#tCodeList');
  list.innerHTML = '';
  list.hidden = codes.length === 0;
  codes.forEach(code => {
    const row = document.createElement('div');
    const on = c && c.code === code.code;
    row.className = 'code-row' + (on ? ' on' : '');
    row.innerHTML = `<b class="cr-code"></b><span class="cr-meta"></span>
      <button class="btn btn-ghost cr-load" type="button"></button>
      <button class="btn btn-ghost cr-del" type="button">삭제</button>`;
    row.querySelector('.cr-code').textContent = code.code;
    row.querySelector('.cr-meta').textContent = `${remainText(code.expiresAt - Date.now())} · 사진 ${photoCount(code.code)}장`;
    const load = row.querySelector('.cr-load');
    load.textContent = on ? '보는 중' : '불러오기'; load.disabled = on;
    load.addEventListener('click', () => { viewCode = code.code; codeFilter = code.code; syncFilterUI(); renderCode(); renderGallery(); });
    const del = row.querySelector('.cr-del');
    del.addEventListener('click', () => deleteCode(code.code, del));
    list.appendChild(row);
  });
  $('#tCodeListHead').hidden = codes.length === 0;
}
async function newCode() {
  try {
    const j = await backend.createCode(auth);
    codes = j.codes; viewCode = j.created.code;
    ui.toast(`새 입장 코드: ${j.created.code} (3일 동안 사용 가능)`);
  } catch (err) { ui.toast(errorText(err)); }
  renderCode();
}
async function deleteCode(code, btn) {
  if (!armed2('code:' + code, '정말 삭제?', btn)) return;
  try {
    const j = await backend.deleteCode(auth, code);
    codes = j.codes;
    if (viewCode === code) viewCode = null;
    if (codeFilter === code) { codeFilter = 'all'; syncFilterUI(); }
    ui.toast(`코드 ${code}를 삭제했어요. 이 코드로는 더 이상 보낼 수 없어요 (사진은 그대로 남아요)`);
  } catch (err) { ui.toast(errorText(err)); }
  renderCode(); renderGallery();
}
function syncFilterUI() {
  $('#tCodeFilter').textContent = codeFilter === 'all' ? '모든 코드의 사진' : `코드 ${codeFilter} 사진만`;
  $('#tShowAll').hidden = codeFilter === 'all';
}

/* ---------- 사진 목록 ---------- */
const fmtTime = t => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function makeCard(it) {
  const card = document.createElement('article');
  card.className = 'card photo-card';
  card.innerHTML = `
    <div class="photo-box"><img alt="" loading="lazy" /><a class="img-fallback" target="_blank" rel="noopener" hidden>미리보기를 불러올 수 없어요<br><b>드라이브에서 열기 ↗</b></a>
      <label class="sel" title="A4 모아찍기에 넣기"><input type="checkbox" aria-label="이 사진 선택" /><span>선택</span></label>
      <span class="new-tag" hidden>NEW</span><span class="printed-tag" hidden>인쇄 완료</span></div>
    <div class="photo-info"><span><b class="no"></b> · <span class="lay"></span></span><span class="time"></span></div>
    <div class="photo-actions">
      <button class="btn btn-primary" data-act="download" type="button">⬇ 원본 다운로드</button>
      <button class="btn btn-ghost" data-act="print" type="button">🖨 바로 인쇄</button>
      <button class="btn btn-ghost" data-act="toggle" type="button"></button>
      <button class="btn btn-ghost btn-del" data-act="delete" type="button">🗑 삭제</button>
    </div>`;
  const img = card.querySelector('img'), fb = card.querySelector('.img-fallback');
  img.addEventListener('error', () => { img.hidden = true; fb.hidden = false; });
  img.src = it.thumb; fb.href = it.open;
  card.querySelector('[data-act="download"]').addEventListener('click', () => download(card._it));
  card.querySelector('[data-act="print"]').addEventListener('click', () => printPhoto(card._it));
  card.querySelector('[data-act="toggle"]').addEventListener('click', () => togglePrinted(card._it));
  card.querySelector('[data-act="delete"]').addEventListener('click', e => deletePhoto(card._it, e.currentTarget));
  card.querySelector('.sel input').addEventListener('change', e => {
    e.target.checked ? selected.add(card._it.id) : selected.delete(card._it.id);
    card.classList.toggle('is-selected', e.target.checked); syncSelUI();
  });
  return card;
}
function renderGallery() {
  const scope = codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter);
  const all = scope.length, done = scope.filter(d => d.printed).length;
  $('#statAll').textContent = all; $('#statDone').textContent = done; $('#statWait').textContent = all - done;
  const byCode = codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter);
  const list = byCode.filter(d => filter === 'all' || (filter === 'done' ? d.printed : !d.printed));
  const g = $('#gallery'), keep = new Set();
  list.forEach(it => {
    let card = cards.get(it.id);
    if (!card) { card = makeCard(it); cards.set(it.id, card); }
    card._it = it; keep.add(it.id);
    const no = items.length - items.indexOf(it);
    card.querySelector('.no').textContent = '#' + String(no).padStart(3, '0');
    card.querySelector('.lay').textContent = `${LAYOUT_NAME[it.layout] || '사진'} · 코드 ${it.code || '-'}`;
    const del = card.querySelector('[data-act="delete"]');
    if (armed !== 'photo:' + it.id) { del.textContent = '🗑 삭제'; del.classList.remove('armed'); }
    card.querySelector('.time').textContent = fmtTime(it.created);
    card.querySelector('.printed-tag').hidden = !it.printed;
    card.querySelector('[data-act="toggle"]').textContent = it.printed ? '↺ 대기로' : '✓ 인쇄 완료';
    card.classList.toggle('is-printed', !!it.printed);
    const on = selected.has(it.id); card.querySelector('.sel input').checked = on; card.classList.toggle('is-selected', on);
    if (it._fresh) { card.querySelector('.new-tag').hidden = false; card.classList.remove('fresh'); void card.offsetWidth; card.classList.add('fresh'); delete it._fresh; }
    g.appendChild(card);                               // 순서 맞추기 (이미 있는 카드는 이동만 → 깜빡임 없음)
  });
  cards.forEach((c, id) => { if (!keep.has(id)) c.remove(); });
  $('#empty').hidden = list.length > 0;
  [...selected].forEach(id => { if (!items.some(x => x.id === id)) selected.delete(id); });   // 지워진 사진은 선택에서 빼기
  syncSelUI();
}
function syncSelUI() {
  $('#tSelInfo').textContent = selected.size ? `${selected.size}장 선택됨` : '';
  $('#tSelClear').hidden = !selected.size;
}
const visibleList = () => {
  const byCode = codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter);
  return byCode.filter(d => filter === 'all' || (filter === 'done' ? d.printed : !d.printed));
};

/* ---------- A4로 모아 인쇄 ---------- */
function a4Targets(kind) {
  if (kind === 'selected') return items.filter(it => selected.has(it.id));
  if (kind === 'wait') return (codeFilter === 'all' ? items : items.filter(d => d.code === codeFilter)).filter(it => !it.printed);
  return visibleList();
}
function a4Summary(list) {
  const groups = {};
  list.forEach(it => { const k = A4_PLAN[it.layout] ? it.layout : 'postcard'; (groups[k] ||= []).push(it); });
  return groups;
}
function openA4Modal() {
  const counts = { selected: a4Targets('selected').length, wait: a4Targets('wait').length, visible: a4Targets('visible').length };
  $$('#a4Modal input[name="a4t"]').forEach(r => {
    r.disabled = !counts[r.value];
    r.closest('label').querySelector('b').textContent = counts[r.value] + '장';
  });
  const first = ['selected', 'wait', 'visible'].find(k => counts[k]);
  if (!first) { ui.toast('인쇄할 사진이 없어요'); return; }
  $(`#a4Modal input[value="${first}"]`).checked = true;
  updateA4Summary();
  $('#a4Modal').hidden = false;
}
function updateA4Summary() {
  const kind = $('#a4Modal input[name="a4t"]:checked')?.value || 'visible';
  const g = a4Summary(a4Targets(kind));
  let pages = 0;
  const lines = Object.entries(g).map(([k, l]) => { const n = Math.ceil(l.length / A4_PLAN[k].per); pages += n; return `<li><b>${LAYOUT_NAME[k]}</b> ${l.length}장 → A4 ${n}장 <small>(한 장에 ${A4_PLAN[k].per}개)</small></li>`; });
  $('#a4Summary').innerHTML = lines.join('') + `<li class="total">모두 A4 <b>${pages}장</b></li>`;
}
function buildA4Html(list) {
  const g = a4Summary(list), pages = [];
  Object.entries(g).forEach(([k, l]) => {
    const P = A4_PLAN[k];
    for (let i = 0; i < l.length; i += P.per) {
      const cells = l.slice(i, i + P.per).map(it => {
        const img = P.rot
          ? `<img src="${it.full}" style="width:${P.h}mm;height:${P.w}mm;transform:translate(-50%,-50%) rotate(-90deg)">`
          : `<img src="${it.full}" style="width:${P.w}mm;height:${P.h}mm;transform:translate(-50%,-50%)">`;
        return `<div class="cell" style="width:${P.w}mm;height:${P.h}mm">${img}</div>`;
      }).join('');
      pages.push(`<section class="page"><div class="grid" style="grid-template-columns:repeat(${P.cols}, ${P.w}mm)">${cells}</div>
        <p class="foot">PHOTO BOOTH · ${LAYOUT_NAME[k]} · 점선을 따라 자르세요</p></section>`);
    }
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>A4 모아 인쇄</title><style>
    @page { size: A4 portrait; margin: 8mm; }
    * { box-sizing: border-box; } html, body { margin: 0; }
    body { font-family: sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: 194mm; height: 280mm; display: flex; flex-direction: column; align-items: center; justify-content: space-between; page-break-after: always; break-after: page; overflow: hidden; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .grid { display: grid; gap: 5mm; justify-content: center; align-content: start; }
    .cell { position: relative; overflow: hidden; outline: 0.25mm dashed #b9b9c0; outline-offset: 1.2mm; }
    .cell img { position: absolute; left: 50%; top: 50%; object-fit: cover; display: block; }
    .foot { margin: 0; font-size: 7pt; color: #999; }
    @media screen { body { background: #e5e5ea; } .page { background: #fff; margin: 10px auto; padding: 8mm; width: 210mm; height: 297mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); } }
  </style></head><body>${pages.join('')}</body></html>`;
}
function printA4() {
  const kind = $('#a4Modal input[name="a4t"]:checked')?.value || 'visible';
  const list = a4Targets(kind);
  if (!list.length) return;
  const win = window.open('', '_blank');
  if (!win) { ui.toast('팝업이 차단되었어요. 주소창에서 팝업을 허용해 주세요'); return; }
  win.document.write(buildA4Html(list)); win.document.close();
  const markAfter = $('#a4Mark').checked;
  $('#a4Modal').hidden = true;
  // 모든 사진이 불러와진 뒤 인쇄 창 열기
  const imgs = [...win.document.images]; let left = imgs.length;
  const go = () => { if (--left <= 0) setTimeout(() => win.print(), 400); };
  imgs.forEach(im => (im.complete ? go() : (im.onload = im.onerror = go)));
  if (!imgs.length) win.print();
  if (markAfter) {
    let done = false;
    const mark = async () => {
      if (done) return; done = true;
      const ids = list.filter(it => !it.printed).map(it => it.id);
      if (!ids.length) return;
      list.forEach(it => { it.printed = true; }); renderGallery();
      try { await backend.setPrintedMany(auth, ids, true); ui.toast(`${ids.length}장을 '인쇄 완료'로 표시했어요`); }
      catch (err) { ui.toast(errorText(err)); }
    };
    win.addEventListener('afterprint', mark);
  }
  selected.clear(); syncSelUI(); renderGallery();
}

/* ---------- 다운로드 / 인쇄 / 인쇄 완료 ---------- */
function download(it) {
  const no = items.length - items.indexOf(it);
  const a = document.createElement('a');
  a.href = it.download;
  if (it.local) a.download = `photobooth_${String(no).padStart(3, '0')}.png`; else { a.target = '_blank'; a.rel = 'noopener'; }
  document.body.appendChild(a); a.click(); a.remove();
}
function printPhoto(it) {
  const [w, h] = PRINT_SIZE[it.layout] || ['4in', '6in'];
  const win = window.open('', '_blank');
  if (!win) { ui.toast('팝업이 차단되었어요. 주소창에서 팝업을 허용해 주세요'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>인쇄</title><style>
    @page { size: ${w} ${h}; margin: 0; } html,body { margin:0; height:100%; }
    body { display:flex; align-items:center; justify-content:center; } img { width:${w}; height:${h}; object-fit:contain; }
    </style></head><body><img src="${it.full}" onload="setTimeout(function(){window.print();},300)"></body></html>`);
  win.document.close();
}
async function togglePrinted(it) {
  const next = !it.printed; it.printed = next; renderGallery();          // 화면 먼저 바꾸고
  try { await backend.setPrinted(auth, it.id, next); }                     // 저장
  catch (err) { it.printed = !next; renderGallery(); ui.toast(errorText(err)); }
}

async function deletePhoto(it, btn) {
  if (!armed2('photo:' + it.id, '정말 삭제?', btn)) return;
  const idx = items.indexOf(it);
  items = items.filter(x => x !== it); renderGallery(); renderCode();            // 화면에서 먼저 지우고
  try { await backend.deletePhoto(auth, it.id); ui.toast(MODE === 'remote' ? '사진을 삭제했어요 (드라이브 휴지통에서 30일 안에 복구 가능)' : '사진을 삭제했어요'); }
  catch (err) { items.splice(idx, 0, it); renderGallery(); renderCode(); ui.toast(errorText(err)); }
}

/* ---------- 새 사진 알림음 ---------- */
let ac;
function ding() {
  if (!$('#soundOn').checked) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    [880, 1318].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * .12;
      o.frequency.value = f; g.gain.setValueAtTime(.12, t); g.gain.exponentialRampToValueAtTime(.0001, t + .25);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + .3);
    });
  } catch (e) {}
}

/* ---------- 연결 ---------- */
export function initTeacher(api) {
  ui = api;
  $('#tLoginForm').addEventListener('submit', login);
  $('#tLoginBack').addEventListener('click', () => ui.show('home'));
  $('#tSwitch').addEventListener('click', () => setFormMode(formMode === 'login' ? 'signup' : 'login'));
  $('#tLogout').addEventListener('click', logout);
  $('#tNewCode').addEventListener('click', newCode);
  $('#tShowAll').addEventListener('click', () => { codeFilter = 'all'; syncFilterUI(); renderGallery(); });
  $('#tRefresh').addEventListener('click', () => refresh(true));
  $('#tA4').addEventListener('click', openA4Modal);
  $('#tSelClear').addEventListener('click', () => { selected.clear(); renderGallery(); });
  $$('#a4Modal input[name="a4t"]').forEach(r => r.addEventListener('change', updateA4Summary));
  $('#a4Cancel').addEventListener('click', () => { $('#a4Modal').hidden = true; });
  $('#a4Modal').addEventListener('click', e => { if (e.target.id === 'a4Modal') $('#a4Modal').hidden = true; });
  $('#a4Go').addEventListener('click', printA4);
  $$('#tTabs button').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter; $$('#tTabs button').forEach(x => x.classList.toggle('on', x === b)); renderGallery();
  }));
  setInterval(() => { if (codes.length && document.body.dataset.screen === 'teacher' && !armed) renderCode(); }, 30000);
}

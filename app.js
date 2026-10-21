// DeskMate 手機／平板端：我的電腦清單、配對、看畫面、用手指控制電腦。
// 規則（手勢、縮放、鍵盤、認證、清單）都在 lib/ 的純函數裡，這裡只負責接 DOM 跟網路。
//
// 兩種開法：
//   雲端（GitHub Pages）：經過雲端中繼找到電腦，在哪都能連
//   區網（從電腦的網址打開）：直接連那台電腦，沒網路也能用
// 不管哪種，登入和畫面協商都有端到端簽章；連上之後滑鼠鍵盤只走加密的 WebRTC 資料通道。
import { RELAY_URL } from './config.js';
import { authProof, deriveDeviceToken, sessionKey, signPayload, verifyPayload, lookupKey, randomHex } from './lib/sha256.js';
import { createRecognizer, accelerate } from './lib/gestures.js';
import * as vp from './lib/viewport.js';
import * as kb from './lib/keyboard.js';
import * as hosts from './lib/computers.js';

const $ = (id) => document.getElementById(id);
const DEVICE_KEY = 'deskmate:device';
const COMPUTERS_KEY = 'deskmate:computers';
const PREFS_KEY = 'deskmate:prefs';
const SCROLL_GAIN = 2;
const KBD_SENTINEL = '  ';
const STATUS_POLL_MS = 15000;
const RELAY_PING_MS = 30000;

// ---------- 小工具 ----------
function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const relayHttp = () => RELAY_URL.replace(/^ws/, 'http').replace(/\/$/, '');

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
    return m && m[1] && !/^wv$|^K$/.test(m[1].trim()) ? m[1].trim() : 'Android 手機';
  }
  if (/Macintosh/.test(ua)) return 'Mac 瀏覽器';
  if (/Windows/.test(ua)) return 'Windows 瀏覽器';
  return '瀏覽器';
}

function toast(text, ms = 1800) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- 狀態 ----------
const prefs = Object.assign(
  { mode: Math.min(screen.width, screen.height) >= 700 ? 'direct' : 'trackpad', quality: 'balanced', speed: 1, invertScroll: false },
  loadJSON(PREFS_KEY, {}),
);
const device = loadJSON(DEVICE_KEY, null) || { deviceId: `d_${randomHex(12)}` };
saveJSON(DEVICE_KEY, device);
let computers = loadJSON(COMPUTERS_KEY, []);
const saveComputers = () => saveJSON(COMPUTERS_KEY, computers);

const S = {
  mode: 'relay', // 'relay' | 'lan'
  lanHost: null, // 區網模式：{ hostId, name, os }
  online: {}, // hostId → true/false
  target: null, // { hostId, secret? } 這次要連的電腦（secret = 配對祕密，配對時才有）
  ws: null,
  pc: null,
  dc: null,
  iceQueue: [],
  iceServers: [],
  nonce: null,
  authNonce: null,
  cnonce: null,
  key: null,
  host: null,
  phase: 'home', // home | connecting | live
  noRetry: false,
  closeHint: 0,
  screens: [],
  currentScreen: null,
  cursor: { x: 0.5, y: 0.5 },
  cursorLocalAt: 0,
  moveDirty: false,
  scrollAcc: { x: 0, y: 0 },
  view: vp.identityView(),
  fit: { x: 0, y: 0, w: 0, h: 0 },
  cw: 0,
  ch: 0,
  videoW: 0,
  videoH: 0,
  sticky: {},
  rawDown: new Set(),
  retry: 0,
  retryTimer: null,
  statsTimer: null,
  pingTimer: null,
  statusTimer: null,
  rtt: null,
  fps: null,
  relayed: false,
  peer: 'new',
  mouseClicks: { t: 0, x: 0, y: 0, n: 0, b: '' },
};

const video = $('video');
const stage = $('stage');
const touch = $('touch');
const ring = $('cursor-ring');
const kbd = $('kbd');

// ---------- 首頁 ----------
const MONITOR_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16.5V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function showHome(view = 'list', opts = {}) {
  S.phase = view === 'busy' && opts.connecting ? 'connecting' : 'home';
  $('viewer').hidden = true;
  $('home').hidden = false;
  closeSheets();
  kbd.blur();
  $('view-list').hidden = view !== 'list';
  $('view-add').hidden = view !== 'add';
  $('view-busy').hidden = view !== 'busy';
  $('install-hint').hidden = !(isIOS && !isStandalone() && view !== 'busy');
  $('home-sub').textContent = S.mode === 'lan' ? `區網直連：${S.lanHost ? S.lanHost.name : ''}` : '遠端控制你的電腦';

  if (view === 'list') renderComputers();
  if (view === 'add') {
    $('add-error').hidden = !opts.error;
    $('add-error').textContent = opts.error || '';
    $('add-back').hidden = S.mode === 'lan' && !computers.length;
    $('add-note').textContent = S.mode === 'lan' ? '' : '不用跟電腦在同一個 Wi-Fi，在哪裡輸入都可以。';
  }
  if (view === 'busy') {
    $('busy-spinner').hidden = !opts.spinner;
    $('busy-title').textContent = opts.title || '連線中…';
    $('busy-text').textContent = opts.text || '';
    $('busy-retry').hidden = !opts.retry;
    $('busy-back').hidden = !opts.back;
  }
  pollStatus(view === 'list');
}

function renderComputers() {
  const list = $('computer-list');
  list.replaceChildren();
  const items = hosts.sortComputers(S.mode === 'lan' ? computers.filter((c) => S.lanHost && c.hostId === S.lanHost.hostId) : computers);
  $('list-empty').hidden = items.length > 0;
  for (const c of items) {
    const card = document.createElement('div');
    card.className = 'computer';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const icon = document.createElement('div');
    icon.className = 'computer-icon';
    icon.innerHTML = MONITOR_SVG;
    const text = document.createElement('div');
    text.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'computer-name';
    name.textContent = c.name || '電腦';
    const meta = document.createElement('div');
    meta.className = 'computer-meta';
    const dot = document.createElement('span');
    const known = S.mode === 'lan' || c.hostId in S.online;
    const isOn = S.mode === 'lan' || S.online[c.hostId];
    dot.className = `online-dot ${isOn ? 'on' : ''}`;
    const metaText = document.createElement('span');
    const osName = c.os === 'mac' ? 'Mac' : c.os === 'win' ? 'Windows' : '';
    metaText.textContent = [known ? (isOn ? '在線上' : '離線') : '', osName, c.lastUsedAt ? `上次 ${hosts.formatAgo(c.lastUsedAt)}` : '']
      .filter(Boolean)
      .join(' · ');
    meta.append(dot, metaText);
    text.append(name, meta);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'computer-more';
    more.setAttribute('aria-label', '移除');
    more.textContent = '⋯';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`從清單移除「${c.name}」？之後要重新配對才能連。`)) return;
      computers = hosts.removeComputer(computers, c.hostId);
      saveComputers();
      renderComputers();
    });
    card.append(icon, text, more);
    card.addEventListener('click', () => connectTo({ hostId: c.hostId }));
    list.append(card);
  }
}

// 首頁開著時，每 15 秒問一次哪些電腦在線上（離開首頁就停）
function pollStatus(on) {
  clearInterval(S.statusTimer);
  S.statusTimer = null;
  if (!on || S.mode !== 'relay' || !computers.length) return;
  const run = async () => {
    try {
      const res = await fetch(`${relayHttp()}/v1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: computers.map((c) => c.hostId) }),
      });
      if (!res.ok) return;
      S.online = (await res.json()).online || {};
      if (!$('view-list').hidden) renderComputers();
    } catch {}
  };
  run();
  S.statusTimer = setInterval(run, STATUS_POLL_MS);
}

// ---------- 連線 ----------
function connectTo(target) {
  S.target = target;
  S.noRetry = false;
  S.retry = 0;
  const known = hosts.findComputer(computers, target.hostId);
  showHome('busy', { connecting: true, spinner: true, title: target.secret ? '配對中…' : `連線到「${known ? known.name : '電腦'}」…` });
  openSocket();
}

function openSocket() {
  clearTimeout(S.retryTimer);
  clearInterval(S.pingTimer);
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }
  const url =
    S.mode === 'lan'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : `${RELAY_URL.replace(/\/$/, '')}/v1/client?id=${encodeURIComponent(S.target.hostId)}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  S.closeHint = 0;
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    onSignal(m);
  };
  ws.onclose = (e) => onClose(e);
  if (S.mode === 'relay') S.pingTimer = setInterval(() => ws.readyState === 1 && ws.send('ping'), RELAY_PING_MS);
}

function sendSig(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

// 控制訊息只走加密的資料通道
function sendCtl(msg) {
  if (S.dc && S.dc.readyState === 'open') S.dc.send(JSON.stringify(msg));
}

function onSignal(m) {
  switch (m.t) {
    case 'offline':
    case 'relay-busy':
      S.noRetry = true; // 接著會收到 close，由 onClose 顯示原因
      return;
    case 'challenge':
      S.nonce = m.nonce;
      S.host = m.host;
      tryAuth();
      return;
    case 'auth-fail':
      if (m.nonce) S.nonce = m.nonce;
      onAuthFail(m);
      return;
    case 'auth-ok':
      onAuthOk(m);
      return;
    case 'busy':
      S.noRetry = true;
      S.closeHint = 4001; // 經過中繼時關閉代碼會被換掉，先記住真正的原因
      return;
    case 'offer':
      onOffer(m).catch((err) => toast(`畫面連線失敗：${err.message}`));
      return;
    case 'ice':
      if (!m.candidate) return;
      if (S.pc && S.pc.remoteDescription) S.pc.addIceCandidate(m.candidate).catch(() => {});
      else S.iceQueue.push(m.candidate);
      return;
    case 'state':
      if (m.state === 'capture-failed') {
        showOverlay({ title: '電腦沒辦法錄製螢幕', text: '請在電腦的「系統設定 → 隱私權與安全性 → 螢幕錄製」打開 DeskMate，再重新連線。', retry: true, leave: true });
      }
      return;
    case 'bye':
      S.noRetry = true;
      S.closeHint = m.reason === 'replaced' ? 4002 : 4003;
      return;
    default:
  }
}

function tryAuth() {
  const known = hosts.findComputer(computers, S.target.hostId);
  S.cnonce = randomHex(16);
  S.authNonce = S.nonce;
  let mode;
  let proof;
  if (S.target.secret) {
    mode = 'pair';
    proof = authProof(S.target.secret, S.nonce, S.cnonce);
  } else if (known && known.token) {
    mode = 'token';
    proof = authProof(known.token, S.nonce, S.cnonce);
  } else {
    closeSocket();
    showHome('add');
    return;
  }
  sendSig({ t: 'auth', mode, deviceId: device.deviceId, deviceName: deviceName(), cnonce: S.cnonce, proof });
}

function onAuthFail(m) {
  const wasPairing = !!S.target.secret;
  S.noRetry = true;
  closeSocket();
  if (m.reason === 'locked') {
    const min = Math.max(1, Math.ceil((m.retryAfterMs || 0) / 60000));
    showHome('add', { error: `錯太多次了，${min} 分鐘後再試。` });
    return;
  }
  if (wasPairing) {
    showHome('add', { error: '配對碼不對，或已經用過了。看一下電腦上 DeskMate 視窗裡最新的 8 碼。' });
    return;
  }
  // 用裝置金鑰登入失敗＝電腦那邊把這台裝置移除了
  computers = hosts.removeComputer(computers, S.target.hostId);
  saveComputers();
  showHome('add', { error: '這台電腦已經移除了你的手機，請重新輸入配對碼。' });
}

function onAuthOk(m) {
  const known = hosts.findComputer(computers, S.target.hostId);
  const token = S.target.secret ? deriveDeviceToken(S.target.secret, device.deviceId, S.authNonce, S.cnonce) : known && known.token;
  const key = token && sessionKey(token, S.authNonce, S.cnonce);
  // 確認對面真的是那台電腦（它也必須知道裝置金鑰）
  if (!key || m.hostId !== S.target.hostId || !verifyPayload(key, 'auth-ok', m.hostId, m.mac)) {
    S.noRetry = true;
    closeSocket();
    showHome('busy', { title: '電腦身分驗證失敗', text: '對面不是你配對的那台電腦，已經中斷。', back: true });
    return;
  }
  S.key = key;
  const now = new Date().toISOString();
  computers = hosts.upsertComputer(computers, { hostId: m.hostId, name: m.host.name, os: m.host.os, token, lastUsedAt: now });
  saveComputers();
  if (S.target.secret) {
    S.target = { hostId: m.hostId }; // 配對祕密用過就丟
    if (isIOS && !isStandalone()) setTimeout(() => toast('想像 App 一樣用：分享 → 加入主畫面', 4000), 1500);
  }
  S.host = m.host;
  S.screens = m.screens || [];
  S.iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
  S.retry = 0;
  S.noRetry = false;
  showViewer();
  showOverlay({ title: '正在接收畫面…', spinner: true });
  sendSig({ t: 'start', quality: prefs.quality, screenId: S.currentScreen });
}

async function onOffer(m) {
  // 沒有正確簽章的 offer 一律不收（不能讓中繼換成自己的加密指紋）
  if (!S.key || !verifyPayload(S.key, 'offer', m.sdp, m.mac)) {
    showOverlay({ title: '畫面連線被拒絕', text: '收到的連線資料簽章不對，為了安全已經停止。', retry: true, leave: true });
    return;
  }
  closePeer();
  S.iceQueue = [];
  const peer = new RTCPeerConnection({ iceServers: S.iceServers });
  S.pc = peer;
  peer.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  peer.ondatachannel = (e) => {
    S.dc = e.channel;
    S.dc.onmessage = (ev) => {
      try {
        onControl(JSON.parse(ev.data));
      } catch {}
    };
    const onOpen = () => {
      startStats();
      if (prefs.quality !== 'balanced') sendCtl({ t: 'quality', q: prefs.quality });
    };
    if (S.dc.readyState === 'open') onOpen();
    else S.dc.onopen = onOpen;
  };
  peer.onicecandidate = (e) => sendSig({ t: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
  peer.onconnectionstatechange = () => onPeerState(peer.connectionState);
  await peer.setRemoteDescription({ type: 'offer', sdp: m.sdp });
  for (const c of S.iceQueue) await peer.addIceCandidate(c).catch(() => {});
  S.iceQueue = [];
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  const sdp = peer.localDescription.sdp;
  sendSig({ t: 'answer', sdp, mac: signPayload(S.key, 'answer', sdp) });
}

// 電腦從加密資料通道送來的
function onControl(m) {
  switch (m.t) {
    case 'cursor':
      if (performance.now() - S.cursorLocalAt < 400) return;
      S.cursor = { x: m.x, y: m.y };
      drawCursor();
      return;
    case 'screens':
      S.screens = m.screens || [];
      S.currentScreen = m.current;
      renderScreens();
      return;
    case 'clip':
      $('clip-text').value = m.s;
      toast(m.s ? '已拿到電腦的剪貼簿' : '電腦的剪貼簿是空的');
      return;
    case 'toast':
      toast(m.message);
      return;
    case 'pong':
      S.rtt = Math.round(performance.now() - m.ts);
      renderChip();
      return;
    default:
  }
}

function onPeerState(state) {
  S.peer = state;
  renderChip();
  if (S.phase !== 'live') return;
  if (state === 'connected') hideOverlay();
  else if (state === 'failed') {
    showOverlay({ title: '畫面連不上', text: '重新試一次…', spinner: true });
    sendSig({ t: 'start', quality: prefs.quality, screenId: S.currentScreen });
  }
}

function closePeer() {
  if (S.dc) S.dc.close();
  if (S.pc) S.pc.close();
  S.dc = null;
  S.pc = null;
}

function closeSocket() {
  clearInterval(S.pingTimer);
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
    S.ws = null;
  }
}

function onClose(e) {
  clearInterval(S.pingTimer);
  stopStats();
  closePeer();
  releaseLocal();
  S.nonce = null;
  const code = S.closeHint || e.code;
  S.closeHint = 0;
  const reason = hosts.closeReason(code);
  if (S.phase === 'connecting') {
    if (reason) showHome('busy', { title: reason.title, text: reason.text, retry: reason.retry, back: true });
    else
      showHome('busy', {
        title: '連不上這台電腦',
        text: S.mode === 'lan' ? '確認電腦上的 DeskMate 有開著、手機跟電腦在同一個網路。' : '確認手機有網路、電腦上的 DeskMate 有開著。',
        retry: true,
        back: true,
      });
    return;
  }
  if (S.phase !== 'live') return;
  if (reason && (S.noRetry || code !== 4404)) {
    showOverlay({ title: reason.title, text: reason.text, retry: true, leave: true });
    return;
  }
  if (S.noRetry) {
    showOverlay({ title: '連線結束了', text: '', retry: true, leave: true });
    return;
  }
  S.retry += 1;
  const delay = Math.min(10000, 800 * 2 ** Math.min(S.retry, 4));
  showOverlay({ title: '連線中斷了', text: '正在重新連線…', spinner: true, leave: true });
  S.retryTimer = setTimeout(openSocket, delay);
}

function disconnect() {
  S.noRetry = true;
  sendCtl({ t: 'release-all' });
  releaseLocal();
  closeSocket();
  closePeer();
  stopStats();
  video.srcObject = null;
  showHome('list');
}

function reconnect() {
  S.noRetry = false;
  S.retry = 0;
  if (S.phase === 'live') showOverlay({ title: '重新連線中…', spinner: true });
  else showHome('busy', { connecting: true, spinner: true, title: '連線中…' });
  openSocket();
}

// ---------- 遠端畫面 ----------
function showViewer() {
  S.phase = 'live';
  pollStatus(false);
  $('home').hidden = true;
  $('viewer').hidden = false;
  hideOverlay();
  renderMode();
  renderKeys();
  renderChip();
  layout();
}

function showOverlay({ title, text = '', spinner = false, retry = false, leave = false }) {
  $('overlay').hidden = false;
  $('ov-title').textContent = title;
  $('ov-text').textContent = text;
  $('ov-spinner').hidden = !spinner;
  $('ov-retry').hidden = !retry;
  $('ov-leave').hidden = !leave;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

// ---------- 統計（延遲、幀率、是不是經過雲端轉送） ----------
function startStats() {
  stopStats();
  const tick = async () => {
    sendCtl({ t: 'ping', ts: performance.now() });
    if (S.pc) {
      try {
        const stats = await S.pc.getStats();
        let pairId = null;
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesPerSecond != null) S.fps = Math.round(r.framesPerSecond);
          if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        });
        const pair = pairId && stats.get(pairId);
        const local = pair && stats.get(pair.localCandidateId);
        S.relayed = !!local && local.candidateType === 'relay';
      } catch {}
    }
    renderChip();
  };
  tick();
  S.statsTimer = setInterval(tick, 2000);
}

function stopStats() {
  clearInterval(S.statsTimer);
  S.statsTimer = null;
}

function renderChip() {
  const chip = $('chip');
  const name = S.host ? S.host.name : '';
  let text = name;
  if (S.peer === 'connected') {
    const parts = [];
    if (S.rtt != null) parts.push(`${S.rtt}ms`);
    if (S.fps != null) parts.push(`${S.fps}fps`);
    if (S.relayed) parts.push('雲端轉送');
    if (parts.length) text = `${name} · ${parts.join(' · ')}`;
  }
  $('chip-text').textContent = text;
  chip.classList.toggle('good', S.peer === 'connected' && (S.rtt == null || S.rtt < 150));
  chip.classList.toggle('bad', S.peer === 'failed' || S.peer === 'disconnected');
}

// ---------- 版面與縮放 ----------
function layout() {
  const rect = $('viewer').getBoundingClientRect();
  S.cw = rect.width;
  S.ch = rect.height;
  S.fit = vp.fitRect(S.cw, S.ch, S.videoW, S.videoH);
  Object.assign(video.style, { left: `${S.fit.x}px`, top: `${S.fit.y}px`, width: `${S.fit.w}px`, height: `${S.fit.h}px` });
  S.view = vp.clampView(S.view, S.cw, S.ch, S.fit);
  applyView();
}

function applyView() {
  stage.style.transform = `translate(${S.view.tx}px, ${S.view.ty}px) scale(${S.view.scale})`;
  drawCursor();
}

function drawCursor() {
  const show = prefs.mode === 'trackpad' && S.videoW > 0;
  ring.hidden = !show;
  if (!show) return;
  const p = vp.normalizedToClient(S.cursor.x, S.cursor.y, S.view, S.fit);
  ring.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

function followCursor() {
  if (S.view.scale <= 1.01) return;
  const p = vp.normalizedToClient(S.cursor.x, S.cursor.y, S.view, S.fit);
  const next = vp.ensureVisible(S.view, p.x, p.y, 56, S.cw, S.ch, S.fit);
  if (next !== S.view) {
    S.view = next;
    applyView();
  }
}

function onVideoSize() {
  S.videoW = video.videoWidth;
  S.videoH = video.videoHeight;
  layout();
}
video.addEventListener('resize', onVideoSize);
video.addEventListener('loadedmetadata', onVideoSize);

function onViewportChange() {
  const vv = window.visualViewport;
  const kbH = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', `${kbH}px`);
  document.documentElement.style.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`);
  if (S.phase === 'live') layout();
}
window.addEventListener('resize', onViewportChange);
window.visualViewport && window.visualViewport.addEventListener('resize', onViewportChange);
window.visualViewport && window.visualViewport.addEventListener('scroll', onViewportChange);

// ---------- 送輸入事件 ----------
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flush);
}

function flush() {
  rafPending = false;
  if (S.moveDirty) {
    S.moveDirty = false;
    sendCtl({ t: 'm', x: S.cursor.x, y: S.cursor.y });
  }
  if (S.scrollAcc.x || S.scrollAcc.y) {
    sendCtl({ t: 'w', dx: Math.round(S.scrollAcc.x), dy: Math.round(S.scrollAcc.y) });
    S.scrollAcc = { x: 0, y: 0 };
  }
}

function queueMove() {
  S.moveDirty = true;
  S.cursorLocalAt = performance.now();
  schedule();
}

function flushMove() {
  if (S.moveDirty) {
    S.moveDirty = false;
    sendCtl({ t: 'm', x: S.cursor.x, y: S.cursor.y });
  }
}

function setCursorFromClient(x, y) {
  const n = vp.clientToNormalized(x, y, S.view, S.fit);
  S.cursor = { x: clamp01(n.x), y: clamp01(n.y) };
  queueMove();
  drawCursor();
}

function afterClick() {
  if (!Object.keys(S.sticky).length) return;
  const r = kb.consumeOnce(S.sticky);
  S.sticky = r.state;
  r.events.forEach(sendCtl);
  renderKeys();
}

function haptic() {
  if (navigator.vibrate) navigator.vibrate(8);
}

function runActions(actions) {
  for (const a of actions) {
    switch (a.type) {
      case 'cursorDelta': {
        const g = accelerate(a.dx, a.dy, a.dt, prefs.speed);
        const r = vp.contentRect(S.view, S.fit);
        if (!r.w || !r.h) break;
        S.cursor = { x: clamp01(S.cursor.x + g.dx / r.w), y: clamp01(S.cursor.y + g.dy / r.h) };
        queueMove();
        followCursor();
        drawCursor();
        break;
      }
      case 'pointTo':
        setCursorFromClient(a.x, a.y);
        break;
      case 'button':
        if (a.x != null) setCursorFromClient(a.x, a.y);
        flushMove();
        sendCtl({ t: 'b', b: a.button, d: a.down ? 1 : 0, n: 1 });
        if (!a.down) afterClick();
        else haptic();
        break;
      case 'click':
        if (a.x != null) setCursorFromClient(a.x, a.y);
        flushMove();
        sendCtl({ t: 'b', b: a.button, d: 1, n: a.count });
        sendCtl({ t: 'b', b: a.button, d: 0, n: a.count });
        haptic();
        afterClick();
        break;
      case 'scroll': {
        const k = (prefs.invertScroll ? -1 : 1) * SCROLL_GAIN;
        S.scrollAcc.x += a.dx * k;
        S.scrollAcc.y += a.dy * k;
        schedule();
        break;
      }
      case 'zoom':
        S.view = vp.zoomAt(S.view, a.factor, a.cx, a.cy, S.cw, S.ch, S.fit);
        S.view = vp.panBy(S.view, a.panX, a.panY, S.cw, S.ch, S.fit);
        applyView();
        break;
      default:
    }
  }
}

// ---------- 觸控（手指／觸控筆） ----------
const rec = createRecognizer(prefs.mode);
let longPressTimer = null;

function pointerEvent(e) {
  const r = touch.getBoundingClientRect();
  return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
}

touch.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return onMouseDown(e);
  touch.setPointerCapture(e.pointerId);
  runActions(rec.down(pointerEvent(e)));
  clearTimeout(longPressTimer);
  const deadline = rec.longPressDeadline;
  if (deadline) longPressTimer = setTimeout(() => runActions(rec.tick(performance.now())), deadline - performance.now() + 5);
});
touch.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') return onMouseMove(e);
  runActions(rec.move(pointerEvent(e)));
});
touch.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') return onMouseUp(e);
  clearTimeout(longPressTimer);
  runActions(rec.up(pointerEvent(e)));
});
touch.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'mouse') return;
  clearTimeout(longPressTimer);
  runActions(rec.cancel(pointerEvent(e)));
});
// 不讓 iOS 把手指在畫面上的動作當成「點到別處、把鍵盤收起來」或捲動頁面
touch.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
touch.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- 滑鼠（電腦瀏覽器、iPad 接滑鼠） ----------
const MOUSE_BUTTONS = ['left', 'middle', 'right'];

function onMouseMove(e) {
  const p = pointerEvent(e);
  setCursorFromClient(p.x, p.y);
}

function onMouseDown(e) {
  e.preventDefault();
  touch.setPointerCapture(e.pointerId);
  const b = MOUSE_BUTTONS[e.button] || 'left';
  const p = pointerEvent(e);
  const c = S.mouseClicks;
  const same = c.b === b && p.t - c.t < 400 && Math.hypot(p.x - c.x, p.y - c.y) < 6;
  S.mouseClicks = { t: p.t, x: p.x, y: p.y, n: same ? Math.min(3, c.n + 1) : 1, b };
  setCursorFromClient(p.x, p.y);
  flushMove();
  sendCtl({ t: 'b', b, d: 1, n: S.mouseClicks.n });
}

function onMouseUp(e) {
  const b = MOUSE_BUTTONS[e.button] || 'left';
  flushMove();
  sendCtl({ t: 'b', b, d: 0, n: S.mouseClicks.n });
  afterClick();
}

touch.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.ch : 1;
    if (e.ctrlKey) {
      // 觸控板捏合
      const p = pointerEvent(e);
      S.view = vp.zoomAt(S.view, Math.exp(-e.deltaY * 0.01), p.x, p.y, S.cw, S.ch, S.fit);
      applyView();
      return;
    }
    const k = prefs.invertScroll ? -1 : 1;
    S.scrollAcc.x += e.deltaX * unit * k;
    S.scrollAcc.y += e.deltaY * unit * k;
    schedule();
  },
  { passive: false },
);

// ---------- 鍵盤 ----------
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

function sendKeyTap(code) {
  sendCtl({ t: 'k', code, d: 1 });
  sendCtl({ t: 'k', code, d: 0 });
}

function releaseLocal() {
  for (const code of S.rawDown) sendCtl({ t: 'k', code, d: 0 });
  S.rawDown.clear();
  S.sticky = {};
  renderKeys();
}

function typedByHand(e) {
  return e.target && e.target.closest && e.target.closest('#clip-text, #pair-input');
}

document.addEventListener(
  'keydown',
  (e) => {
    if (S.phase !== 'live' || typedByHand(e)) return;
    if (kb.classifyKeyEvent(e) !== 'raw') return;
    e.preventDefault();
    S.rawDown.add(e.code);
    sendCtl({ t: 'k', code: e.code, d: 1 });
  },
  true,
);

document.addEventListener(
  'keyup',
  (e) => {
    if (!S.rawDown.has(e.code)) return;
    e.preventDefault();
    S.rawDown.delete(e.code);
    sendCtl({ t: 'k', code: e.code, d: 0 });
    // macOS 上按著 ⌘ 時，其他鍵放開不會有 keyup → ⌘ 放開時一併放掉
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
      for (const code of S.rawDown) sendCtl({ t: 'k', code, d: 0 });
      S.rawDown.clear();
    }
    if (!MODIFIERS.has(e.code)) afterClick();
  },
  true,
);

window.addEventListener('blur', () => {
  for (const code of S.rawDown) sendCtl({ t: 'k', code, d: 0 });
  S.rawDown.clear();
});

// 手機螢幕鍵盤：打好的字整串送過去（注音、拼音選完字才送）
function typeText(s) {
  if (!s) return;
  if (Object.keys(S.sticky).length && s.length === 1) {
    const k = kb.charToCode(s);
    if (k) {
      const needShift = k.shift && !S.sticky.ShiftLeft;
      if (needShift) sendCtl({ t: 'k', code: 'ShiftLeft', d: 1 });
      sendKeyTap(k.code);
      if (needShift) sendCtl({ t: 'k', code: 'ShiftLeft', d: 0 });
      afterClick();
      return;
    }
  }
  sendCtl({ t: 'txt', s });
}

function resetKbd() {
  kbd.value = KBD_SENTINEL;
  try {
    kbd.setSelectionRange(KBD_SENTINEL.length, KBD_SENTINEL.length);
  } catch {}
}
resetKbd();

kbd.addEventListener('beforeinput', (e) => {
  switch (e.inputType) {
    case 'insertText':
      e.preventDefault();
      typeText(e.data);
      break;
    case 'insertLineBreak':
    case 'insertParagraph':
      e.preventDefault();
      sendKeyTap('Enter');
      afterClick();
      break;
    case 'deleteContentBackward':
    case 'deleteWordBackward':
    case 'deleteSoftLineBackward':
      e.preventDefault();
      sendKeyTap('Backspace');
      break;
    case 'deleteContentForward':
      e.preventDefault();
      sendKeyTap('Delete');
      break;
    case 'insertFromPaste': {
      e.preventDefault();
      const text = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || e.data;
      if (text) sendCtl({ t: 'txt', s: text });
      break;
    }
    case 'insertReplacementText':
      e.preventDefault();
      break;
    default:
    // 選字中（insertCompositionText 等）讓它照常進行，compositionend 再送
  }
});
kbd.addEventListener('compositionend', (e) => {
  typeText(e.data);
  setTimeout(resetKbd, 0);
});
kbd.addEventListener('input', (e) => {
  if (!e.isComposing && kbd.value !== KBD_SENTINEL) resetKbd();
});
kbd.addEventListener('focus', () => $('tb-kbd').classList.add('on'));
kbd.addEventListener('blur', () => $('tb-kbd').classList.remove('on'));

// ---------- 特殊鍵面板 ----------
// 按下去當下就送（pointerdown），而且不搶走焦點 → 手機鍵盤不會被收起來
function onTap(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn(e);
  });
  el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

function keyButton(label, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `key ${cls}`;
  b.textContent = label;
  onTap(b, fn);
  return b;
}

function renderKeys() {
  const box = $('keys');
  const os = S.host ? S.host.os : 'mac';
  const labels = kb.modifierLabels(os);
  const modOrder = os === 'mac' ? ['ControlLeft', 'AltLeft', 'MetaLeft', 'ShiftLeft'] : ['ControlLeft', 'MetaLeft', 'AltLeft', 'ShiftLeft'];
  const row = (...children) => {
    const r = document.createElement('div');
    r.className = 'key-row';
    r.append(...children);
    return r;
  };
  // 常用的兩排要一眼看完，不用滑：平均分寬度
  const fitRow = (...children) => {
    const r = row(...children);
    r.classList.add('fit');
    return r;
  };
  const plain = (label, code) =>
    keyButton(label, '', () => {
      sendKeyTap(code);
      afterClick();
      haptic();
    });

  const mods = modOrder.map((code) =>
    keyButton(labels[code], `mod ${S.sticky[code] || ''}`, () => {
      const r = kb.tapModifier(S.sticky, code);
      S.sticky = r.state;
      r.events.forEach(sendCtl);
      renderKeys();
      haptic();
    }),
  );

  const shortcutKeys = kb.shortcuts(os).map((s) =>
    keyButton(s.label, 'chip-key', () => {
      kb.comboEvents(s.keys).forEach(sendCtl);
      haptic();
    }),
  );
  const fKeys = Array.from({ length: 12 }, (_, i) => plain(`F${i + 1}`, `F${i + 1}`));

  box.replaceChildren(
    fitRow(...mods, plain('Esc', 'Escape'), plain('Tab', 'Tab'), plain('⌫', 'Backspace'), plain('⏎', 'Enter')),
    fitRow(plain('←', 'ArrowLeft'), plain('↑', 'ArrowUp'), plain('↓', 'ArrowDown'), plain('→', 'ArrowRight'), plain('Home', 'Home'), plain('End', 'End'), plain('PgUp', 'PageUp'), plain('PgDn', 'PageDown'), plain('Del', 'Delete')),
    row(...shortcutKeys),
    row(...fKeys),
  );
}

// ---------- 工具列 ----------
function renderMode() {
  const trackpad = prefs.mode === 'trackpad';
  $('tb-mode-label').textContent = trackpad ? '觸控板' : '直接點';
  $('tb-mode').querySelector('use').setAttribute('href', trackpad ? '#i-trackpad' : '#i-hand');
  $('help-text').textContent = trackpad
    ? '觸控板模式：單指滑動移動游標，點一下＝左鍵，點兩下＝雙擊，點一下再按住滑＝拖曳，長按或雙指點＝右鍵，雙指滑＝捲動，雙指捏＝放大畫面。'
    : '直接點模式：手指點哪裡就點哪裡，單指拖＝拖曳，長按或雙指點＝右鍵，雙指滑＝捲動，雙指捏＝放大畫面。';
  drawCursor();
}

onTap($('tb-mode'), () => {
  prefs.mode = prefs.mode === 'trackpad' ? 'direct' : 'trackpad';
  saveJSON(PREFS_KEY, prefs);
  rec.setMode(prefs.mode);
  renderMode();
  toast(prefs.mode === 'trackpad' ? '觸控板模式：手指滑動移動游標' : '直接點模式：點哪裡就按哪裡');
});

// 鍵盤按鈕要用 click（iOS 只允許在使用者手勢裡叫出鍵盤）
$('tb-kbd').addEventListener('click', () => {
  if (document.activeElement === kbd) kbd.blur();
  else {
    resetKbd();
    kbd.focus();
  }
});

onTap($('tb-keys'), () => {
  $('keys').hidden = !$('keys').hidden;
  $('tb-keys').classList.toggle('on', !$('keys').hidden);
});

onTap($('tb-screens'), () => openSheet('sheet-screens'));
onTap($('tb-more'), () => openSheet('sheet-more'));
$('chip').addEventListener('click', () => openSheet('sheet-more'));

// ---------- 底部面板 ----------
function openSheet(id) {
  closeSheets();
  kbd.blur();
  $('sheet-backdrop').hidden = false;
  $(id).hidden = false;
  if (id === 'sheet-screens') renderScreens();
  if (id === 'sheet-more') renderMore();
}

function closeSheets() {
  $('sheet-backdrop').hidden = true;
  for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
}
$('sheet-backdrop').addEventListener('click', closeSheets);

function renderScreens() {
  const list = $('screen-list');
  list.replaceChildren();
  if (!S.screens.length) {
    list.textContent = '還沒拿到螢幕清單';
    return;
  }
  for (const s of S.screens) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `list-item ${s.id === S.currentScreen ? 'on' : ''}`;
    const left = document.createElement('span');
    left.textContent = `${s.name}${s.primary ? '（主螢幕）' : ''}`;
    const right = document.createElement('span');
    right.className = 'muted small';
    right.textContent = `${s.width}×${s.height}`;
    b.append(left, right);
    b.addEventListener('click', () => {
      sendCtl({ t: 'screen', id: s.id });
      S.view = vp.identityView();
      closeSheets();
      toast(`切換到 ${s.name}`);
    });
    list.append(b);
  }
}

function renderMore() {
  $('more-title').textContent = S.host ? S.host.name : '更多';
  for (const b of $('quality').querySelectorAll('button')) b.classList.toggle('on', b.dataset.q === prefs.quality);
  $('speed').value = prefs.speed;
  $('speed-value').textContent = `${Number(prefs.speed).toFixed(1)}×`;
  $('invert-scroll').checked = !!prefs.invertScroll;
  $('fullscreen').hidden = !document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen;
}

for (const b of $('quality').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    prefs.quality = b.dataset.q;
    saveJSON(PREFS_KEY, prefs);
    sendCtl({ t: 'quality', q: prefs.quality });
    renderMore();
  });
}
$('speed').addEventListener('input', () => {
  prefs.speed = Number($('speed').value);
  saveJSON(PREFS_KEY, prefs);
  renderMore();
});
$('invert-scroll').addEventListener('change', () => {
  prefs.invertScroll = $('invert-scroll').checked;
  saveJSON(PREFS_KEY, prefs);
});
$('clip-get').addEventListener('click', () => sendCtl({ t: 'clip-get' }));
$('clip-set').addEventListener('click', () => {
  const s = $('clip-text').value;
  if (!s) return toast('先在上面打字或貼上');
  sendCtl({ t: 'clip-set', s });
});
$('clip-copy').addEventListener('click', async () => {
  const s = $('clip-text').value;
  if (!s) return toast('沒有東西可以複製');
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    $('clip-text').select();
    document.execCommand('copy');
  }
  toast('已複製到手機');
});
$('reset-zoom').addEventListener('click', () => {
  S.view = vp.identityView();
  layout();
  closeSheets();
});
$('fullscreen').addEventListener('click', () => {
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  closeSheets();
});
$('disconnect').addEventListener('click', disconnect);
$('forget').addEventListener('click', () => {
  if (!confirm('忘記這台電腦？下次要重新配對。')) return;
  const hostId = S.target && S.target.hostId;
  disconnect();
  computers = hosts.removeComputer(computers, hostId);
  saveComputers();
  showHome('list');
});

// ---------- 遮罩、首頁按鈕 ----------
$('ov-retry').addEventListener('click', reconnect);
$('ov-leave').addEventListener('click', disconnect);
$('busy-retry').addEventListener('click', reconnect);
$('busy-back').addEventListener('click', () => {
  closeSocket();
  showHome('list');
});
$('add-btn').addEventListener('click', () => {
  $('pair-input').value = '';
  showHome('add');
  $('pair-input').focus();
});
$('add-back').addEventListener('click', () => showHome('list'));

// ---------- 輸入配對碼 ----------
const pairInput = $('pair-input');
pairInput.addEventListener('input', () => {
  pairInput.value = hosts.formatCode(hosts.normalizeCode(pairInput.value));
});
$('view-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = hosts.normalizeCode(pairInput.value);
  if (code.length !== 8) {
    showHome('add', { error: '配對碼是 8 個字' });
    return;
  }
  pairInput.blur();
  if (S.mode === 'lan') {
    connectTo({ hostId: S.lanHost.hostId, secret: code });
    return;
  }
  showHome('busy', { spinner: true, title: '找電腦中…' });
  try {
    const res = await fetch(`${relayHttp()}/v1/lookup?key=${lookupKey(code)}`);
    if (res.status === 404) {
      showHome('add', { error: '找不到這組配對碼。確認電腦上的 DeskMate 有開著、碼沒有打錯。' });
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { hostId } = await res.json();
    connectTo({ hostId, secret: code });
  } catch {
    showHome('add', { error: '連不上雲端，確認手機有網路再試一次。' });
  }
});

// 手機睡醒回來 → 連線多半已經斷了，馬上重連
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.phase === 'live' && !S.noRetry && (!S.ws || S.ws.readyState > 1)) {
    clearTimeout(S.retryTimer);
    S.retry = 0;
    openSocket();
  }
  if (S.phase === 'home' && !$('view-list').hidden) pollStatus(true);
});

// ---------- 開始 ----------
async function detectLan() {
  try {
    const res = await fetch('host.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.mode === 'lan' && j.hostId ? j : null;
  } catch {
    return null;
  }
}

(async function boot() {
  window.__deskmate = S; // 除錯用：在瀏覽器主控台看連線狀態
  onViewportChange();
  const pairing = hosts.parsePairHash(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // 祕密不留在網址列

  const lan = await detectLan();
  if (lan) {
    S.mode = 'lan';
    S.lanHost = lan;
  } else if (!RELAY_URL) {
    showHome('busy', { title: '這個網頁沒有設定雲端位置', text: '請從電腦上 DeskMate 視窗的 QR 打開。' });
    return;
  }

  // 掃 QR 進來：已經配對過這台就直接連，沒配對過才用祕密配對
  if (pairing) {
    const known = hosts.findComputer(computers, pairing.hostId);
    connectTo(known && known.token ? { hostId: pairing.hostId } : pairing);
    return;
  }
  if (S.mode === 'lan') {
    const known = hosts.findComputer(computers, lan.hostId);
    if (known && known.token) connectTo({ hostId: lan.hostId });
    else showHome('add');
    return;
  }
  // 只有一台電腦：直接連
  if (computers.length === 1) {
    connectTo({ hostId: computers[0].hostId });
    return;
  }
  showHome('list');
})();

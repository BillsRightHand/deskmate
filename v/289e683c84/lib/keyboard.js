// 鍵盤規則（純函數）

// 這個 keydown 該怎麼處理？
//   'raw'：實體鍵盤 → 直接把「哪顆鍵」傳過去（遠端的輸入法自己處理）
//   'ime'：手機螢幕鍵盤／正在選字 → 等打完字（input / compositionend）再把文字傳過去
export function classifyKeyEvent(e) {
  if (e.isComposing || e.keyCode === 229) return 'ime';
  if (!e.code || e.code === 'Unidentified') return 'ime';
  return 'raw';
}

const PLAIN = {
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
  ' ': 'Space', '\n': 'Enter', '\t': 'Tab',
};
const SHIFTED = {
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6',
  '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', _: 'Minus', '+': 'Equal',
  '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote',
  '<': 'Comma', '>': 'Period', '?': 'Slash', '~': 'Backquote',
};

// 美式鍵盤：字元 → 哪顆鍵（＋要不要 Shift）。按著 ⌘／Ctrl 用螢幕鍵盤打字時才用得到。
export function charToCode(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  if (ch >= 'a' && ch <= 'z') return { code: `Key${ch.toUpperCase()}`, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { code: `Key${ch}`, shift: true };
  if (ch >= '0' && ch <= '9') return { code: `Digit${ch}`, shift: false };
  if (PLAIN[ch]) return { code: PLAIN[ch], shift: false };
  if (SHIFTED[ch]) return { code: SHIFTED[ch], shift: true };
  return null;
}

// 組合鍵：依序按下，再反過來放開
export function comboEvents(codes) {
  const downs = codes.map((code) => ({ t: 'k', code, d: 1 }));
  const ups = [...codes].reverse().map((code) => ({ t: 'k', code, d: 0 }));
  return downs.concat(ups);
}

// 常用快捷鍵，依遠端是 Mac 還是 Windows 給不同的組合
export function shortcuts(os) {
  if (os === 'mac') {
    return [
      { id: 'copy', label: '複製', keys: ['MetaLeft', 'KeyC'] },
      { id: 'paste', label: '貼上', keys: ['MetaLeft', 'KeyV'] },
      { id: 'cut', label: '剪下', keys: ['MetaLeft', 'KeyX'] },
      { id: 'undo', label: '復原', keys: ['MetaLeft', 'KeyZ'] },
      { id: 'all', label: '全選', keys: ['MetaLeft', 'KeyA'] },
      { id: 'save', label: '儲存', keys: ['MetaLeft', 'KeyS'] },
      { id: 'find', label: '尋找', keys: ['MetaLeft', 'KeyF'] },
      { id: 'switch', label: '切換 App', keys: ['MetaLeft', 'Tab'] },
      { id: 'spotlight', label: 'Spotlight', keys: ['MetaLeft', 'Space'] },
      { id: 'mission', label: '所有視窗', keys: ['ControlLeft', 'ArrowUp'] },
      { id: 'close', label: '關視窗', keys: ['MetaLeft', 'KeyW'] },
      { id: 'quit', label: '結束 App', keys: ['MetaLeft', 'KeyQ'] },
      { id: 'shot', label: '截圖', keys: ['MetaLeft', 'ShiftLeft', 'Digit5'] },
      { id: 'lang', label: '切換輸入法', keys: ['ControlLeft', 'Space'] },
    ];
  }
  return [
    { id: 'copy', label: '複製', keys: ['ControlLeft', 'KeyC'] },
    { id: 'paste', label: '貼上', keys: ['ControlLeft', 'KeyV'] },
    { id: 'cut', label: '剪下', keys: ['ControlLeft', 'KeyX'] },
    { id: 'undo', label: '復原', keys: ['ControlLeft', 'KeyZ'] },
    { id: 'all', label: '全選', keys: ['ControlLeft', 'KeyA'] },
    { id: 'save', label: '儲存', keys: ['ControlLeft', 'KeyS'] },
    { id: 'find', label: '尋找', keys: ['ControlLeft', 'KeyF'] },
    { id: 'switch', label: '切換視窗', keys: ['AltLeft', 'Tab'] },
    { id: 'start', label: '開始', keys: ['MetaLeft'] },
    { id: 'tasks', label: '所有視窗', keys: ['MetaLeft', 'Tab'] },
    { id: 'desktop', label: '顯示桌面', keys: ['MetaLeft', 'KeyD'] },
    { id: 'close', label: '關閉程式', keys: ['AltLeft', 'F4'] },
    { id: 'shot', label: '截圖', keys: ['MetaLeft', 'ShiftLeft', 'KeyS'] },
    { id: 'lang', label: '切換輸入法', keys: ['MetaLeft', 'Space'] },
  ];
}

// 黏住的修飾鍵（⌘ ⌥ ⌃ ⇧）：點一下 = 只對下一個鍵有效，再點一下 = 鎖住，第三下 = 放開
// state: { [code]: 'once' | 'lock' }
export function tapModifier(state, code) {
  const cur = state[code];
  if (!cur) return { state: { ...state, [code]: 'once' }, events: [{ t: 'k', code, d: 1 }] };
  if (cur === 'once') return { state: { ...state, [code]: 'lock' }, events: [] };
  const next = { ...state };
  delete next[code];
  return { state: next, events: [{ t: 'k', code, d: 0 }] };
}

// 按了一個普通鍵或點了一下之後：只對一次有效的修飾鍵放開
export function consumeOnce(state) {
  const next = {};
  const events = [];
  for (const [code, v] of Object.entries(state)) {
    if (v === 'lock') next[code] = v;
    else events.push({ t: 'k', code, d: 0 });
  }
  return { state: next, events };
}

export function modifierLabels(os) {
  return os === 'mac'
    ? { MetaLeft: '⌘', AltLeft: '⌥', ControlLeft: '⌃', ShiftLeft: '⇧' }
    : { ControlLeft: 'Ctrl', AltLeft: 'Alt', MetaLeft: 'Win', ShiftLeft: 'Shift' };
}

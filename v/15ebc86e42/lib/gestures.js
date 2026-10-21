// 手勢辨識（純狀態機，不碰 DOM，方便測試）
//
// 兩種模式：
//   trackpad（觸控板）：單指滑 = 移動游標、點一下 = 左鍵、點兩下 = 雙擊、
//                      點一下再按住滑 = 拖曳、長按 = 右鍵
//   direct（直接點）：  手指點哪裡就點哪裡、單指拖 = 拖曳、長按 = 右鍵
// 兩種模式共用：雙指點 = 右鍵、雙指滑 = 捲動、雙指捏 = 放大縮小畫面（只在手機上）
//
// 輸入事件：{ id, x, y, t }（螢幕 px、毫秒）
// 輸出動作：
//   { type: 'cursorDelta', dx, dy, dt }       觸控板模式移動
//   { type: 'pointTo', x, y }                 直接模式移動到手指位置
//   { type: 'button', button, down, x?, y? }  按下／放開
//   { type: 'click', button, count, x?, y? }  點一下（count 2 = 雙擊）
//   { type: 'scroll', dx, dy }                DOM wheel 慣例（正 = 往下／往右捲）
//   { type: 'zoom', factor, cx, cy, panX, panY }

export const DEFAULTS = {
  tapSlop: 10, // 手指移動超過這麼多 px 就不算點擊
  twoTapMaxMs: 300, // 雙指點要在這時間內放開
  doubleTapMs: 350, // 兩次點擊間隔
  doubleTapSlop: 40,
  longPressMs: 550,
  pinchSlop: 28, // 兩指距離變化超過這個 → 捏
  scrollSlop: 8, // 兩指一起移動超過這個 → 捲動
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createRecognizer(initialMode = 'trackpad', opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let mode = initialMode;
  const pts = new Map();
  let state = 'idle';
  let start = null;
  let last = null;
  let lastTap = null;
  let tapDrag = false;
  let longPressAt = 0;
  let two = null;

  const withPos = (action, p) => (mode === 'direct' ? { ...action, x: p.x, y: p.y } : action);

  function centroid() {
    let x = 0;
    let y = 0;
    for (const p of pts.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pts.size, y: y / pts.size };
  }

  function twoDistance() {
    const [a, b] = [...pts.values()];
    return dist(a, b);
  }

  function reset() {
    state = 'idle';
    start = null;
    last = null;
    two = null;
    tapDrag = false;
    longPressAt = 0;
  }

  function down(e) {
    pts.set(e.id, { x: e.x, y: e.y });
    const out = [];
    if (pts.size === 1) {
      state = 'one';
      start = { x: e.x, y: e.y, t: e.t };
      last = { x: e.x, y: e.y, t: e.t };
      tapDrag = mode === 'trackpad' && !!lastTap && e.t - lastTap.t < o.doubleTapMs && dist(lastTap, e) < o.doubleTapSlop;
      longPressAt = tapDrag ? 0 : e.t + o.longPressMs;
      if (mode === 'direct') out.push({ type: 'pointTo', x: e.x, y: e.y });
      return out;
    }
    if (pts.size === 2 && (state === 'one' || state === 'moving')) {
      const c = centroid();
      const d = twoDistance();
      two = { t0: e.t, c0: c, lastC: c, d0: d, lastD: d };
      state = 'two';
      longPressAt = 0;
      return out;
    }
    if (pts.size >= 3) {
      if (state === 'dragging') out.push(withPos({ type: 'button', button: 'left', down: false }, last));
      state = 'done';
      longPressAt = 0;
    }
    return out;
  }

  function move(e) {
    const p = pts.get(e.id);
    if (!p) return [];
    p.x = e.x;
    p.y = e.y;
    const out = [];

    if (state === 'one' || state === 'moving' || state === 'dragging') {
      if (state === 'one') {
        if (dist(start, e) <= o.tapSlop) return out;
        longPressAt = 0;
        if (mode === 'direct') {
          state = 'dragging';
          out.push({ type: 'button', button: 'left', down: true, x: start.x, y: start.y });
        } else if (tapDrag) {
          state = 'dragging';
          out.push({ type: 'button', button: 'left', down: true });
        } else {
          state = 'moving';
        }
      }
      if (mode === 'direct') out.push({ type: 'pointTo', x: e.x, y: e.y });
      else out.push({ type: 'cursorDelta', dx: e.x - last.x, dy: e.y - last.y, dt: Math.max(1, e.t - last.t) });
      last = { x: e.x, y: e.y, t: e.t };
      return out;
    }

    if (state === 'two' || state === 'scroll' || state === 'pinch') {
      if (pts.size !== 2) return out;
      const c = centroid();
      const d = twoDistance();
      if (state === 'two') {
        if (Math.abs(d - two.d0) > o.pinchSlop) state = 'pinch';
        else if (dist(c, two.c0) > o.scrollSlop) state = 'scroll';
        else return out;
      }
      if (state === 'scroll') {
        // 手指往上滑 = 內容往上跑 = 往下捲（跟摸手機螢幕一樣的方向）
        out.push({ type: 'scroll', dx: -(c.x - two.lastC.x), dy: -(c.y - two.lastC.y) });
      } else {
        out.push({ type: 'zoom', factor: two.lastD > 0 ? d / two.lastD : 1, cx: c.x, cy: c.y, panX: c.x - two.lastC.x, panY: c.y - two.lastC.y });
      }
      two.lastC = c;
      two.lastD = d;
    }
    return out;
  }

  function up(e) {
    if (!pts.has(e.id)) return [];
    const out = [];

    if (state === 'one') {
      const sameSpot = lastTap && e.t - lastTap.t < o.doubleTapMs && dist(lastTap, start) < o.doubleTapSlop;
      const count = sameSpot ? Math.min(3, lastTap.count + 1) : 1;
      out.push(withPos({ type: 'click', button: 'left', count }, start));
      lastTap = { t: e.t, x: start.x, y: start.y, count };
      pts.delete(e.id);
      reset();
      return out;
    }

    if (state === 'dragging') {
      out.push(withPos({ type: 'button', button: 'left', down: false }, last));
      lastTap = null;
    } else if (state === 'moving') {
      lastTap = null;
    } else if (state === 'two') {
      if (e.t - two.t0 <= o.twoTapMaxMs) out.push(withPos({ type: 'click', button: 'right', count: 1 }, two.c0));
      lastTap = null;
    }

    pts.delete(e.id);
    if (pts.size === 0) reset();
    else if (state === 'moving' || state === 'two' || state === 'scroll' || state === 'pinch' || state === 'dragging') state = 'done';
    return out;
  }

  function cancel(e) {
    const out = [];
    if (state === 'dragging') out.push(withPos({ type: 'button', button: 'left', down: false }, last));
    pts.delete(e.id);
    if (pts.size === 0) reset();
    else state = 'done';
    lastTap = null;
    return out;
  }

  // 長按：由 UI 用 setTimeout 呼叫
  function tick(now) {
    if (state === 'one' && longPressAt && now >= longPressAt) {
      longPressAt = 0;
      state = 'done';
      lastTap = null;
      return [withPos({ type: 'click', button: 'right', count: 1 }, start)];
    }
    return [];
  }

  return {
    down,
    move,
    up,
    cancel,
    tick,
    get state() {
      return state;
    },
    get longPressDeadline() {
      return longPressAt || null;
    },
    setMode(m) {
      mode = m;
      pts.clear();
      reset();
      lastTap = null;
    },
  };
}

// 觸控板加速：慢慢滑可以精準點，快速滑可以一口氣跨過整個螢幕
export function accelerate(dx, dy, dtMs, sensitivity = 1) {
  const speed = Math.hypot(dx, dy) / Math.max(1, dtMs); // px/ms
  const gain = sensitivity * (1 + Math.min(2.5, speed * 1.2));
  return { dx: dx * gain, dy: dy * gain };
}

// 畫面縮放／平移的數學（純函數）
//
// 遠端畫面先等比例塞進容器（fit），再整層套 translate(tx, ty) scale(scale)，原點在左上角。
// 所以螢幕上的點 = scale × 舞台上的點 + t。

export const MAX_SCALE = 6;

export function fitRect(cw, ch, vw, vh) {
  if (!vw || !vh || !cw || !ch) return { x: 0, y: 0, w: cw || 0, h: ch || 0 };
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function identityView() {
  return { scale: 1, tx: 0, ty: 0 };
}

export function contentRect(view, fit) {
  return { x: fit.x * view.scale + view.tx, y: fit.y * view.scale + view.ty, w: fit.w * view.scale, h: fit.h * view.scale };
}

export function clientToNormalized(px, py, view, fit) {
  const r = contentRect(view, fit);
  return { x: r.w ? (px - r.x) / r.w : 0, y: r.h ? (py - r.y) / r.h : 0 };
}

export function normalizedToClient(nx, ny, view, fit) {
  const r = contentRect(view, fit);
  return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

// 放大後不能把畫面拖出容器；比容器小的那一邊置中
export function clampView(view, cw, ch, fit) {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const w = fit.w * scale;
  const h = fit.h * scale;
  const x0 = fit.x * scale;
  const y0 = fit.y * scale;
  const tx = w <= cw ? (cw - w) / 2 - x0 : Math.min(-x0, Math.max(cw - w - x0, view.tx));
  const ty = h <= ch ? (ch - h) / 2 - y0 : Math.min(-y0, Math.max(ch - h - y0, view.ty));
  return { scale, tx, ty };
}

// 以 (cx, cy) 為中心縮放：手指底下那一點不動
export function zoomAt(view, factor, cx, cy, cw, ch, fit) {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * factor));
  const k = scale / view.scale;
  return clampView({ scale, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k }, cw, ch, fit);
}

export function panBy(view, dx, dy, cw, ch, fit) {
  return clampView({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }, cw, ch, fit);
}

// 放大時游標快跑出畫面 → 跟著捲過去
export function ensureVisible(view, px, py, margin, cw, ch, fit) {
  let dx = 0;
  let dy = 0;
  if (px < margin) dx = margin - px;
  else if (px > cw - margin) dx = cw - margin - px;
  if (py < margin) dy = margin - py;
  else if (py > ch - margin) dy = ch - margin - py;
  if (!dx && !dy) return view;
  return clampView({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }, cw, ch, fit);
}

// 「我的電腦」清單的規則（純函數）
// 一筆：{ hostId, name, os, token, pairedAt, lastUsedAt }

const HOST_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

// QR 帶的網址：#h=<電腦 id>&k=<配對祕密>
export function parsePairHash(hash) {
  if (typeof hash !== 'string') return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const hostId = params.get('h');
  const secret = params.get('k');
  if (!hostId || !HOST_ID_RE.test(hostId) || !secret || secret.length > 128) return null;
  return { hostId, secret };
}

export function normalizeCode(input) {
  return typeof input === 'string' ? input.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8) : '';
}

export function formatCode(code) {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function findComputer(list, hostId) {
  return (list || []).find((c) => c.hostId === hostId) || null;
}

export function upsertComputer(list, entry) {
  const rest = (list || []).filter((c) => c.hostId !== entry.hostId);
  const prev = findComputer(list, entry.hostId);
  return [{ ...prev, ...entry, pairedAt: (prev && prev.pairedAt) || entry.pairedAt || entry.lastUsedAt }, ...rest];
}

export function removeComputer(list, hostId) {
  return (list || []).filter((c) => c.hostId !== hostId);
}

export function sortComputers(list) {
  return [...(list || [])].sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
}

export function formatAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 連線斷掉的原因 → 給使用者看的話
export function closeReason(code) {
  switch (code) {
    case 4404:
      return { title: '電腦目前離線', text: '電腦可能關機、睡著了，或是 DeskMate 沒有開。', retry: true };
    case 4429:
      return { title: '連線太多了', text: '同時有太多裝置在連這台電腦，等一下再試。', retry: true };
    case 4001:
      return { title: '電腦正在被別台裝置控制', text: '等它結束再試一次。', retry: true };
    case 4002:
      return { title: '這台裝置在別的地方連上了', text: '同一台裝置只能開一個畫面。', retry: true };
    case 4003:
      return { title: '電腦端中斷了連線', text: '', retry: true };
    default:
      return null;
  }
}

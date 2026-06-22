// Small client-side helpers shared across components.

export function uid() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function formatTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = dayKey(now.getTime());
  const yest = dayKey(now.getTime() - 86400000);
  const k = dayKey(ts);
  if (k === today) return 'Today';
  if (k === yest) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function shortStamp(ts) {
  if (!ts) return '';
  const now = Date.now();
  if (dayKey(ts) === dayKey(now)) return formatTime(ts);
  if (dayKey(ts) === dayKey(now - 86400000)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function lastSeenLabel(ts) {
  if (!ts) return 'offline';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'last seen just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `last seen ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `last seen ${hrs}h ago`;
  return `last seen ${formatTime(ts)}`;
}

export function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// localStorage helpers (guarded for SSR)
export const store = {
  get(key, fallback) {
    if (typeof window === 'undefined') return fallback;
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
};

// Upload a File/Blob to the server, returns { url, mime, name, size }
export async function uploadFile(fileOrBlob, filename) {
  const fd = new FormData();
  const f = filename ? new File([fileOrBlob], filename, { type: fileOrBlob.type }) : fileOrBlob;
  fd.append('file', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'Upload failed');
  }
  return res.json();
}

// Resize/compress an image file to a data URL (used for avatars)
export function fileToCompressedDataURL(file, max = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

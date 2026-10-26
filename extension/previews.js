// Volatile thumbnails only: never storage, disk or network.
export class PreviewCache {
  constructor({ now = Date.now, limit = 8, ttl = 120_000 } = {}) {
    this.now = now; this.limit = limit; this.ttl = ttl; this.items = new Map();
  }
  prune() {
    for (const [id, item] of this.items) if (this.now() - item.at >= this.ttl) this.items.delete(id);
  }
  put(id, url, data) {
    this.prune(); this.items.delete(id);
    this.items.set(id, { url, data, at: this.now() });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }
  get(id, url) {
    this.prune();
    const item = this.items.get(id);
    if (item?.url !== url) { this.items.delete(id); return null; }
    return item ? { data: item.data, at: item.at } : null;
  }
  delete(id) { this.items.delete(id); }
}
export async function thumbnail(dataUrl) {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const width = Math.min(bitmap.width, 480);
    const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type:'image/jpeg', quality:0.55 });
    const output = new Uint8Array(await blob.arrayBuffer());
    if (output.length > 150_000) return null;
    let binary = '';
    for (const byte of output) binary += String.fromCharCode(byte);
    return 'data:image/jpeg;base64,' + btoa(binary);
  } finally { bitmap.close(); }
}

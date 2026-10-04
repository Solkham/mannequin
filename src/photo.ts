// Своё фото вещи: убрать светлый однотонный фон, обрезать по вещи, найти основной цвет.
// Всё в браузере, фото никуда не уходит.

export interface PhotoPrint {
  canvas: HTMLCanvasElement;
  /** Основной цвет вещи, #rrggbb: им красятся спина и места без фото. */
  color: string;
}

const MAX = 768;

/** cut=false — картинка уже вырезана (сохранённая ранее), только найти цвет. */
export async function loadPhoto(src: Blob | string, cut = true): Promise<PhotoPrint> {
  const img = new Image();
  img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  await img.decode();
  const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k);
  const h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  if (typeof src !== 'string') URL.revokeObjectURL(img.src);
  return cutout(c, cut);
}

/** Фон = цвет углов кадра. Убираем заливкой от краёв всё, что близко к нему по цвету. */
export function cutout(c: HTMLCanvasElement, cut = true): PhotoPrint {
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = c;
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (x: number, y: number) => (y * w + x) * 4;

  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
  const bg = [0, 1, 2].map((ch) => corners.reduce((s, i) => s + d[i + ch], 0) / 4);
  const near = (i: number) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) < 38;

  // Заливка от краёв, чтобы не выбить светлые места внутри вещи.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  if (!cut) stack.length = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p]) continue;
    seen[p] = 1;
    if (!near(p * 4)) continue;
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }

  // Рамка вещи и основной цвет: самый частый оттенок (по корзинам 4 бита на канал),
  // а не среднее — иначе синяя футболка с жёлтым принтом станет грязно-фиолетовой.
  let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
  const bins = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      if (d[i + 3] === 0) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const bin = bins.get(key) ?? [0, 0, 0, 0];
      bin[0] += d[i]; bin[1] += d[i + 1]; bin[2] += d[i + 2]; bin[3]++;
      bins.set(key, bin);
      n++;
    }
  }
  let top: [number, number, number, number] = [136, 136, 136, 1];
  for (const bin of bins.values()) if (bin[3] > top[3]) top = bin;
  const sum = [top[0] / top[3], top[1] / top[3], top[2] / top[3]];
  g.putImageData(img, 0, 0);
  if (n === 0) return { canvas: c, color: '#888888' };

  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  const hex = sum.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { canvas: out, color: `#${hex}` };
}

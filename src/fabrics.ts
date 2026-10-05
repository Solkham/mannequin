// Ткани и принты, нарисованные кодом: повторяющиеся плитки и нашивка на грудь.
// Плитка — RGBA: rgb рисунка поверх цвета вещи с прозрачностью a (0 — чистый цвет вещи).

import * as THREE from 'three';
import type { Fabric } from './sizing.ts';

/** Размер плитки на теле, м. */
const TILE: Record<Fabric, number> = { plain: 1, knit: 0.012, denim: 0.02, quilt: 0.13, floral: 0.09, stripes: 0.034, plaid: 0.11, oxford: 0.008 };

const cache = new Map<Fabric, { texture: THREE.Texture; tile: number }>();

export function fabricTexture(fabric: Fabric): { texture: THREE.Texture; tile: number } {
  let hit = cache.get(fabric);
  if (!hit) {
    const canvas = drawFabric(fabric);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    hit = { texture, tile: TILE[fabric] };
    cache.set(fabric, hit);
  }
  return hit;
}

/**
 * Рельеф плетения: серая плитка высот, из неё шейдер делает нормали (bump), а
 * поверхность — блеск или лак. Масштаб свой: даже у гладкой ткани есть нить.
 */
export interface Finish {
  relief: THREE.Texture;
  /** Размер плитки рельефа на теле, м. */
  tile: number;
  /** Глубина рельефа, м: высота нити или подушки стёжки. */
  depth: number;
  roughness: number;
  /** Ворс/блеск трикотажа и вискозы (sheen), 0 — нет. */
  sheen: number;
  /** Лак пуховика (clearcoat), 0 — нет. */
  clearcoat: number;
}

const FINISH: Record<Fabric, Omit<Finish, 'relief'>> = {
  plain: { tile: 0.006, depth: 0.0002, roughness: 0.85, sheen: 0.15, clearcoat: 0 },
  knit: { tile: 0.012, depth: 0.0006, roughness: 0.9, sheen: 0.45, clearcoat: 0 },
  stripes: { tile: 0.008, depth: 0.0004, roughness: 0.88, sheen: 0.35, clearcoat: 0 },
  denim: { tile: 0.01, depth: 0.0005, roughness: 0.96, sheen: 0, clearcoat: 0 },
  quilt: { tile: 0.13, depth: 0.004, roughness: 0.55, sheen: 0, clearcoat: 0.3 },
  floral: { tile: 0.006, depth: 0.00015, roughness: 0.62, sheen: 0.5, clearcoat: 0 },
  plaid: { tile: 0.01, depth: 0.0004, roughness: 0.9, sheen: 0.25, clearcoat: 0 },
  oxford: { tile: 0.008, depth: 0.0004, roughness: 0.82, sheen: 0.1, clearcoat: 0 },
};

const finishes = new Map<Fabric, Finish>();

export function fabricFinish(fabric: Fabric): Finish {
  let hit = finishes.get(fabric);
  if (!hit) {
    const relief = new THREE.CanvasTexture(drawRelief(fabric));
    relief.wrapS = relief.wrapT = THREE.RepeatWrapping;
    relief.anisotropy = 4;
    hit = { relief, ...FINISH[fabric] };
    finishes.set(fabric, hit);
  }
  return hit;
}

/** Высота нити в точке плитки (u, v ∈ [0, 1)) по типу плетения. */
function drawRelief(fabric: Fabric): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const rand = rng(11 + fabric.length);
  const jitter = new Float32Array(S * S).map(() => rand());
  const TAU = Math.PI * 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let h: number;
      if (fabric === 'knit' || fabric === 'stripes') {
        // Трикотаж: столбики петель-«ёлочек».
        const n = fabric === 'knit' ? 8 : 6;
        const cu = (u * n) % 1, cv = (v * n * 1.4) % 1;
        h = Math.sin(Math.PI * cu) * (0.7 + 0.3 * Math.sin(TAU * (cv + Math.abs(cu - 0.5))));
      } else if (fabric === 'denim' || fabric === 'plaid') {
        // Саржа: косые рубчики.
        const n = fabric === 'denim' ? 10 : 7;
        h = 0.5 + 0.5 * Math.sin(TAU * n * (u + v));
      } else if (fabric === 'quilt') {
        // Секция пуховика: подушка между швами.
        h = Math.pow(Math.sin(Math.PI * v), 0.5);
      } else if (fabric === 'oxford') {
        // Рогожка: пары нитей в шахматку.
        const n = 8;
        const cu = (u * n) % 1, cv = (v * n) % 1;
        const odd = (Math.floor(u * n) + Math.floor(v * n)) % 2;
        h = odd ? Math.sin(Math.PI * cu) : Math.sin(Math.PI * cv);
      } else {
        // Полотно: нити вверх-вниз через одну.
        const n = 8;
        const odd = (Math.floor(u * n) + Math.floor(v * n)) % 2;
        h = 0.5 + 0.5 * (odd ? Math.sin(Math.PI * ((u * n) % 1)) : Math.sin(Math.PI * ((v * n) % 1)));
      }
      // Неровность нити; у стёжки пуховика поверхность гладкая.
      if (fabric !== 'quilt') h = h * 0.88 + jitter[y * S + x] * 0.12;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * Math.min(1, Math.max(0, h)));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Детерминированный шум: одинаковая ткань при каждой загрузке. */
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function drawFabric(fabric: Fabric): HTMLCanvasElement {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rand = rng(7 + fabric.length);

  if (fabric === 'knit') {
    // Петли трикотажа: вертикальные рубчики и лёгкая неровность.
    for (let x = 0; x < S; x += 8) {
      g.fillStyle = 'rgba(0,0,0,0.10)';
      g.fillRect(x, 0, 2, S);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(x + 4, 0, 2, S);
    }
    noise(g, S, rand, 0.05);
  } else if (fabric === 'denim') {
    // Саржевое плетение: светлые диагонали и тёмный шум.
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 3;
    for (let i = -S; i < S * 2; i += 9) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + S, S);
      g.stroke();
    }
    noise(g, S, rand, 0.12);
  } else if (fabric === 'quilt') {
    // Стёжка пуховика: шов и объём секции (темнее у шва, светлее посередине).
    const grad = g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, 'rgba(0,0,0,0.22)');
    grad.addColorStop(0.15, 'rgba(0,0,0,0.04)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    grad.addColorStop(0.85, 'rgba(0,0,0,0.04)');
    grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(0, 0, S, 2);
  } else if (fabric === 'floral') {
    // Мелкий цветочный принт: цветы поверх цвета платья.
    const petals = ['#f6e7d8', '#f2c4c9', '#fff6e5'];
    for (let i = 0; i < 9; i++) {
      const x = rand() * S, y = rand() * S, r = 9 + rand() * 7;
      for (const [dx, dy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) flower(g, x + dx, y + dy, r, petals[i % 3], rand() * Math.PI);
    }
    g.fillStyle = 'rgba(70,110,60,0.75)';
    for (let i = 0; i < 26; i++) {
      g.beginPath();
      g.ellipse(rand() * S, rand() * S, 4, 1.8, rand() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  } else if (fabric === 'stripes') {
    // Полоска: белые полосы поверх цвета вещи, цвет вещи — тёмная полоса.
    g.fillStyle = 'rgba(248,246,240,0.96)';
    g.fillRect(0, S * 0.45, S, S * 0.55);
    noise(g, S, rand, 0.04);
  } else if (fabric === 'plaid') {
    // Клетка (тартан): тёмные широкие полосы вдоль и поперёк, светлые тонкие нити.
    for (const [pos, w, col] of [
      [0.0, 0.28, 'rgba(0,0,0,0.32)'], [0.5, 0.12, 'rgba(0,0,0,0.22)'],
      [0.36, 0.03, 'rgba(255,240,200,0.55)'], [0.78, 0.02, 'rgba(255,255,255,0.35)'],
    ] as [number, number, string][]) {
      g.fillStyle = col;
      g.fillRect(pos * S, 0, w * S, S);
      g.fillRect(0, pos * S, S, w * S);
    }
    noise(g, S, rand, 0.06);
  } else if (fabric === 'oxford') {
    // Оксфорд: рогожка — мелкая шахматка светлых и тёмных нитей.
    for (let y = 0; y < S; y += 4) {
      for (let x = (y / 4) % 2 ? 0 : 4; x < S; x += 8) {
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x, y, 4, 4);
      }
    }
    noise(g, S, rand, 0.05);
  }
  return c;
}

function noise(g: CanvasRenderingContext2D, S: number, rand: () => number, k: number): void {
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rand() > 0.5 ? `rgba(0,0,0,${k * rand()})` : `rgba(255,255,255,${k * rand()})`;
    g.fillRect(rand() * S, rand() * S, 2, 2);
  }
}

function flower(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, rot: number): void {
  g.fillStyle = color;
  for (let p = 0; p < 5; p++) {
    const a = rot + (p * Math.PI * 2) / 5;
    g.beginPath();
    g.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.5, r * 0.32, a, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#e2b13c';
  g.beginPath();
  g.arc(x, y, r * 0.22, 0, Math.PI * 2);
  g.fill();
}

/** Планка рубашки: строчки по краям и пуговицы. Высокая узкая картинка на центр переда. */
export function placketPrint(shirtColor: string): HTMLCanvasElement {
  const W = 64, H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const light = parseInt(shirtColor.slice(1, 3), 16) + parseInt(shirtColor.slice(3, 5), 16) + parseInt(shirtColor.slice(5, 7), 16) > 600;
  // Край планки и строчка.
  g.fillStyle = light ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.2)';
  g.fillRect(W * 0.16, 0, 2, H);
  g.fillRect(W * 0.82, 0, 2, H);
  // Пуговицы: перламутровые, с тенью и двумя дырочками.
  for (let i = 0; i < 7; i++) {
    const y = H * (0.06 + i * 0.135);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.arc(W / 2 + 1.5, y + 2, W * 0.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f3f0e8';
    g.beginPath();
    g.arc(W / 2, y, W * 0.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(80,70,60,0.6)';
    for (const dx of [-3, 3]) {
      g.beginPath();
      g.arc(W / 2 + dx, y, 1.8, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

/** Нашивка-принт на грудь худи. */
export function badgePrint(ink = '#f4efe6'): HTMLCanvasElement {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineWidth = 14;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  g.stroke();
  // Солнце над горами
  g.beginPath();
  g.arc(S / 2, S * 0.47, S * 0.11, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(S * 0.18, S * 0.66);
  g.lineTo(S * 0.38, S * 0.45);
  g.lineTo(S * 0.5, S * 0.58);
  g.lineTo(S * 0.64, S * 0.4);
  g.lineTo(S * 0.82, S * 0.66);
  g.closePath();
  g.fill();
  g.font = `700 ${S * 0.085}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('МАНЕКЕН', S / 2, S * 0.78);
  return c;
}

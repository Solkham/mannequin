// Математика манекена без Three.js: смешивание морфов, замеры и подбор влияний
// морфов под введённые параметры фигуры. Работает и в браузере, и в node-тестах.

export type Gender = 'male' | 'female';
export type Ring = 'chest' | 'waist' | 'hips';
export const RINGS: Ring[] = ['chest', 'waist', 'hips'];

/** Что вводит человек: см и кг. */
export interface Figure {
  height: number;
  weight: number;
  chest: number;
  waist: number;
  hips: number;
}

/** Знаковое влияние морфа по каждой оси: >0 это *_up, <0 это *_down. */
export interface Shape {
  height: number;
  weight: number;
  chest: number;
  waist: number;
  hips: number;
}
type Axis = keyof Shape;
const AXES: Axis[] = ['height', 'weight', 'chest', 'waist', 'hips'];

/** Что получилось на манекене: см и кг, плюс точки обхватов для отрисовки. */
export interface Measures extends Figure {
  minY: number;
  hulls: Record<Ring, { y: number; points: [number, number][] }>;
}

export interface BodyData {
  base: Float32Array;
  /** Дельты морфов в порядке names (как morphAttributes.position у glTF). */
  deltas: Float32Array[];
  names: string[];
  index: ArrayLike<number>;
  rings: Record<Ring, number[]>;
  density: number;
}

export interface Fit {
  shape: Shape;
  scale: number;
  influences: Float32Array;
  measures: Measures;
}

// Насколько далеко разрешаем уходить за пределы диапазона Anny.
// Вес и обхваты экстраполируем: у Anny полнота ограничена, а нам важен плюс-сайз.
const BOUNDS: Record<Axis, [number, number]> = {
  height: [-1, 1],
  weight: [-1.2, 3],
  chest: [-1.2, 2.5],
  waist: [-1.2, 3],
  hips: [-1.5, 2.5],
};

export const ZERO_SHAPE: Shape = { height: 0, weight: 0, chest: 0, waist: 0, hips: 0 };

export class BodyModel {
  readonly data: BodyData;
  private readonly slots: { up: number; down: number }[];
  private readonly pos: Float32Array;
  readonly influences: Float32Array;
  /** См обхвата на единицу влияния морфа (при масштабе 1), отдельно вверх и вниз. */
  private readonly slopes: Record<Ring, { up: number; down: number }>;

  constructor(data: BodyData) {
    this.data = data;
    this.slots = AXES.map((axis) => ({
      up: data.names.indexOf(`${axis}_up`),
      down: data.names.indexOf(`${axis}_down`),
    }));
    this.slots.forEach((s, i) => {
      if (s.up < 0 || s.down < 0) throw new Error(`В модели нет морфов ${AXES[i]}_up/_down`);
    });
    this.pos = new Float32Array(data.base.length);
    this.influences = new Float32Array(data.names.length);

    const base = this.measure(ZERO_SHAPE);
    this.slopes = {} as BodyModel['slopes'];
    for (const r of RINGS) {
      const up = this.measure({ ...ZERO_SHAPE, [r]: 1 })[r] - base[r];
      const down = base[r] - this.measure({ ...ZERO_SHAPE, [r]: -1 })[r];
      this.slopes[r] = { up, down };
    }
  }

  /** Влияния морфов для Three.js (mesh.morphTargetInfluences). */
  toInfluences(shape: Shape, out: Float32Array = new Float32Array(this.data.names.length)): Float32Array {
    out.fill(0);
    AXES.forEach((axis, i) => {
      const v = shape[axis];
      if (v > 0) out[this.slots[i].up] = v;
      else out[this.slots[i].down] = -v;
    });
    return out;
  }

  /** Положения вершин без масштаба. Возвращает внутренний буфер. */
  blend(shape: Shape): Float32Array {
    const { base, deltas } = this.data;
    const w = this.toInfluences(shape, this.influences);
    const p = this.pos;
    p.set(base);
    for (let t = 0; t < deltas.length; t++) {
      const k = w[t];
      if (k === 0) continue;
      const d = deltas[t];
      for (let i = 0; i < p.length; i++) p[i] += k * d[i];
    }
    return p;
  }

  measure(shape: Shape, scale = 1): Measures {
    const p = this.blend(shape);
    const { index, rings, density } = this.data;

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < p.length; i += 3) {
      if (p[i] < minY) minY = p[i];
      if (p[i] > maxY) maxY = p[i];
    }

    let vol = 0;
    for (let f = 0; f < index.length; f += 3) {
      const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    vol = Math.abs(vol) / 6;

    const hulls = {} as Measures['hulls'];
    const perim = {} as Record<Ring, number>;
    for (const r of RINGS) {
      const ids = rings[r];
      const pts: [number, number][] = new Array(ids.length);
      let y = 0;
      for (let j = 0; j < ids.length; j++) {
        const i = ids[j] * 3;
        pts[j] = [p[i], p[i + 2]];
        y += p[i + 1];
      }
      const hull = convexHull(pts);
      hulls[r] = { y: (y / ids.length - minY) * scale, points: hull.map(([x, z]) => [x * scale, z * scale]) };
      perim[r] = perimeter(hull) * scale * 100;
    }

    return {
      height: (maxY - minY) * scale * 100,
      weight: vol * scale ** 3 * density,
      chest: perim.chest,
      waist: perim.waist,
      hips: perim.hips,
      minY: minY * scale,
      hulls,
    };
  }

  /** Подбирает форму и масштаб под фигуру. start — прошлое решение, чтобы ползунок шёл плавно. */
  fit(target: Figure, start: Shape = ZERO_SHAPE): Fit {
    const shape: Shape = { ...start };

    // 1. Рост: морф роста почти линеен, хватает пары шагов секущей. Остаток добирает масштаб.
    const heightAt = (h: number) => this.measure({ ...shape, height: h }).height;
    for (let it = 0; it < 3; it++) {
      const h0 = shape.height;
      const f0 = heightAt(h0) - target.height;
      if (Math.abs(f0) < 0.05) break;
      const step = h0 >= 0 ? 0.05 : -0.05;
      const slope = (heightAt(h0 + step) - heightAt(h0)) / step;
      shape.height = clamp(h0 - f0 / slope, ...BOUNDS.height);
    }
    const scale = target.height / heightAt(shape.height);

    // 2. Вес: бисекция по морфу веса. Для каждого веса обхваты подгоняются своими морфами
    // (fitRings). Обхваты важнее веса: если при этом весе обхваты не достать, вес сдвигаем.
    let [lo, hi] = BOUNDS.weight;
    let best: { shape: Shape; err: number } | null = null;
    for (let it = 0; it < 12; it++) {
      shape.weight = it === 0 ? clamp(start.weight, lo, hi) : (lo + hi) / 2;
      const { measures: m, tooBig, tooSmall } = this.fitRings(shape, target, scale);
      const ringErr = Math.max(...RINGS.map((r) => Math.abs(m[r] - target[r])));
      const massErr = m.weight - target.weight;
      const err = ringErr * 10 + Math.abs(massErr);
      if (!best || err < best.err) best = { shape: { ...shape }, err };
      if (tooBig && !tooSmall) hi = shape.weight;
      else if (tooSmall && !tooBig) lo = shape.weight;
      else if (Math.abs(massErr) < 0.3) break;
      else if (massErr > 0) hi = shape.weight;
      else lo = shape.weight;
      if (hi - lo < 0.01) break;
    }
    Object.assign(shape, best!.shape);

    const measures = this.measure(shape, scale);
    return { shape, scale, influences: this.toInfluences(shape), measures };
  }
  /** Подгоняет морфы груди, талии и бёдер при заданном весе. Меняет shape. */
  private fitRings(shape: Shape, target: Figure, scale: number) {
    let m = this.measure(shape, scale);
    let tooBig = false;
    let tooSmall = false;
    for (let it = 0; it < 5; it++) {
      tooBig = tooSmall = false;
      let done = true;
      for (const r of RINGS) {
        const err = m[r] - target[r];
        if (Math.abs(err) > 0.05) done = false;
        const [lo, hi] = BOUNDS[r];
        const slope = (shape[r] > 0 || (shape[r] === 0 && err < 0) ? this.slopes[r].up : this.slopes[r].down) * scale;
        const next = clamp(shape[r] - err / slope, lo, hi);
        if (next === lo && err > 0.5) tooBig = true;
        if (next === hi && err < -0.5) tooSmall = true;
        shape[r] = next;
      }
      if (done) break;
      m = this.measure(shape, scale);
    }
    return { measures: m, tooBig, tooSmall };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Пояса для подсветки зон: для каждой вершины вес 0..1, насколько она в поясе груди,
 * талии или бёдер. Считается один раз по базовой сетке: морфы двигают вершины,
 * но принадлежность к поясу не меняют. Руки отсекаются: в пояс попадает только то,
 * что внутри обхвата торса (выпуклой оболочки кольца) плюс запас.
 */
export function zoneWeights(data: Pick<BodyData, 'base' | 'rings'>): Record<Ring, Float32Array> {
  const p = data.base;
  const n = p.length / 3;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    minY = Math.min(minY, p[i]);
    maxY = Math.max(maxY, p[i]);
  }
  const half = (maxY - minY) * 0.03; // полуширина пояса: ~5 см у человека 170 см
  const margin = 0.012;

  const out = {} as Record<Ring, Float32Array>;
  for (const r of RINGS) {
    const ids = data.rings[r];
    let level = 0;
    for (const i of ids) level += p[i * 3 + 1];
    level /= ids.length;
    const hull = convexHull(ids.map((i) => [p[i * 3], p[i * 3 + 2]] as [number, number]));
    const edges = hull.map(([ax, az], k) => {
      const [bx, bz] = hull[(k + 1) % hull.length];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      return [ax, az, (bx - ax) / len, (bz - az) / len];
    });

    const w = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const dy = Math.abs(p[v * 3 + 1] - level);
      if (dy >= half) continue;
      const x = p[v * 3], z = p[v * 3 + 2];
      let inside = true;
      for (const [ax, az, ex, ez] of edges) {
        // Оболочка обходится против часовой: внутри cross >= 0.
        if (ex * (z - az) - ez * (x - ax) < -margin) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      const t = dy / half;
      w[v] = 1 - t * t * (3 - 2 * t); // мягкий край пояса
    }
    out[r] = w;
  }
  return out;
}

/** Выпуклая оболочка (монотонная цепь Эндрю): так ложится сантиметровая лента. */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function perimeter(hull: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, z1] = hull[i];
    const [x2, z2] = hull[(i + 1) % hull.length];
    s += Math.hypot(x2 - x1, z2 - z1);
  }
  return s;
}

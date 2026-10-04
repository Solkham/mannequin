// Симуляция ткани для юбки: частицы на кольцах, связи-«нитки» (Position Based Dynamics).
// Нитки почти не тянутся, но легко сминаются: лишняя ширина подола под тяжестью
// собирается в складки. Ткань отталкивается от тела (капсулы ног и таза), пола и сиденья.
// Без Three.js: проверяется в tests/cloth.test.ts.

export type Vec3 = [number, number, number];

/** Капсула-конус: радиус r у конца a, r2 у конца b (по умолчанию как r). */
export interface Capsule {
  a: Vec3;
  b: Vec3;
  r: number;
  r2?: number;
}

export interface ClothEnv {
  /** Ускорение тяжести в осях манекена, м/с². */
  gravity: Vec3;
  capsules: Capsule[];
  /** Плоскости n·p >= c (пол). */
  planes: { n: Vec3; c: number }[];
  /** Круглые сиденья: верх в точке center, нормаль up, радиус r. */
  disks: { center: Vec3; up: Vec3; r: number }[];
  /** Настоящий профиль тела под поясом (таз и верх бёдер): ткань не уходит внутрь. */
  profile?: Profile;
}

/**
 * Профиль тела: для rows высот (от y0 вниз с шагом dy) и cols углов — расстояние
 * от центра (cx, cz) до кожи. Задан в осях покоя таза; toLocal/fromLocal — матрицы
 * 4×4 (по столбцам, как в Three.js) из осей ткани в оси покоя и обратно.
 */
export interface Profile {
  toLocal: ArrayLike<number>;
  fromLocal: ArrayLike<number>;
  y0: number;
  dy: number;
  rows: number;
  cols: number;
  cx: number;
  cz: number;
  radii: Float32Array;
}

export interface SkirtDesign {
  rows: number;
  cols: number;
  /** Верхнее кольцо (cols точек, x y z подряд) — пришито к поясу. */
  top: Float32Array;
  /** Центр верхнего кольца. */
  center: Vec3;
  /** Длина юбки по ткани, м. */
  length: number;
  /** Во сколько раз подол шире пояса по окружности (А-силуэт, клёш). */
  flare: number;
  /** Насколько ткань сопротивляется сжатию (0 — мнётся как шифон, 1 — держит форму). */
  stiffness: number;
  /** Сколько крупных складок заложено в крое (направляет, куда сминаться). */
  folds: number;
}

const ITER = 10;
const DAMP = 0.985;
// Зазор до тела: частицы стоят редко, и треугольники между ними не должны задевать кожу.
const MARGIN = 0.01;

export class Cloth {
  readonly rows: number;
  readonly cols: number;
  /** Текущие положения частиц (rows+1)×cols, x y z подряд. */
  readonly pos: Float32Array;
  /** Форма кроя без складок: по ней ложится рисунок ткани. */
  readonly rest: Float32Array;
  private readonly prev: Float32Array;
  private readonly pins: Float32Array;
  private cA = new Int32Array(0);
  private cB = new Int32Array(0);
  private cLen = new Float32Array(0);
  private cStretch = new Float32Array(0);
  private cCompress = new Float32Array(0);
  /** Длина ткани от пояса до каждой частицы по крою: дальше нитка не пустит. */
  private reach = new Float32Array(0);

  constructor(design: SkirtDesign) {
    this.rows = design.rows;
    this.cols = design.cols;
    const n = (this.rows + 1) * this.cols * 3;
    this.pos = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.rest = new Float32Array(n);
    this.pins = new Float32Array(this.cols * 3);
    this.setDesign(design, true);
  }

  /**
   * Новый крой (фигура или размер поменялись). reset=true — разложить ткань заново
   * и дать ей осесть; иначе ткань продолжает висеть, меняются только длины ниток.
   */
  setDesign(d: SkirtDesign, reset: boolean, env?: ClothEnv): void {
    const { rows, cols } = this;
    const [cx, , cz] = d.center;
    const dy = d.length / rows;

    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const grow = 1 + (d.flare - 1) * t;
      for (let i = 0; i < cols; i++) {
        const j = (k * cols + i) * 3;
        const tx = d.top[i * 3] - cx;
        const tz = d.top[i * 3 + 2] - cz;
        const a = Math.atan2(tz, tx);
        // Заложенные складки: ткань слегка волнится уже в крое, чтобы смяться красиво.
        const wave = 1 + 0.06 * t * Math.sin(a * d.folds + 0.7 * Math.sin(a * 3));
        this.rest[j] = cx + tx * grow * wave;
        this.rest[j + 1] = d.top[i * 3 + 1] - dy * k;
        this.rest[j + 2] = cz + tz * grow * wave;
      }
    }
    this.pins.set(d.top);

    // Нитки: по кольцу (с запасом ткани), вдоль (по длине), диагонали, через одну (изгиб).
    const A: number[] = [], B: number[] = [], S: number[] = [], C: number[] = [];
    const add = (a: number, b: number, stretch: number, compress: number) => {
      A.push(a); B.push(b); S.push(stretch); C.push(compress);
    };
    const id = (k: number, i: number) => k * cols + ((i + cols) % cols);
    const comp = 0.02 + 0.5 * d.stiffness;
    for (let k = 0; k <= rows; k++) {
      for (let i = 0; i < cols; i++) {
        add(id(k, i), id(k, i + 1), 1, comp);
        add(id(k, i), id(k, i + 2), 0.15 + 0.4 * d.stiffness, 0.04 + 0.3 * d.stiffness);
        if (k < rows) {
          add(id(k, i), id(k + 1, i), 1, 1);
          add(id(k, i), id(k + 1, i + 1), 0.7, 0.2);
          add(id(k, i + 1), id(k + 1, i), 0.7, 0.2);
        }
        if (k < rows - 1) add(id(k, i), id(k + 2, i), 0.3, 0.3 + 0.5 * d.stiffness);
      }
    }
    this.cA = Int32Array.from(A);
    this.cB = Int32Array.from(B);
    this.cStretch = Float32Array.from(S);
    this.cCompress = Float32Array.from(C);
    this.cLen = new Float32Array(A.length);
    const r = this.rest;
    for (let c = 0; c < A.length; c++) {
      const a = A[c] * 3, b = B[c] * 3;
      this.cLen[c] = Math.hypot(r[b] - r[a], r[b + 1] - r[a + 1], r[b + 2] - r[a + 2]);
    }

    this.reach = new Float32Array((rows + 1) * cols);
    for (let k = 1; k <= rows; k++) {
      for (let i = 0; i < cols; i++) {
        const a = ((k - 1) * cols + i) * 3, b = (k * cols + i) * 3;
        this.reach[k * cols + i] = this.reach[(k - 1) * cols + i] + Math.hypot(r[b] - r[a], r[b + 1] - r[a + 1], r[b + 2] - r[a + 2]);
      }
    }

    if (reset) {
      this.pos.set(this.rest);
      this.prev.set(this.rest);
      if (env) for (let s = 0; s < 120; s++) this.step(1 / 60, env);
    }
  }

  /** Остановить ткань в текущем положении и дать ей осесть steps шагов. */
  settle(env: ClothEnv, steps: number): void {
    this.prev.set(this.pos);
    this.pins.set(this.pos.subarray(0, this.cols * 3));
    for (let s = 0; s < steps; s++) this.step(1 / 60, env);
  }

  /** Пояс пришит: верхнее кольцо идёт за телом (позы, ходьба). Возвращает, на сколько он сдвинулся, м. */
  setPins(top: Float32Array): number {
    let moved = 0;
    for (let i = 0; i < top.length; i++) moved = Math.max(moved, Math.abs(top[i] - this.pins[i]));
    this.pins.set(top);
    return moved;
  }

  /** Сколько проходов по ниткам за шаг: меньше — быстрее, но ткань тянется сильнее. */
  iterations = ITER;

  /** Самый большой сдвиг частицы за последний шаг, м: по нему видно, что ткань осела. */
  lastMotion = Infinity;

  step(dt: number, env: ClothEnv): void {
    const p = this.pos, q = this.prev;
    const cols3 = this.cols * 3;
    const [gx, gy, gz] = env.gravity;
    const g2 = dt * dt;

    for (let i = cols3; i < p.length; i += 3) {
      const vx = (p[i] - q[i]) * DAMP, vy = (p[i + 1] - q[i + 1]) * DAMP, vz = (p[i + 2] - q[i + 2]) * DAMP;
      q[i] = p[i]; q[i + 1] = p[i + 1]; q[i + 2] = p[i + 2];
      p[i] += vx + gx * g2;
      p[i + 1] += vy + gy * g2;
      p[i + 2] += vz + gz * g2;
    }
    for (let i = 0; i < cols3; i++) {
      q[i] = p[i];
      p[i] = this.pins[i];
    }

    const { cA, cB, cLen, cStretch, cCompress } = this;
    const pinned = this.cols;
    const iters = this.iterations;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < cA.length; c++) {
        const ia = cA[c], ib = cB[c];
        const a = ia * 3, b = ib * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        const diff = (len - cLen[c]) / len;
        const k = diff > 0 ? cStretch[c] : cCompress[c];
        const wa = ia < pinned ? 0 : 1, wb = ib < pinned ? 0 : 1;
        const w = wa + wb;
        if (w === 0) continue;
        const s = (diff * k) / w;
        p[a] += dx * s * wa; p[a + 1] += dy * s * wa; p[a + 2] += dz * s * wa;
        p[b] -= dx * s * wb; p[b + 1] -= dy * s * wb; p[b + 2] -= dz * s * wb;
      }
      if (it % 3 === 2 || it === iters - 1) {
        this.limitReach();
        this.collide(env);
      }
    }
    this.measureMotion();
  }

  /** Посчитать, насколько ткань сдвинулась за шаг (вызывается в конце step). */
  private measureMotion(): void {
    const p = this.pos, q = this.prev;
    let m = 0;
    for (let i = this.cols * 3; i < p.length; i++) {
      const d = Math.abs(p[i] - q[i]);
      if (d > m) m = d;
    }
    this.lastMotion = m;
  }

  /** Ткань не растягивается: частица не дальше от пояса, чем длина ткани до неё. */
  private limitReach(): void {
    const p = this.pos, cols = this.cols;
    for (let v = cols; v < p.length / 3; v++) {
      const pin = (v % cols) * 3, i = v * 3;
      const dx = p[i] - p[pin], dy = p[i + 1] - p[pin + 1], dz = p[i + 2] - p[pin + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const max = this.reach[v] * 1.01;
      if (d > max) {
        const s = max / d;
        p[i] = p[pin] + dx * s; p[i + 1] = p[pin + 1] + dy * s; p[i + 2] = p[pin + 2] + dz * s;
      }
    }
  }

  private collide(env: ClothEnv): void {
    const p = this.pos, q = this.prev;
    for (let i = this.cols * 3; i < p.length; i += 3) {
      let x = p[i], y = p[i + 1], z = p[i + 2];
      let hit = false;
      for (const cap of env.capsules) {
        const [ax, ay, az] = cap.a;
        const ex = cap.b[0] - ax, ey = cap.b[1] - ay, ez = cap.b[2] - az;
        const ee = ex * ex + ey * ey + ez * ez || 1e-9;
        const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / ee));
        const cx = ax + ex * t, cy = ay + ey * t, cz = az + ez * t;
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const r = cap.r + ((cap.r2 ?? cap.r) - cap.r) * t + MARGIN;
        if (d < r && d > 1e-6) {
          const s = r / d;
          x = cx + dx * s; y = cy + dy * s; z = cz + dz * s;
          hit = true;
        }
      }
      for (const pl of env.planes) {
        const d = pl.n[0] * x + pl.n[1] * y + pl.n[2] * z - pl.c - MARGIN;
        if (d < 0) {
          x -= pl.n[0] * d; y -= pl.n[1] * d; z -= pl.n[2] * d;
          hit = true;
        }
      }
      for (const disk of env.disks) {
        const [ux, uy, uz] = disk.up;
        const rx = x - disk.center[0], ry = y - disk.center[1], rz = z - disk.center[2];
        const h = rx * ux + ry * uy + rz * uz;
        if (h < MARGIN && h > -0.05) {
          const px = rx - ux * h, py = ry - uy * h, pz = rz - uz * h;
          if (px * px + py * py + pz * pz < disk.r * disk.r) {
            const push = MARGIN - h;
            x += ux * push; y += uy * push; z += uz * push;
            hit = true;
          }
        }
      }
      if (env.profile) {
        const pr = env.profile, m = pr.toLocal;
        const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
        const lz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const fy = (pr.y0 - ly) / pr.dy;
        if (fy >= 0 && fy <= pr.rows - 1) {
          const dx = lx - pr.cx, dz = lz - pr.cz;
          const d = Math.hypot(dx, dz);
          let fa = ((Math.atan2(dz, dx) / (Math.PI * 2)) * pr.cols + pr.cols) % pr.cols;
          const r0 = Math.floor(fy), r1 = Math.min(pr.rows - 1, r0 + 1), ty = fy - r0;
          const a0 = Math.floor(fa) % pr.cols, a1 = (a0 + 1) % pr.cols;
          fa -= Math.floor(fa);
          const R = pr.radii;
          const rad =
            (R[r0 * pr.cols + a0] * (1 - fa) + R[r0 * pr.cols + a1] * fa) * (1 - ty) +
            (R[r1 * pr.cols + a0] * (1 - fa) + R[r1 * pr.cols + a1] * fa) * ty + MARGIN;
          if (d < rad && d > 1e-6) {
            const s = rad / d;
            const nx = pr.cx + dx * s, nz = pr.cz + dz * s;
            const f = pr.fromLocal;
            x = f[0] * nx + f[4] * ly + f[8] * nz + f[12];
            y = f[1] * nx + f[5] * ly + f[9] * nz + f[13];
            z = f[2] * nx + f[6] * ly + f[10] * nz + f[14];
            hit = true;
          }
        }
      }
      if (hit) {
        p[i] = x; p[i + 1] = y; p[i + 2] = z;
        // Трение: о тело ткань почти не скользит.
        q[i] += (x - q[i]) * 0.5; q[i + 1] += (y - q[i + 1]) * 0.5; q[i + 2] += (z - q[i + 2]) * 0.5;
      }
    }
  }
}

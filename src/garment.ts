// Вещь на манекене: оболочка поверх тела на том же скелете (двигается в позах),
// юбка платья и низ куртки — симулируемая ткань, складки, ткань, цвет, принт или фото вещи.
//
// Форма вещи берётся из размерной сетки: насколько вещь больше тела в груди,
// талии и бёдрах (свобода облегания), на столько оболочка отходит от кожи.
//
// Складки двух видов:
// - юбка и низ пуховика — настоящая ткань (src/cloth.ts): мнётся под тяжестью, ложится на ноги;
// - облегающие части — расчётные складки: свободная вещь свисает складками от груди,
//   у манжет и щиколоток ткань собирается, на согнутых локтях, коленях и в паху —
//   гармошка, глубина которой меняется с позой каждый кадр (в шейдере).

import * as THREE from 'three';
import { convexHull, type Figure, type Ring } from './body.ts';
import type { Rig } from './rig.ts';
import type { Category, Fabric, SizeFit } from './sizing.ts';
import { fabricTexture } from './fabrics.ts';
import { Cloth, type Capsule, type ClothEnv, type Profile, type SkirtDesign, type Vec3 } from './cloth.ts';

/** Части тела из экспорта (anny-meta.json, partNames). */
const P = { torso: 0, neck: 1, head: 2, upperarm1: 3, upperarm2: 4, lowerarm: 5, hand: 6, upperleg: 7, lowerleg: 8, foot: 9 };

/** Конструктивная свобода: насколько вещь больше тела в середине своего размера, см. */
const DESIGN_EASE: Record<Category, Record<Ring, number>> = {
  top: { chest: 24, waist: 28, hips: 20 },
  tee: { chest: 10, waist: 12, hips: 10 },
  shirt: { chest: 12, waist: 14, hips: 12 },
  bottom: { chest: 0, waist: 1, hips: 3 },
  shorts: { chest: 0, waist: 1, hips: 5 },
  // А-силуэт: по талии в обтяжку, по бёдрам свободно.
  skirt: { chest: 0, waist: 1, hips: 10 },
  dress: { chest: 6, waist: 6, hips: 8 },
  // Зимняя куртка шьётся с запасом на свитер.
  outer: { chest: 26, waist: 30, hips: 22 },
};

/** Толщина ткани и свобода рукава/штанины, м. */
const BUILD: Record<Category, { thick: number; sleeve: number; leg: number; collar: number }> = {
  top: { thick: 0.004, sleeve: 0.022, leg: 0, collar: 0.012 },
  tee: { thick: 0.002, sleeve: 0.016, leg: 0, collar: 0.003 },
  // Воротник-стойка отходит от шеи.
  shirt: { thick: 0.0018, sleeve: 0.016, leg: 0, collar: 0.009 },
  bottom: { thick: 0.0025, sleeve: 0, leg: 0.012, collar: 0 },
  // Штанина шорт шире бедра.
  shorts: { thick: 0.0025, sleeve: 0, leg: 0.028, collar: 0 },
  skirt: { thick: 0.002, sleeve: 0, leg: 0.004, collar: 0 },
  dress: { thick: 0.0015, sleeve: 0.008, leg: 0, collar: 0 },
  outer: { thick: 0.014, sleeve: 0.03, leg: 0, collar: 0.022 },
};

/**
 * Как ткань висит и мнётся.
 * taper — насколько ткань может уходить внутрь на метр длины (0 — висит отвесно, 1 — облегает);
 * depth — какая доля свободного запаса уходит в глубину складок; folds — сколько складок по кругу;
 * rib — высота и запас резинки низа/манжеты (м), над ней ткань собирается напуском;
 * elbow/knee/hip — гармошка на сгибе (м, форма) и наклон заломов (освещение); stack — заломы над резинкой.
 */
const DRAPE: Record<Category, {
  torso: { taper: number; depth: number; folds: number; rib: [number, number] | null } | null;
  sleeve: { taper: number; depth: number; folds: number; rib: [number, number] | null } | null;
  leg: { taperAbove: number; taperBelow: number; depth: number; folds: number } | null;
  elbow: number; knee: number; hip: number;
  bump: [number, number, number];
  stack: number;
}> = {
  top: {
    torso: { taper: 0.08, depth: 0.6, folds: 11, rib: [0.05, 0.012] },
    sleeve: { taper: 0.45, depth: 0.5, folds: 4, rib: [0.06, 0.005] },
    leg: null, elbow: 0.009, knee: 0, hip: 0.008, bump: [0.55, 0, 0.35], stack: 0.45,
  },
  outer: {
    torso: { taper: 0.15, depth: 0.3, folds: 8, rib: null },
    sleeve: { taper: 0.35, depth: 0.3, folds: 3, rib: [0.05, 0.01] },
    leg: null, elbow: 0.012, knee: 0, hip: 0.01, bump: [0.45, 0, 0.3], stack: 0.35,
  },
  dress: {
    torso: { taper: 0.6, depth: 0.25, folds: 10, rib: null },
    sleeve: { taper: 1, depth: 0, folds: 0, rib: null },
    leg: null, elbow: 0, knee: 0, hip: 0.004, bump: [0, 0, 0.25], stack: 0,
  },
  bottom: {
    torso: null, sleeve: null,
    leg: { taperAbove: 1, taperBelow: 0.1, depth: 0.35, folds: 4 },
    elbow: 0, knee: 0.008, hip: 0.005, bump: [0, 0.6, 0.4], stack: 0.5,
  },
  tee: {
    torso: { taper: 0.3, depth: 0.35, folds: 9, rib: null },
    sleeve: { taper: 0.8, depth: 0.25, folds: 3, rib: null },
    leg: null, elbow: 0, knee: 0, hip: 0.006, bump: [0, 0, 0.3], stack: 0,
  },
  shirt: {
    torso: { taper: 0.2, depth: 0.45, folds: 9, rib: null },
    // Манжета рубашки: плотная, над ней рукав собирается.
    sleeve: { taper: 0.4, depth: 0.45, folds: 4, rib: [0.06, 0.008] },
    leg: null, elbow: 0.01, knee: 0, hip: 0.006, bump: [0.5, 0, 0.3], stack: 0.4,
  },
  shorts: {
    torso: null, sleeve: null,
    leg: { taperAbove: 1, taperBelow: 0.1, depth: 0.35, folds: 4 },
    elbow: 0, knee: 0, hip: 0.005, bump: [0, 0, 0.35], stack: 0.25,
  },
  skirt: {
    torso: null, sleeve: null, leg: null,
    elbow: 0, knee: 0, hip: 0.003, bump: [0, 0, 0.2], stack: 0,
  },
};

/** Где кончается верх вещи (доля роста от линии бёдер вниз). */
// Ниже 3% роста под линией бёдер начинается промежность: оболочка там обтянула бы каждое бедро отдельно.
const TORSO_HEM: Partial<Record<Category, number>> = { top: 0.012, tee: 0, shirt: 0.005, outer: 0.03, dress: 0.03 };

/**
 * Юбка: откуда висит (линия бёдер у платья и куртки, талия у юбки), подол (доля роста от пола),
 * расклёш по окружности, жёсткость ткани, заложенные складки.
 */
const SKIRT: Partial<Record<Category, { from: 'hips' | 'waist'; hem: number; flare: number; stiffness: number; folds: number }>> = {
  dress: { from: 'hips', hem: 0.2, flare: 1.45, stiffness: 0.04, folds: 9 },
  outer: { from: 'hips', hem: 0.36, flare: 1.04, stiffness: 1, folds: 4 },
  // Юбка до колена: шерсть плотнее вискозы, складки крупнее.
  skirt: { from: 'waist', hem: 0.29, flare: 1.6, stiffness: 0.12, folds: 8 },
};

const COLS = 96;
const ROWS = 22;

/** Где принт: нашивка на груди, вся передняя часть (фото), планка с пуговицами по центру. */
export type PrintRect = 'chest' | 'front' | 'placket';

export interface Look {
  color: string;
  fabric: Fabric;
  /** Принт спереди: картинка и где она на теле (центр x, y и ширина в м, в осях манекена). */
  print: { image: CanvasImageSource; rect: PrintRect } | null;
}

/** Что вокруг ткани в мире: пол и сиденье (в мировых координатах сцены). */
export interface Surroundings {
  floorY: number;
  seat: { center: THREE.Vector3; r: number } | null;
}

interface Levels {
  H: number;
  chest: number;
  waist: number;
  hips: number;
  neck: number;
  ankle: number;
  knee: number;
}

type Side = 'L' | 'R';

export class Garment {
  readonly category: Category;
  private readonly rig: Rig;
  private readonly parts: string;
  private readonly uniforms = {
    uColor: { value: new THREE.Color() },
    uFabric: { value: null as THREE.Texture | null },
    uFabricScale: { value: 30 },
    uPrint: { value: null as THREE.Texture | null },
    uPrintRect: { value: new THREE.Vector4(0, 1, 0.2, 0.2) },
    uHasPrint: { value: 0 },
    uTintOn: { value: 1 },
    uBend: { value: new THREE.Vector4() },
    uHip: { value: 0 },
    uFoldAmp: { value: new THREE.Vector3() },
    uBumpAmp: { value: new THREE.Vector3() },
    uStack: { value: 0 },
  };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly clothMaterial: THREE.MeshStandardMaterial;
  private shell: THREE.SkinnedMesh;
  private covered: Uint8Array;
  private levels: Levels | null = null;
  private printRect: PrintRect = 'chest';
  /** Вершины тела в покое при текущей форме: по ним рисунок и рамка принта. */
  private lastRest: Float32Array | null = null;

  /** Цилиндрические координаты вершин для складок: угол вокруг оси торса/руки/ноги и длина вдоль неё. */
  private theta: Float32Array;
  private along: Float32Array;
  /** Длина руки/ноги от плеча/бедра до кисти/стопы для вершины (0 — торс). */
  private limbLen: Float32Array;
  /** Трубка вершины: 0 — нет (воротник, плечи), 1 — торс, 2/3 — рука L/R, 4/5 — нога L/R. */
  private tube: Int8Array;

  private cloth: Cloth | null = null;
  private skirt: THREE.Mesh | null = null;
  /** Верхнее кольцо юбки в покое и кости, за которыми оно идёт (как ближайшая вершина лифа). */
  private skirtTop: Float32Array | null = null;
  private skirtSkin: { index: Uint16Array; weight: Float32Array } | null = null;
  private radii = { pelvis: 0.1, thighTop: 0.09, thighKnee: 0.06, shinTop: 0.05, shinAnkle: 0.035 };
  /** Профиль таза и верха бёдер под юбкой (в осях покоя). */
  private profile: Omit<Profile, 'toLocal' | 'fromLocal'> | null = null;
  private readonly restElbow = { L: 0, R: 0 };
  private readonly restKnee = { L: 0, R: 0 };

  constructor(rig: Rig, parts: string, category: Category) {
    this.rig = rig;
    this.parts = parts;
    this.category = category;
    this.material = this.makeMaterial(false);
    this.clothMaterial = this.makeMaterial(true);

    const body = rig.meshes[0];
    const src = body.geometry;
    const geo = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) geo.setAttribute(name, src.getAttribute(name));
    geo.morphAttributes.position = src.morphAttributes.position;
    geo.morphAttributes.normal = src.morphAttributes.normal;
    geo.morphTargetsRelative = true;
    const n = src.getAttribute('position').count;
    geo.setAttribute('aDisp', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aHem', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    geo.setAttribute('aNPert', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aJoint', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.covered = new Uint8Array(n);
    this.theta = new Float32Array(n);
    this.along = new Float32Array(n);
    this.limbLen = new Float32Array(n);
    this.tube = new Int8Array(n);
    this.shell = new THREE.SkinnedMesh(geo, this.material);
    this.shell.morphTargetInfluences = [...(body.morphTargetInfluences ?? [])];
    this.shell.morphTargetDictionary = body.morphTargetDictionary;
    this.shell.castShadow = true;
    rig.addMesh(this.shell);

    const f = DRAPE[category];
    this.uniforms.uFoldAmp.value.set(f.elbow, f.knee, f.hip);
    this.uniforms.uBumpAmp.value.set(...f.bump);
    this.uniforms.uStack.value = f.stack;
    for (const s of ['L', 'R'] as Side[]) {
      this.restElbow[s] = this.bendAngle(`upperarm01.${s}`, `lowerarm01.${s}`, `wrist.${s}`, true);
      this.restKnee[s] = this.bendAngle(`upperleg01.${s}`, `lowerleg01.${s}`, `foot.${s}`, true);
    }
  }

  dispose(): void {
    this.rig.removeMesh(this.shell);
    this.shell.geometry.dispose();
    if (this.skirt) {
      this.rig.group.remove(this.skirt);
      this.skirt.geometry.dispose();
    }
    this.material.dispose();
    this.clothMaterial.dispose();
  }

  setLook(look: Look): void {
    this.uniforms.uColor.value.set(look.color);
    const fab = fabricTexture(look.fabric);
    this.uniforms.uFabric.value = fab.texture;
    this.uniforms.uFabricScale.value = 1 / fab.tile;
    for (const m of [this.material, this.clothMaterial]) m.roughness = look.fabric === 'quilt' ? 0.45 : 0.85;
    const old = this.uniforms.uPrint.value;
    if (look.print) {
      const tex = new THREE.CanvasTexture(look.print.image as HTMLCanvasElement);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.uniforms.uPrint.value = tex;
      this.uniforms.uHasPrint.value = 1;
      this.printRect = look.print.rect;
    } else {
      this.uniforms.uPrint.value = null;
      this.uniforms.uHasPrint.value = 0;
    }
    old?.dispose();
    this.updatePrintRect();
  }

  setTintVisible(on: boolean): void {
    this.uniforms.uTintOn.value = on ? 1 : 0;
  }

  /**
   * Перестроить под фигуру и размер. rest — вершины тела в покое при текущей форме
   * (BodyModel.blend), body — введённые обхваты, size — оценка выбранного размера.
   */
  rebuild(
    rest: Float32Array,
    body: Figure,
    size: SizeFit,
    ringY: Record<Ring, number>,
    tints: Partial<Record<Ring, number>>,
    around: Surroundings,
  ): void {
    const L = this.measureLevels(rest, ringY);
    const firstTime = !this.levels;
    this.levels = L;
    this.lastRest = rest.slice();
    if (firstTime) {
      this.cover(rest, L);
      this.limbCoords(rest, L);
    }
    this.offsets(rest, L, body, size, tints);
    this.buildSkirt(rest, L, body, size, around);
    this.updatePrintRect();
  }

  /** Каждый кадр: глубина гармошек по сгибам и шаг симуляции юбки. */
  frame(dt: number, around: Surroundings): void {
    const u = this.uniforms;
    u.uBend.value.set(
      Math.max(0, this.bendAngle('upperarm01.L', 'lowerarm01.L', 'wrist.L') - this.restElbow.L),
      Math.max(0, this.bendAngle('upperarm01.R', 'lowerarm01.R', 'wrist.R') - this.restElbow.R),
      Math.max(0, this.bendAngle('upperleg01.L', 'lowerleg01.L', 'foot.L') - this.restKnee.L),
      Math.max(0, this.bendAngle('upperleg01.R', 'lowerleg01.R', 'foot.R') - this.restKnee.R),
    );
    u.uHip.value = (this.hipFlex('L') + this.hipFlex('R')) / 2;

    if (this.cloth && this.skirt && this.skirtTop) {
      this.cloth.setPins(this.posedTop());
      const env = this.env(around);
      const steps = Math.min(2, Math.max(1, Math.round(dt * 60)));
      for (let s = 0; s < steps; s++) this.cloth.step(1 / 60, env);
      const geo = this.skirt.geometry;
      geo.getAttribute('position').needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  /** Верхнее кольцо юбки в текущей позе: смешение костей ближайших вершин лифа (как в скиннинге). */
  private posedTop(): Float32Array {
    const top = this.skirtTop!;
    const out = new Float32Array(top.length);
    const skin = this.skirtSkin;
    const r = this.rig;
    if (!skin) {
      const m = r.boneDeform('root');
      const v = new THREE.Vector3();
      for (let i = 0; i < top.length; i += 3) v.fromArray(top, i).applyMatrix4(m).toArray(out, i);
      return out;
    }
    const mats = new Map<number, THREE.Matrix4>();
    const mat = (b: number) => {
      let m = mats.get(b);
      if (!m) {
        m = r.boneDeformAt(b);
        mats.set(b, m);
      }
      return m;
    };
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (let i = 0; i < top.length / 3; i++) {
      p.fromArray(top, i * 3);
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const w = skin.weight[i * 4 + k];
        if (!w) continue;
        q.copy(p).applyMatrix4(mat(skin.index[i * 4 + k]));
        x += q.x * w; y += q.y * w; z += q.z * w;
      }
      out.set([x, y, z], i * 3);
    }
    return out;
  }

  /**
   * Поза сменилась скачком: раскладываем ткань по новой позе (перёд юбки на бёдрах,
   * спинка с таза) и даём осесть. Иначе бёдра «прыгают» внутрь ткани и юбка соскальзывает.
   */
  drapeForPose(around: Surroundings): void {
    if (!this.cloth || !this.skirtTop) return;
    const r = this.rig;
    const mRoot = r.boneDeform('root');
    const mL = r.boneDeform('upperleg01.L');
    const mR = r.boneDeform('upperleg01.R');
    const cloth = this.cloth;
    const p = cloth.pos;
    const rest = cloth.rest;
    // Центр и ширина кроя на поясе.
    let cx = 0, cz = 0, half = 0;
    for (let i = 0; i < cloth.cols; i++) { cx += rest[i * 3]; cz += rest[i * 3 + 2]; }
    cx /= cloth.cols; cz /= cloth.cols;
    for (let i = 0; i < cloth.cols; i++) half = Math.max(half, Math.abs(rest[i * 3] - cx));
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), out = new THREE.Vector3();
    for (let k = 0; k <= cloth.rows; k++) {
      const t = k / cloth.rows;
      for (let i = 0; i < cloth.cols; i++) {
        const j = (k * cloth.cols + i) * 3;
        const x = rest[j], z = rest[j + 2];
        const front = THREE.MathUtils.clamp(0.5 + (z - cz) / (2 * half || 0.1), 0, 1);
        const legW = Math.min(0.95, t * 1.6) * (0.3 + 0.7 * front);
        const sideL = THREE.MathUtils.clamp(0.5 + (0.5 * (x - cx) * r.left) / (half * 0.6), 0, 1);
        a.fromArray(rest, j).applyMatrix4(mRoot).multiplyScalar(1 - legW);
        b.fromArray(rest, j).applyMatrix4(mL).multiplyScalar(legW * sideL);
        c.fromArray(rest, j).applyMatrix4(mR).multiplyScalar(legW * (1 - sideL));
        out.copy(a).add(b).add(c).toArray(p, j);
      }
    }
    cloth.settle(this.env(around), 60);
  }

  // ------------------------------------------------------------ сгибы

  /** Угол сгиба сустава между сегментами a→b и b→c (0 — прямая рука/нога). */
  private bendAngle(a: string, b: string, c: string, rest = false): number {
    const r = this.rig;
    const pa = rest ? r.head(a) : r.bonePos(a);
    const pb = rest ? r.head(b) : r.bonePos(b);
    const pc = rest ? r.head(c) : r.bonePos(c);
    const u = pb.clone().sub(pa).normalize();
    const w = pc.clone().sub(pb).normalize();
    return Math.acos(THREE.MathUtils.clamp(u.dot(w), -1, 1));
  }

  /** Насколько бедро поднято вперёд от положения покоя (сидя ~1.4 рад). */
  private hipFlex(side: Side): number {
    const r = this.rig;
    const now = r.bonePos(`lowerleg01.${side}`).sub(r.bonePos(`upperleg01.${side}`)).normalize();
    const rest = r.head(`lowerleg01.${side}`).sub(r.head(`upperleg01.${side}`)).normalize();
    return Math.acos(THREE.MathUtils.clamp(now.dot(rest), -1, 1));
  }

  // ------------------------------------------------------------ уровни и покрытие

  private measureLevels(rest: Float32Array, ringY: Record<Ring, number>): Levels {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < rest.length; i += 3) {
      minY = Math.min(minY, rest[i]);
      maxY = Math.max(maxY, rest[i]);
    }
    const r = this.rig;
    return {
      H: maxY - minY,
      chest: ringY.chest,
      waist: ringY.waist,
      hips: ringY.hips,
      neck: r.head('neck01').y,
      ankle: (r.head('foot.L').y + r.head('foot.R').y) / 2,
      knee: (r.head('lowerleg01.L').y + r.head('lowerleg01.R').y) / 2,
    };
  }

  /** Какие вершины тела закрывает вещь. Считается один раз: части тела от формы не зависят. */
  private cover(rest: Float32Array, L: Levels): void {
    const c = this.covered;
    for (let v = 0; v < c.length; v++) {
      const p = +this.parts[v];
      const y = rest[v * 3 + 1];
      const z = rest[v * 3 + 2];
      let on = false;
      // Бока таза в Anny принадлежат костям бедра, поэтому низ верха считаем по торсу и бедру вместе.
      const hipBand = p === P.torso || p === P.upperleg;
      const arm = p === P.upperarm1 || p === P.upperarm2 || p === P.lowerarm;
      const armS = arm ? this.armAlong(v, rest) : 0;
      const thighT = p === P.upperleg ? this.thighAlong(v, rest) : 0;
      switch (this.category) {
        case 'top':
          on = (hipBand && y >= L.hips - 0.012 * L.H) || arm || (p === P.neck && y < L.neck + 0.012 * L.H);
          break;
        case 'tee':
          // Короткий рукав — до середины плеча; круглый вырез у основания шеи.
          on = (hipBand && y >= L.hips) || (arm && armS < 0.45);
          break;
        case 'shirt':
          // Длинный рукав до запястья, низ навыпуск, воротник-стойка.
          on = (hipBand && y >= L.hips - 0.005 * L.H) || arm || (p === P.neck && y < L.neck + 0.035 * L.H);
          break;
        case 'outer':
          // Под юбкой-низом подкладка идёт по бёдрам: сидя бедро не протыкает ткань.
          on = (hipBand && y >= L.hips - 0.11 * L.H) || arm || (p === P.neck && y < L.neck + 0.03 * L.H);
          break;
        case 'bottom':
          on = (p === P.torso && y <= L.waist + 0.006 * L.H) || p === P.upperleg || (p === P.lowerleg && y >= L.ankle + 0.025 * L.H);
          break;
        case 'shorts':
          // Штанина до середины бедра.
          on = (p === P.torso && y <= L.waist + 0.006 * L.H) || (p === P.upperleg && thighT < 0.5);
          break;
        case 'skirt':
          // Пояс по талии, ниже — подкладка по тазу и бёдрам под юбкой (сидя бедро не протыкает ткань).
          on = (hipBand && y <= L.waist + 0.012 * L.H) || p === P.upperleg;
          break;
        case 'dress': {
          // U-образный вырез: спереди глубже и шире, чем сзади.
          const x = rest[v * 3];
          const front = z > 0;
          const inNeckline = front
            ? y > L.neck - 0.065 * L.H && Math.abs(x) < 0.055 * L.H * Math.min(1, (y - (L.neck - 0.065 * L.H)) / (0.03 * L.H) + 0.35)
            : y > L.neck - 0.03 * L.H && Math.abs(x) < 0.05 * L.H;
          // Лиф продолжается подкладкой по бёдрам до колен под юбкой: сидя бедро не протыкает ткань.
          on = ((hipBand && y >= L.hips - 0.11 * L.H) || p === P.upperleg || p === P.upperarm1) && !inNeckline;
          break;
        }
      }
      if (this.category === 'outer' && (p === P.torso || p === P.upperleg) && y < L.hips - 0.11 * L.H) on = false;
      c[v] = on ? 1 : 0;
    }
    const src = this.rig.meshes[0].geometry.index!.array;
    const idx: number[] = [];
    for (let f = 0; f < src.length; f += 3) {
      if (c[src[f]] && c[src[f + 1]] && c[src[f + 2]]) idx.push(src[f], src[f + 1], src[f + 2]);
    }
    this.shell.geometry.setIndex(idx);
  }

  /** Доля длины плеча (от плечевого сустава к локтю) для вершины руки: 0 — плечо, 1 — локоть, >1 — предплечье. */
  private armAlong(v: number, rest: Float32Array): number {
    const side = rest[v * 3] * this.rig.left > 0 ? 'L' : 'R';
    if (+this.parts[v] === P.lowerarm) return 1.5;
    return this.segmentT(v, rest, `upperarm01.${side}`, `lowerarm01.${side}`);
  }

  /** Доля длины бедра (от тазобедренного сустава к колену) для вершины ноги. */
  private thighAlong(v: number, rest: Float32Array): number {
    const side = rest[v * 3] * this.rig.left > 0 ? 'L' : 'R';
    return this.segmentT(v, rest, `upperleg01.${side}`, `lowerleg01.${side}`);
  }

  private segmentT(v: number, rest: Float32Array, from: string, to: string): number {
    const a = this.rig.head(from), b = this.rig.head(to);
    const d = b.clone().sub(a);
    const len2 = d.lengthSq() || 1e-9;
    return new THREE.Vector3().fromArray(rest, v * 3).sub(a).dot(d) / len2;
  }

  /**
   * Координаты для складок: угол вокруг оси и положение вдоль неё, плюс привязка
   * к ближайшему сгибу (локоть, колено, пах) для гармошки в шейдере.
   */
  private limbCoords(rest: Float32Array, L: Levels): void {
    const r = this.rig;
    const joint = (this.shell.geometry.getAttribute('aJoint') as THREE.BufferAttribute).array as Float32Array;
    const axisA = (this.shell.geometry.getAttribute('aAxis') as THREE.BufferAttribute).array as Float32Array;
    const normal = this.rig.meshes[0].geometry.getAttribute('normal');

    // Центр торса — среднее по вершинам торса.
    let cx = 0, cz = 0, cnt = 0;
    for (let v = 0; v < this.covered.length; v++) {
      if (+this.parts[v] !== P.torso) continue;
      cx += rest[v * 3]; cz += rest[v * 3 + 2]; cnt++;
    }
    cx /= cnt || 1;
    cz /= cnt || 1;

    const limb = (from: string, mid: string, to: string) => {
      const a = r.head(from), m = r.head(mid), b = r.head(to);
      const dir = b.clone().sub(a);
      const len = dir.length();
      dir.normalize();
      const ref = new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const side = new THREE.Vector3().crossVectors(dir, ref);
      return { a, dir, len, mid: m.clone().sub(a).dot(dir), ref, side };
    };
    const limbs = {
      armL: limb('upperarm01.L', 'lowerarm01.L', 'wrist.L'),
      armR: limb('upperarm01.R', 'lowerarm01.R', 'wrist.R'),
      legL: limb('upperleg01.L', 'lowerleg01.L', 'foot.L'),
      legR: limb('upperleg01.R', 'lowerleg01.R', 'foot.R'),
    };
    const hipY = (r.head('upperleg01.L').y + r.head('upperleg01.R').y) / 2;
    const pt = new THREE.Vector3();
    const smooth = (e0: number, e1: number, x: number) => {
      const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    };

    for (let v = 0; v < this.covered.length; v++) {
      if (!this.covered[v]) continue;
      const p = +this.parts[v];
      pt.fromArray(rest, v * 3);
      const nz = normal.getZ(v);
      const isArm = p === P.upperarm1 || p === P.upperarm2 || p === P.lowerarm;
      const isLeg = p === P.upperleg || p === P.lowerleg;
      const leftSide = pt.x * r.left > 0;
      if (isArm || (isLeg && pt.y < hipY - 0.02 * L.H)) {
        const lb = isArm ? (leftSide ? limbs.armL : limbs.armR) : leftSide ? limbs.legL : limbs.legR;
        const d = pt.clone().sub(lb.a);
        const s = d.dot(lb.dir);
        d.addScaledVector(lb.dir, -s);
        this.theta[v] = Math.atan2(d.dot(lb.side), d.dot(lb.ref));
        this.along[v] = s;
        this.limbLen[v] = lb.len;
        // Локоть: сжимается перёд руки; колено: сзади, но мнётся и спереди.
        const code = isArm ? (leftSide ? 1 : 2) : leftSide ? 3 : 4;
        this.tube[v] = isArm ? (leftSide ? 2 : 3) : leftSide ? 4 : 5;
        const inside = isArm ? smooth(-0.3, 0.6, nz) : 0.35 + 0.65 * smooth(-0.3, 0.6, -nz);
        joint.set([s - lb.mid, code, inside, this.theta[v]], v * 4);
        axisA.set([lb.dir.x, lb.dir.y, lb.dir.z], v * 3);
      } else {
        this.theta[v] = Math.atan2(pt.x - cx, pt.z - cz);
        this.along[v] = pt.y;
        this.limbLen[v] = 0;
        this.tube[v] = p === P.neck ? 0 : 1;
        // Пах: сидя спереди внизу живота и на бёдрах собирается гармошка.
        const inside = smooth(0, 0.5, nz);
        joint.set([pt.y - hipY - 0.02 * L.H, 5, inside, this.theta[v]], v * 4);
        axisA.set([0, 1, 0], v * 3);
      }
    }
    this.shell.geometry.getAttribute('aJoint').needsUpdate = true;
    this.shell.geometry.getAttribute('aAxis').needsUpdate = true;
  }

  // ------------------------------------------------------------ отступ от тела и складки

  /** Радиальный отступ вещи от кожи по зоне, м: (обхват вещи − обхват тела) / 2π. */
  private zoneGap(zone: Ring, body: Figure, size: SizeFit): number {
    const z = size.zones.find((q) => q.zone === zone);
    const ease = DESIGN_EASE[this.category][zone];
    // Обхват вещи = середина удобного диапазона тела + конструктивная свобода.
    const garment = z ? (z.range[0] + z.range[1]) / 2 + ease : body[zone] + ease;
    return Math.max(0.0015, (garment - body[zone]) / (2 * Math.PI) / 100);
  }

  private offsets(rest: Float32Array, L: Levels, body: Figure, size: SizeFit, tints: Partial<Record<Ring, number>>): void {
    const b = BUILD[this.category];
    const D = DRAPE[this.category];
    const gap = { chest: this.zoneGap('chest', body, size), waist: this.zoneGap('waist', body, size), hips: this.zoneGap('hips', body, size) };
    const geo = this.shell.geometry;
    const disp = (geo.getAttribute('aDisp') as THREE.BufferAttribute).array as Float32Array;
    const hem = (geo.getAttribute('aHem') as THREE.BufferAttribute).array as Float32Array;
    const tint = (geo.getAttribute('aTint') as THREE.BufferAttribute).array as Float32Array;
    const n = this.covered.length;
    const nrm = this.restNormals(rest);
    const c = this.tubeCoords(rest, L);

    // Целевой радиус ткани для вершин трубок (торс, руки, ноги) — с учётом свисания и складок.
    const target = new Float32Array(n).fill(-1);
    const topRef = tubeTop(L);
    const torsoHem = L.hips - (TORSO_HEM[this.category] ?? 0.03) * L.H;
    hem.fill(1);
    if (D.torso) {
      const t = D.torso;
      const rib = t.rib;
      const hemA = topRef - torsoHem;
      const ribFrom = rib ? hemA - rib[0] : Infinity;
      // Перемычка и подъём ткани от груди к плечам: у свободных вещей сильнее, у рубашки и футболки слабее,
      // у платья нет (лиф по фигуре).
      const TAPER_UP: Partial<Record<Category, number>> = { outer: 0.35, top: 0.5, tee: 0.9, shirt: 0.8 };
      this.shapeTube(1, c, target, hem, {
        gap: (a) => torsoGap(topRef - a, L, gap),
        taper: () => t.taper, ribFrom, ribGap: rib ? rib[1] : 0, folds: t.folds, depth: t.depth,
        taperUp: TAPER_UP[this.category],
      });
    }
    if (D.sleeve) {
      const t = D.sleeve;
      for (const tube of [2, 3]) {
        const len = this.tubeLength(tube, c);
        const ribFrom = t.rib ? len - t.rib[0] : Infinity;
        this.shapeTube(tube, c, target, hem, {
          gap: () => b.sleeve, taper: () => t.taper, ribFrom, ribGap: t.rib ? t.rib[1] : 0, folds: t.folds, depth: t.depth,
        });
      }
    }
    if (D.leg) {
      const t = D.leg;
      for (const tube of [4, 5]) {
        const knee = this.rig.head(tube === 4 ? 'lowerleg01.L' : 'lowerleg01.R');
        const hip = this.rig.head(tube === 4 ? 'upperleg01.L' : 'upperleg01.R');
        const kneeA = knee.distanceTo(hip);
        const len = this.tubeLength(tube, c);
        this.shapeTube(tube, c, target, hem, {
          // От бёдер к колену штанина сужается до свободы штанины, ниже висит прямой трубой.
          gap: (a) => THREE.MathUtils.lerp(gap.hips, b.leg, THREE.MathUtils.clamp(a / kneeA, 0, 1)),
          taper: (a) => (a < kneeA ? t.taperAbove : t.taperBelow),
          ribFrom: Infinity, ribGap: 0, folds: t.folds, depth: t.depth, hemAt: len,
        });
      }
    }

    const color = new THREE.Color();
    const band = 0.03 * L.H;
    for (let v = 0; v < n; v++) {
      if (!this.covered[v]) continue;
      const p = +this.parts[v];
      const y = rest[v * 3 + 1];
      const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      // Отступ по нормали — там, где ткань не свисает (плечи, воротник, верх груди).
      let o: number;
      if (p === P.neck) o = b.collar;
      else if (c.tube[v] === 1 || (c.tube[v] === 0 && p !== P.neck)) o = torsoGap(y, L, gap);
      else if (c.tube[v] >= 4) o = THREE.MathUtils.lerp(gap.hips, b.leg, THREE.MathUtils.clamp((L.hips - y) / Math.max(0.01, L.hips - L.knee), 0, 1));
      else o = b.sleeve;

      let w = 0;
      let radial = 0;
      if (target[v] >= 0) {
        // У самого верха трубки (плечи, верх груди) поверхности, смотрящие «вверх» по ней,
        // двигаем по нормали: ткань на них лежит. Ниже — всё к целевому радиусу: ткань свисает.
        const ax = c.axis[v * 3], ay = c.axis[v * 3 + 1], az = c.axis[v * 3 + 2];
        const nearTop = 1 - smooth(0.015, 0.045, c.along[v]);
        w = 1 - smooth(0.4, 0.8, nx * ax + ny * ay + nz * az) * nearTop;
        radial = Math.max(0, target[v] - c.rad[v]);
      }
      const rx = c.dir[v * 3], ry = c.dir[v * 3 + 1], rz = c.dir[v * 3 + 2];
      const k = o * (1 - w) + b.thick;
      disp[v * 3] = rx * radial * w + nx * k;
      disp[v * 3 + 1] = ry * radial * w + ny * k;
      disp[v * 3 + 2] = rz * radial * w + nz * k;

      // Подсветка посадки на ткани: те же пояса, что на теле.
      let tw = 0;
      tint.fill(0, v * 4, v * 4 + 4);
      for (const r of ['chest', 'waist', 'hips'] as Ring[]) {
        const hex = tints[r];
        if (hex === undefined || (p !== P.torso && !(r === 'hips' && p === P.upperleg))) continue;
        const d = Math.abs(y - L[r]);
        if (d >= band) continue;
        const kk = 1 - (d / band) ** 2;
        if (kk > tw) {
          tw = kk;
          color.setHex(hex);
          tint.set([color.r, color.g, color.b, 0.6 * kk], v * 4);
        }
      }
    }
    // Свободные вещи сглаживаем сильнее (ткань перекрывает впадины), облегающие — слегка.
    // Пуховик жёсткий: почти не повторяет рельеф тела.
    const SMOOTH: Partial<Record<Category, number>> = { outer: 40, top: 20, tee: 12, shirt: 12 };
    this.smoothSurface(rest, disp, SMOOTH[this.category] ?? 6);
    // Ткань не бывает внутри тела: где она прилегает, не ближе к коже, чем её толщина.
    // Где ткань висит далеко от кожи (над пупком, под грудью), это правило не нужно.
    const minOff = b.thick + 0.002;
    for (let v = 0; v < n; v++) {
      if (!this.covered[v]) continue;
      const i = v * 3;
      const along = disp[i] * nrm[i] + disp[i + 1] * nrm[i + 1] + disp[i + 2] * nrm[i + 2];
      const far = Math.hypot(disp[i], disp[i + 1], disp[i + 2]) > minOff + 0.01;
      if (!far && along < minOff) {
        const k = minOff - along;
        disp[i] += nrm[i] * k; disp[i + 1] += nrm[i + 1] * k; disp[i + 2] += nrm[i + 2] * k;
      }
    }
    geo.getAttribute('aDisp').needsUpdate = true;
    geo.getAttribute('aHem').needsUpdate = true;
    geo.getAttribute('aTint').needsUpdate = true;
    this.foldNormals(rest, disp, nrm);
  }

  /** Соседи вершин по треугольникам вещи (CSR): для сглаживания. */
  private neighbors: { start: Int32Array; list: Int32Array } | null = null;

  /**
   * Сглаживание поверхности ткани (тело + сдвиг) по связям сетки: ткань перекрывает
   * мелкие впадины тела (пупок, складки под грудью), швы «торс — рукав» сходятся,
   * ступеньки от сетки свисания разглаживаются. Сглаживать нужно именно поверхность,
   * а не сдвиги: иначе впадины тела проступают обратно.
   */
  private smoothSurface(rest: Float32Array, disp: Float32Array, iterations: number): void {
    if (!this.neighbors) {
      const n = this.covered.length;
      const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
      const idx = this.shell.geometry.index!.array;
      for (let f = 0; f < idx.length; f += 3) {
        const a = idx[f], b = idx[f + 1], c = idx[f + 2];
        sets[a].add(b); sets[a].add(c);
        sets[b].add(a); sets[b].add(c);
        sets[c].add(a); sets[c].add(b);
      }
      const start = new Int32Array(n + 1);
      for (let v = 0; v < n; v++) start[v + 1] = start[v] + sets[v].size;
      const list = new Int32Array(start[n]);
      for (let v = 0; v < n; v++) list.set([...sets[v]], start[v]);
      this.neighbors = { start, list };
    }
    const { start, list } = this.neighbors;
    let src = new Float32Array(disp.length);
    for (let i = 0; i < disp.length; i++) src[i] = rest[i] + disp[i];
    let dst = new Float32Array(disp.length);
    for (let it = 0; it < iterations; it++) {
      for (let v = 0; v < this.covered.length; v++) {
        const s0 = start[v], s1 = start[v + 1];
        if (!this.covered[v] || s1 === s0) {
          dst[v * 3] = src[v * 3]; dst[v * 3 + 1] = src[v * 3 + 1]; dst[v * 3 + 2] = src[v * 3 + 2];
          continue;
        }
        let x = 0, y = 0, z = 0;
        for (let k = s0; k < s1; k++) {
          const u = list[k] * 3;
          x += src[u]; y += src[u + 1]; z += src[u + 2];
        }
        const inv = 1 / (s1 - s0);
        // Сглаживание Таубина: шаг к соседям (0.5) и шаг обратно (−0.53) по очереди.
        // Мелкая рябь уходит, а выпуклости не ужимаются — ткань не проваливается в тело.
        const f = it % 2 === 0 ? 0.5 : -0.53;
        dst[v * 3] = src[v * 3] + f * (x * inv - src[v * 3]);
        dst[v * 3 + 1] = src[v * 3 + 1] + f * (y * inv - src[v * 3 + 1]);
        dst[v * 3 + 2] = src[v * 3 + 2] + f * (z * inv - src[v * 3 + 2]);
      }
      [src, dst] = [dst, src];
    }
    for (let i = 0; i < disp.length; i++) disp[i] = src[i] - rest[i];
  }

  /** Нормали тела в покое при текущей форме (по треугольникам вещи). */
  private restNormals(rest: Float32Array): Float32Array {
    const tmp = new THREE.BufferGeometry();
    tmp.setIndex(this.shell.geometry.index);
    tmp.setAttribute('position', new THREE.BufferAttribute(rest.slice(), 3));
    tmp.computeVertexNormals();
    return (tmp.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
  }

  /**
   * Цилиндрические координаты вершин вокруг осей трубок при текущей форме:
   * along — вдоль оси (торс: вниз от груди; руки/ноги: от плеча/бедра), rad — до оси,
   * dir — единичный вектор от оси к вершине, theta — угол, axis — «вверх» по трубке (к плечу, бедру, шее).
   */
  private tubeCoords(rest: Float32Array, L: Levels) {
    const n = this.covered.length;
    const along = new Float32Array(n), rad = new Float32Array(n), theta = new Float32Array(n);
    const dir = new Float32Array(n * 3), axis = new Float32Array(n * 3);
    const tube = new Int8Array(n);
    const r = this.rig;
    const topRef = tubeTop(L);
    let cx = 0, cz = 0, cnt = 0;
    for (let v = 0; v < n; v++) {
      if (this.tube[v] !== 1) continue;
      cx += rest[v * 3]; cz += rest[v * 3 + 2]; cnt++;
    }
    cx /= cnt || 1;
    cz /= cnt || 1;
    // Ось руки/ноги — ломаная по суставам: плечо → локоть → запястье, бедро → колено → стопа.
    // Прямая «плечо — запястье» проходит у локтя мимо середины руки и путает направления.
    const seg = (from: string, to: string, offset: number) => {
      const a = r.head(from), b = r.head(to);
      const len = a.distanceTo(b);
      const d = b.clone().sub(a).normalize();
      const ref = new THREE.Vector3(0, 0, 1).addScaledVector(d, -d.z).normalize();
      return { a, d, ref, side: new THREE.Vector3().crossVectors(d, ref), offset, len };
    };
    const limb = (s1: string, s2: string, s3: string) => {
      const upper = seg(s1, s2, 0);
      return { upper, lower: seg(s2, s3, upper.len) };
    };
    const limbs: Record<number, ReturnType<typeof limb>> = {
      2: limb('upperarm01.L', 'lowerarm01.L', 'wrist.L'), 3: limb('upperarm01.R', 'lowerarm01.R', 'wrist.R'),
      4: limb('upperleg01.L', 'lowerleg01.L', 'foot.L'), 5: limb('upperleg01.R', 'lowerleg01.R', 'foot.R'),
    };
    const pt = new THREE.Vector3();
    for (let v = 0; v < n; v++) {
      if (!this.covered[v]) continue;
      const t = this.tube[v];
      pt.fromArray(rest, v * 3);
      if (t === 1) {
        const dx = pt.x - cx, dz = pt.z - cz;
        const rr = Math.hypot(dx, dz) || 1e-6;
        along[v] = topRef - pt.y;
        rad[v] = rr;
        theta[v] = Math.atan2(dx, dz);
        dir.set([dx / rr, 0, dz / rr], v * 3);
        axis.set([0, 1, 0], v * 3);
        tube[v] = along[v] >= 0 ? 1 : 0;
      } else if (t >= 2) {
        const p = +this.parts[v];
        const lower = p === P.lowerarm || p === P.lowerleg;
        const lb = lower ? limbs[t].lower : limbs[t].upper;
        const d = pt.clone().sub(lb.a);
        const s0 = d.dot(lb.d);
        const s = s0 + lb.offset;
        d.addScaledVector(lb.d, -s0);
        const rr = d.length() || 1e-6;
        along[v] = s;
        rad[v] = rr;
        theta[v] = Math.atan2(d.dot(lb.side), d.dot(lb.ref));
        dir.set([d.x / rr, d.y / rr, d.z / rr], v * 3);
        // «Вверх» по трубке — к плечу/бедру.
        axis.set([-lb.d.x, -lb.d.y, -lb.d.z], v * 3);
        // Рукав-трубка начинается ниже плеча: у плеча часть вершин (подмышка, бок груди)
        // далеко от оси руки, и свисание утащило бы внутреннюю сторону рукава в торс.
        tube[v] = t <= 3 && s < 0.12 ? 0 : t;
      }
    }
    return { along, rad, theta, dir, axis, tube };
  }

  private tubeLength(tube: number, c: ReturnType<Garment['tubeCoords']>): number {
    let max = 0;
    for (let v = 0; v < c.tube.length; v++) if (c.tube[v] === tube && this.covered[v]) max = Math.max(max, c.along[v]);
    return max;
  }

  /**
   * Форма ткани вокруг одной трубки. По сетке «длина × угол»: тело — самая дальняя
   * вершина в клетке; ткань — не ближе запаса к телу и не круче taper внутрь (свисает);
   * у резинки — прижата; в лишнем запасе — складки. Пишет целевой радиус в target
   * и расстояние до резинки/подола (для заломов) в hem.
   */
  private shapeTube(
    tube: number,
    c: ReturnType<Garment['tubeCoords']>,
    target: Float32Array,
    hem: Float32Array,
    spec: {
      gap: (a: number) => number; taper: (a: number) => number; ribFrom: number; ribGap: number;
      folds: number; depth: number; hemAt?: number;
      /** Свободная вещь: ткань поднимается от груди к плечам не круче taperUp и натягивается перемычкой по кругу. */
      taperUp?: number;
    },
  ): void {
    const ids: number[] = [];
    let amin = Infinity, amax = -Infinity;
    for (let v = 0; v < c.tube.length; v++) {
      if (!this.covered[v] || c.tube[v] !== tube) continue;
      ids.push(v);
      amin = Math.min(amin, c.along[v]);
      amax = Math.max(amax, c.along[v]);
    }
    if (ids.length < 10) return;
    const dy = 0.012, cols = 64;
    const rows = Math.max(2, Math.ceil((amax - amin) / dy) + 1);
    const body = new Float32Array(rows * cols);
    const cell = (a: number, th: number) => {
      const k = Math.min(rows - 1, Math.max(0, Math.round((a - amin) / dy)));
      const i = ((Math.round((th / (Math.PI * 2)) * cols) % cols) + cols) % cols;
      return k * cols + i;
    };
    for (const v of ids) {
      const j = cell(c.along[v], c.theta[v]);
      body[j] = Math.max(body[j], c.rad[v]);
    }
    // Пустые клетки — по соседям по кругу, пустые ряды — как ряд выше.
    for (let k = 0; k < rows; k++) {
      const row = body.subarray(k * cols, (k + 1) * cols);
      const src = row.slice();
      let any = false;
      for (let i = 0; i < cols; i++) {
        if (src[i] > 0) { any = true; continue; }
        let m = 0;
        for (let d = 1; d <= 4 && m === 0; d++) m = Math.max(src[(i + d) % cols], src[(i - d + cols) % cols]);
        row[i] = m;
      }
      if (!any && k > 0) row.set(body.subarray((k - 1) * cols, k * cols));
    }
    const fabric = new Float32Array(rows * cols);
    for (let k = 0; k < rows; k++) {
      const a = amin + k * dy;
      const g = spec.gap(a);
      const ribT = smooth(spec.ribFrom, spec.ribFrom + 0.03, a);
      for (let i = 0; i < cols; i++) {
        const j = k * cols + i;
        const own = body[j] + g;
        let r = k === 0 ? own : Math.max(own, fabric[j - cols] - spec.taper(a) * dy);
        r += (body[j] + spec.ribGap - r) * ribT;
        fabric[j] = r;
      }
    }
    if (spec.taperUp !== undefined) {
      // Снизу вверх: от груди к плечам ткань идёт наклонно, а не ныряет над грудью.
      for (let k = rows - 2; k >= 0; k--) {
        for (let i = 0; i < cols; i++) {
          const j = k * cols + i;
          fabric[j] = Math.max(fabric[j], fabric[j + cols] - spec.taperUp * dy);
        }
      }
      // По кругу: ткань натянута перемычкой между выпуклостями (как выпуклая оболочка).
      const pts: [number, number][] = new Array(cols);
      for (let k = 0; k < rows; k++) {
        for (let i = 0; i < cols; i++) {
          const th = (i / cols) * Math.PI * 2;
          const r = fabric[k * cols + i];
          pts[i] = [Math.sin(th) * r, Math.cos(th) * r];
        }
        const hull = convexHull(pts);
        if (hull.length < 3) continue;
        for (let i = 0; i < cols; i++) {
          const th = (i / cols) * Math.PI * 2;
          fabric[k * cols + i] = Math.max(fabric[k * cols + i], rayHull(hull, Math.sin(th), Math.cos(th)));
        }
      }
      // Резинку низа применяем заново: перемычка не должна её растягивать.
      for (let k = 0; k < rows; k++) {
        const a = amin + k * dy;
        const ribT = smooth(spec.ribFrom, spec.ribFrom + 0.03, a);
        if (ribT <= 0) continue;
        for (let i = 0; i < cols; i++) {
          const j = k * cols + i;
          fabric[j] += (body[j] + spec.ribGap - fabric[j]) * ribT;
        }
      }
    }
    // Складки: часть лишнего запаса уходит в глубину волн по кругу.
    const final = new Float32Array(rows * cols);
    for (let k = 0; k < rows; k++) {
      const a = amin + k * dy;
      const g = spec.gap(a);
      for (let i = 0; i < cols; i++) {
        const j = k * cols + i;
        const th = (i / cols) * Math.PI * 2;
        const free = Math.max(0, fabric[j] - body[j] - g);
        const wave = 0.5 + 0.5 * Math.sin(spec.folds * th + 1.2 * Math.sin(3 * th + 0.7) + a * 3);
        final[j] = fabric[j] - spec.depth * free * (1 - wave);
      }
    }
    for (const v of ids) {
      const fk = Math.min(rows - 1.001, Math.max(0, (c.along[v] - amin) / dy));
      const fi = ((((c.theta[v] / (Math.PI * 2)) * cols) % cols) + cols) % cols;
      const k0 = Math.floor(fk), i0 = Math.floor(fi) % cols, i1 = (i0 + 1) % cols;
      const ty = fk - k0, tx = fi - Math.floor(fi);
      const at = (k: number, i: number) => final[k * cols + i];
      target[v] =
        (at(k0, i0) * (1 - tx) + at(k0, i1) * tx) * (1 - ty) + (at(k0 + 1, i0) * (1 - tx) + at(k0 + 1, i1) * tx) * ty;
      if (Number.isFinite(spec.ribFrom)) hem[v] = Math.max(0, spec.ribFrom - c.along[v]);
      else if (spec.hemAt !== undefined) hem[v] = Math.max(0, spec.hemAt - c.along[v]);
    }
  }

  /**
   * Свет на складках: нормали поверхности со всеми отступами минус нормали тела.
   * Шейдер добавляет эту поправку к нормали тела, и складки получают тени.
   */
  private foldNormals(rest: Float32Array, disp: Float32Array, n0: Float32Array): void {
    const n = this.covered.length;
    const moved = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) moved[i] = rest[i] + disp[i];
    const tmp = new THREE.BufferGeometry();
    tmp.setIndex(this.shell.geometry.index);
    tmp.setAttribute('position', new THREE.BufferAttribute(moved, 3));
    tmp.computeVertexNormals();
    const n1 = (tmp.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
    const pert = (this.shell.geometry.getAttribute('aNPert') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < n * 3; i++) pert[i] = this.covered[(i / 3) | 0] ? n1[i] - n0[i] : 0;
    this.shell.geometry.getAttribute('aNPert').needsUpdate = true;
  }

  // ------------------------------------------------------------ юбка: ткань

  private buildSkirt(rest: Float32Array, L: Levels, body: Figure, size: SizeFit, around: Surroundings): void {
    const spec = SKIRT[this.category];
    if (!spec) return;
    const r = this.rig;
    // Верх юбки прячется под лиф (у платья и куртки — на линии бёдер, лиф кончается ниже)
    // или под пояс (у юбки — на талии).
    const topY = spec.from === 'waist' ? L.waist - 0.004 * L.H : L.hips + 0.005 * L.H;
    const hemY = spec.hem * L.H;
    const gap = this.zoneGap('hips', body, size) + BUILD[this.category].thick;

    const pts: [number, number][] = [];
    let cx = 0, cz = 0;
    for (let v = 0; v < this.covered.length; v++) {
      const p = +this.parts[v];
      if (p !== P.torso && p !== P.upperleg) continue;
      if (Math.abs(rest[v * 3 + 1] - topY) < 0.012 * L.H) {
        pts.push([rest[v * 3], rest[v * 3 + 2]]);
        cx += rest[v * 3];
        cz += rest[v * 3 + 2];
      }
    }
    cx /= pts.length || 1;
    cz /= pts.length || 1;
    const hull = convexHull(pts.map(([x, z]) => [x - cx, z - cz]));
    // Поверхность верха вещи на этой высоте (тело + сдвиг): юбка пришивается к ней,
    // чтобы шов сходился и подкладка не выглядывала из-под низа куртки.
    const disp = (this.shell.geometry.getAttribute('aDisp') as THREE.BufferAttribute).array as Float32Array;
    const shellPts: [number, number][] = [];
    for (let v = 0; v < this.covered.length; v++) {
      if (!this.covered[v]) continue;
      const p = +this.parts[v];
      if (p !== P.torso && p !== P.upperleg) continue;
      const y = rest[v * 3 + 1] + disp[v * 3 + 1];
      if (Math.abs(y - topY) < 0.012 * L.H) shellPts.push([rest[v * 3] + disp[v * 3] - cx, rest[v * 3 + 2] + disp[v * 3 + 2] - cz]);
    }
    const shellHull = shellPts.length >= 3 ? convexHull(shellPts) : null;
    const top = new Float32Array(COLS * 3);
    for (let i = 0; i < COLS; i++) {
      const a = (i / COLS) * Math.PI * 2;
      const own = rayHull(hull, Math.cos(a), Math.sin(a)) + gap;
      const rad = shellHull ? Math.max(own, rayHull(shellHull, Math.cos(a), Math.sin(a)) + 0.002) : own;
      top.set([cx + Math.cos(a) * rad, topY, cz + Math.sin(a) * rad], i * 3);
    }
    this.skirtTop = top;
    // Кости для каждой точки пояса юбки — как у ближайшей вершины лифа.
    {
      const bodyGeo = r.meshes[0].geometry;
      const si = bodyGeo.getAttribute('skinIndex');
      const sw = bodyGeo.getAttribute('skinWeight');
      const index = new Uint16Array(COLS * 4), weight = new Float32Array(COLS * 4);
      for (let i = 0; i < COLS; i++) {
        let best = -1, bd = Infinity;
        for (let v = 0; v < this.covered.length; v++) {
          const p = +this.parts[v];
          if (p !== P.torso && p !== P.upperleg) continue;
          const dy = rest[v * 3 + 1] - topY;
          if (Math.abs(dy) > 0.03 * L.H) continue;
          const dx = rest[v * 3] - top[i * 3], dz = rest[v * 3 + 2] - top[i * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = v; }
        }
        if (best < 0) continue;
        for (let k = 0; k < 4; k++) {
          index[i * 4 + k] = si.getComponent(best, k);
          weight[i * 4 + k] = sw.getComponent(best, k);
        }
      }
      this.skirtSkin = { index, weight };
    }

    // Радиусы тела для столкновений: таз (по глубине), бедро, голень.
    const depth = Math.max(...hull.map((q) => Math.abs(q[1])));
    this.radii.pelvis = depth * 0.95;
    this.radii.thighTop = this.limbRadius(rest, P.upperleg, 0.12);
    this.radii.thighKnee = this.limbRadius(rest, P.upperleg, 0.9);
    this.radii.shinTop = this.limbRadius(rest, P.lowerleg, 0.1);
    this.radii.shinAnkle = this.limbRadius(rest, P.lowerleg, 0.9);

    this.profile = this.hipProfile(rest, L, topY, cx, cz);

    // Поза могла уже сдвинуть таз: пришиваем к нему сразу.
    const pinned = this.posedTop();

    const design: SkirtDesign = {
      rows: ROWS,
      cols: COLS,
      top: pinned,
      center: [cx, topY, cz],
      length: topY - hemY,
      flare: spec.flare,
      stiffness: spec.stiffness,
      folds: spec.folds,
    };
    const env = this.env(around);
    if (!this.cloth) {
      this.cloth = new Cloth({ ...design, top: top });
      this.cloth.setPins(pinned);
      for (let s = 0; s < 90; s++) this.cloth.step(1 / 60, env);
      this.makeSkirtMesh();
    } else {
      // Фигура или размер поменялись: длины ниток новые, ткань продолжает висеть.
      this.cloth.setDesign({ ...design, top: top }, false);
      this.cloth.setPins(pinned);
      const restAttr = this.skirt!.geometry.getAttribute('aRest') as THREE.BufferAttribute;
      restAttr.needsUpdate = true;
    }
  }

  /** Профиль тела от пояса юбки вниз на 14% роста: по каждой высоте и углу — до кожи. */
  private hipProfile(rest: Float32Array, L: Levels, topY: number, cx: number, cz: number) {
    // От пояса юбки до низа ягодиц: у юбки от талии это длиннее, чем у платья от бёдер.
    const span = Math.max(0.14 * L.H, topY - (L.hips - 0.12 * L.H));
    const rows = Math.round(span / (0.01 * L.H)), cols = 48;
    const dy = span / (rows - 1);
    const radii = new Float32Array(rows * cols);
    for (let k = 0; k < rows; k++) {
      const y = topY - k * dy;
      const pts: [number, number][] = [];
      for (let v = 0; v < this.covered.length; v++) {
        const p = +this.parts[v];
        if (p !== P.torso && p !== P.upperleg) continue;
        if (Math.abs(rest[v * 3 + 1] - y) < dy * 0.7) pts.push([rest[v * 3] - cx, rest[v * 3 + 2] - cz]);
      }
      if (pts.length < 3) continue;
      const hull = convexHull(pts);
      for (let i = 0; i < cols; i++) {
        const a = (i / cols) * Math.PI * 2;
        radii[k * cols + i] = rayHull(hull, Math.cos(a), Math.sin(a));
      }
    }
    return { y0: topY, dy, rows, cols, cx, cz, radii };
  }

  /** Радиус ноги на доле её длины (по вершинам части тела вокруг оси сустава). */
  private limbRadius(rest: Float32Array, part: number, at: number): number {
    const ds: number[] = [];
    for (let v = 0; v < this.covered.length; v++) {
      if (+this.parts[v] !== part || this.limbLen[v] === 0) continue;
      const t = this.along[v] / this.limbLen[v];
      if (Math.abs(t - at) > 0.05) continue;
      const side = rest[v * 3] * this.rig.left > 0 ? 'L' : 'R';
      const a = this.rig.head(part === P.upperleg ? `upperleg01.${side}` : `lowerleg01.${side}`);
      const b = this.rig.head(part === P.upperleg ? `lowerleg01.${side}` : `foot.${side}`);
      const dir = b.clone().sub(a).normalize();
      const d = new THREE.Vector3().fromArray(rest, v * 3).sub(a);
      d.addScaledVector(dir, -d.dot(dir));
      ds.push(d.length());
    }
    if (!ds.length) return part === P.upperleg ? 0.08 : 0.05;
    ds.sort((x, y) => x - y);
    // По внешнему краю: ткань не должна проваливаться в ногу (бедро не круглое).
    return ds[Math.floor(ds.length * 0.95)] + 0.006;
  }

  private makeSkirtMesh(): void {
    const cloth = this.cloth!;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloth.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRest', new THREE.BufferAttribute(cloth.rest, 3));
    const n = cloth.pos.length / 3;
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    const index: number[] = [];
    for (let k = 0; k < cloth.rows; k++) {
      for (let i = 0; i < cloth.cols; i++) {
        const a = k * cloth.cols + i, b = k * cloth.cols + ((i + 1) % cloth.cols), c = a + cloth.cols, d = b + cloth.cols;
        index.push(a, b, c, b, d, c);
      }
    }
    geo.setIndex(index);
    geo.computeVertexNormals();
    // Нормали наружу: если первая смотрит внутрь, разворачиваем треугольники.
    const p = cloth.pos, nrm = geo.getAttribute('normal');
    const [cx, , cz] = [p[0] - p[(cloth.cols / 2) * 3], 0, p[2] - p[(cloth.cols / 2) * 3 + 2]];
    if (nrm.getX(0) * cx + nrm.getZ(0) * cz < 0) {
      for (let f = 0; f < index.length; f += 3) [index[f + 1], index[f + 2]] = [index[f + 2], index[f + 1]];
      geo.setIndex(index);
      geo.computeVertexNormals();
    }
    this.skirt = new THREE.Mesh(geo, this.clothMaterial);
    this.skirt.castShadow = true;
    this.skirt.frustumCulled = false;
    this.rig.group.add(this.skirt);
  }

  /** Тело, пол, сиденье и тяжесть в осях манекена (там живёт ткань). */
  private env(around: Surroundings): ClothEnv {
    const r = this.rig;
    const g = r.group;
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    const toRig = (p: THREE.Vector3) => p.clone().applyMatrix4(inv);
    const dirToRig = (d: THREE.Vector3) => toRig(d).sub(toRig(new THREE.Vector3())).normalize();
    const v3 = (p: THREE.Vector3): Vec3 => [p.x, p.y, p.z];

    const gravity = dirToRig(new THREE.Vector3(0, -1, 0)).multiplyScalar(9.8 / g.scale.x);
    const up = dirToRig(new THREE.Vector3(0, 1, 0));
    const floor = toRig(new THREE.Vector3(0, around.floorY, 0));

    const capsules: Capsule[] = [];
    const root = r.bonePos('root');
    const spine = r.bonePos('spine04');
    capsules.push({ a: v3(root), b: v3(spine), r: this.radii.pelvis });
    for (const s of ['L', 'R'] as Side[]) {
      const hip = r.bonePos(`upperleg01.${s}`);
      const knee = r.bonePos(`lowerleg01.${s}`);
      const ankle = r.bonePos(`foot.${s}`);
      capsules.push({ a: v3(hip), b: v3(knee), r: this.radii.thighTop, r2: this.radii.thighKnee });
      capsules.push({ a: v3(knee), b: v3(ankle), r: this.radii.shinTop, r2: this.radii.shinAnkle });
    }
    const disks: ClothEnv['disks'] = [];
    if (around.seat) {
      disks.push({ center: v3(toRig(around.seat.center)), up: v3(up), r: around.seat.r / g.scale.x });
    }
    // Профиль таза живёт в осях покоя: переводим ткань туда через кость таза и обратно.
    let profile: Profile | undefined;
    // Сидя бёдра повёрнуты вперёд, профиль покоя к ним не подходит — там работают капсулы.
    if (this.profile && !around.seat) {
      const fromLocal = r.boneDeform('root');
      const toLocal = fromLocal.clone().invert();
      profile = { ...this.profile, toLocal: toLocal.elements, fromLocal: fromLocal.elements };
    }
    return {
      gravity: v3(gravity),
      capsules,
      planes: [{ n: v3(up), c: up.dot(floor) }],
      disks,
      profile,
    };
  }

  // ------------------------------------------------------------ принт

  /** Где лежит принт: на груди (нашивка) или на всю переднюю часть (фото вещи). */
  private updatePrintRect(): void {
    const L = this.levels;
    if (!L) return;
    const rect = this.uniforms.uPrintRect.value;
    if (this.printRect === 'chest') {
      const w = 0.11 * L.H;
      rect.set(0, (L.chest + L.neck) / 2 - 0.02 * L.H, w, w);
      return;
    }
    if (this.printRect === 'placket') {
      // Планка с пуговицами: по центру спереди от низа рубашки до воротника.
      const top = L.neck - 0.035 * L.H;
      const bottom = L.hips - (TORSO_HEM[this.category] ?? 0.03) * L.H;
      rect.set(0, (top + bottom) / 2, 0.04 * L.H, top - bottom);
      return;
    }
    // Фото вещи растягиваем на всю закрытую вещью переднюю часть (в A-позе, как на раскладке).
    const pos = this.lastRest ?? (this.rig.meshes[0].geometry.getAttribute('position').array as Float32Array);
    const box = new THREE.Box2();
    for (let v = 0; v < this.covered.length; v++) {
      if (this.covered[v]) box.expandByPoint(new THREE.Vector2(pos[v * 3], pos[v * 3 + 1]));
    }
    const spec = SKIRT[this.category];
    if (spec) box.expandByPoint(new THREE.Vector2(box.min.x, spec.hem * L.H));
    const c = box.getCenter(new THREE.Vector2());
    const s = box.getSize(new THREE.Vector2());
    rect.set(c.x, c.y, s.x, s.y);
  }

  /** cloth=true — материал юбки: ткань из симуляции, рисунок по крою (aRest), без кожи под ней. */
  private makeMaterial(cloth: boolean): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const u = this.uniforms;
    const shellVars = `
attribute vec3 aDisp;
attribute vec3 aNPert;
attribute vec4 aJoint;
attribute vec3 aAxis;
attribute float aHem;
varying vec4 vJoint;
varying float vHem;
varying vec3 vAxisView;`;
    const common = `
uniform vec4 uBend;
uniform float uHip;
uniform vec3 uFoldAmp;
uniform vec3 uBumpAmp;
uniform float uStack;
varying vec3 vRest;
varying vec3 vRestN;
varying vec4 vTint;`;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      let vs = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aTint;
${cloth ? 'attribute vec3 aRest;' : shellVars}
${common}`)
        .replace('#include <morphnormal_vertex>', `#include <morphnormal_vertex>
vec3 restNormal = normalize(objectNormal);
float jointFold = 0.0;
${cloth ? '' : `
// Гармошка на сгибе (форма): крупные кольца вокруг сустава, глубже с внутренней стороны.
int code = int(aJoint.y + 0.5);
if (code > 0) {
  float bend = code == 1 ? uBend.x : code == 2 ? uBend.y : code == 3 ? uBend.z : code == 4 ? uBend.w : uHip;
  float amp = code <= 2 ? uFoldAmp.x : code <= 4 ? uFoldAmp.y : uFoldAmp.z;
  float s = aJoint.x;
  float env = exp(-s * s / 0.0064);
  float ph = s * 78.0 + 1.7 * sin(aJoint.w * 2.0);
  jointFold = amp * clamp(bend / 1.4, 0.0, 1.0) * aJoint.z * env * (0.5 + 0.5 * sin(ph));
}
objectNormal = normalize(objectNormal + aNPert);
vJoint = aJoint;
vHem = aHem;`}`)
        .replace('#include <morphtarget_vertex>', `#include <morphtarget_vertex>
vRest = ${cloth ? 'aRest' : 'transformed'};
vRestN = restNormal;
vTint = aTint;
transformed += ${cloth ? '' : 'aDisp + '}restNormal * jointFold;`);
      if (!cloth) {
        vs = vs.replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>
vec3 axisObj = aAxis;
#ifdef USE_SKINNING
axisObj = (skinMatrix * vec4(aAxis, 0.0)).xyz;
#endif
vAxisView = normalize(normalMatrix * axisObj + vec3(1e-6));`);
      }
      shader.vertexShader = vs;
      let fs = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uColor;
uniform sampler2D uFabric;
uniform float uFabricScale;
uniform sampler2D uPrint;
uniform vec4 uPrintRect;
uniform float uHasPrint;
uniform float uTintOn;
${common}
${cloth ? '' : 'varying vec4 vJoint;\nvarying float vHem;\nvarying vec3 vAxisView;'}`)
        .replace('#include <map_fragment>', `
vec3 an = abs(normalize(vRestN));
an /= (an.x + an.y + an.z + 1e-4);
vec4 fab = texture2D(uFabric, vRest.xy * uFabricScale) * an.z
         + texture2D(uFabric, vRest.zy * uFabricScale) * an.x
         + texture2D(uFabric, vRest.xz * uFabricScale) * an.y;
vec3 col = mix(uColor, fab.rgb, fab.a);
if (uHasPrint > 0.5 && vRestN.z > 0.0) {
  vec2 puv = (vRest.xy - uPrintRect.xy) / uPrintRect.zw + 0.5;
  if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
    vec4 pr = texture2D(uPrint, puv);
    col = mix(col, pr.rgb, pr.a * smoothstep(0.0, 0.25, vRestN.z));
  }
}
col = mix(col, vTint.rgb, vTint.a * uTintOn);
diffuseColor.rgb *= col;`);
      if (!cloth) {
        fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
// Заломы (свет): мелкие кольца на сгибе и над резинкой — наклон нормали вдоль оси трубки.
{
  float g = 0.0;
  int code = int(vJoint.y + 0.5);
  if (code > 0) {
    float bend = code == 1 ? uBend.x : code == 2 ? uBend.y : code == 3 ? uBend.z : code == 4 ? uBend.w : uHip;
    float amp = code <= 2 ? uBumpAmp.x : code <= 4 ? uBumpAmp.y : uBumpAmp.z;
    float s = vJoint.x;
    float env = exp(-s * s / 0.0049);
    float ph = s * 165.0 + 2.0 * sin(vJoint.w * 3.0);
    g += amp * clamp(bend / 1.3, 0.0, 1.0) * vJoint.z * env * cos(ph);
  }
  if (vHem < 0.08) {
    float h = vHem;
    float k = 1.0 - h / 0.08;
    g += uStack * k * k * cos(h * 180.0 + 2.2 * sin(vJoint.w * 2.0) + 1.3 * sin(vJoint.w * 5.0));
  }
  normal = normalize(normal - vAxisView * g);
}`);
      }
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => (cloth ? 'garment-cloth-v3' : 'garment-shell-v3');
    return m;
  }
}

/** Откуда ткань начинает свисать: верх груди. Выше (плечи, ключицы) она лежит на теле. */
function tubeTop(L: Levels): number {
  return L.neck - 0.06 * L.H;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Отступ на торсе: по высоте между кольцами груди, талии и бёдер. */
function torsoGap(y: number, L: Levels, gap: Record<Ring, number>): number {
  if (y >= L.chest) return gap.chest;
  if (y >= L.waist) return THREE.MathUtils.lerp(gap.waist, gap.chest, (y - L.waist) / (L.chest - L.waist));
  if (y >= L.hips) return THREE.MathUtils.lerp(gap.hips, gap.waist, (y - L.hips) / (L.waist - L.hips));
  return gap.hips;
}

/** Расстояние от центра до выпуклой оболочки по направлению (dx, dz). */
function rayHull(hull: [number, number][], dx: number, dz: number): number {
  let best = 0;
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i];
    const [bx, bz] = hull[(i + 1) % hull.length];
    const ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ez - az * ex) / den;
    const s = (ax * dz - az * dx) / den;
    if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6) best = Math.max(best, t);
  }
  return best;
}

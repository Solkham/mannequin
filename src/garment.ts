// Вещь на манекене: оболочка поверх тела на том же скелете (двигается в позах),
// юбка для платья и низа куртки, ткань, цвет, принт или фото вещи.
//
// Форма вещи берётся из размерной сетки: насколько вещь больше тела в груди,
// талии и бёдрах (свобода облегания), на столько оболочка отходит от кожи.

import * as THREE from 'three';
import { convexHull, type Figure, type Ring } from './body.ts';
import type { Rig } from './rig.ts';
import type { Category, Fabric, SizeFit } from './sizing.ts';
import { fabricTexture } from './fabrics.ts';

/** Части тела из экспорта (anny-meta.json, partNames). */
const P = { torso: 0, neck: 1, head: 2, upperarm1: 3, upperarm2: 4, lowerarm: 5, hand: 6, upperleg: 7, lowerleg: 8, foot: 9 };

/** Конструктивная свобода: насколько вещь больше тела в середине своего размера, см. */
const DESIGN_EASE: Record<Category, Record<Ring, number>> = {
  top: { chest: 24, waist: 28, hips: 20 },
  bottom: { chest: 0, waist: 1, hips: 3 },
  dress: { chest: 6, waist: 6, hips: 8 },
  outer: { chest: 18, waist: 22, hips: 16 },
};

/** Толщина ткани и свобода рукава/штанины, м. */
const BUILD: Record<Category, { thick: number; sleeve: number; leg: number; collar: number }> = {
  top: { thick: 0.004, sleeve: 0.022, leg: 0, collar: 0.012 },
  bottom: { thick: 0.0025, sleeve: 0, leg: 0.012, collar: 0 },
  dress: { thick: 0.0015, sleeve: 0.008, leg: 0, collar: 0 },
  outer: { thick: 0.014, sleeve: 0.03, leg: 0, collar: 0.022 },
};

/** Юбка платья и низ куртки: длина (доля роста от пола) и расклёш за шаг. */
const SKIRT: Partial<Record<Category, { hem: number; flare: number }>> = {
  dress: { hem: 0.2, flare: 0.006 },
  outer: { hem: 0.36, flare: 0.0015 },
};

export interface Look {
  color: string;
  fabric: Fabric;
  /** Принт спереди: картинка и где она на теле (центр x, y и ширина в м, в осях манекена). */
  print: { image: CanvasImageSource; rect: 'chest' | 'front' } | null;
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

export class Garment {
  readonly category: Category;
  private readonly rig: Rig;
  private readonly parts: string;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms = {
    uColor: { value: new THREE.Color() },
    uFabric: { value: null as THREE.Texture | null },
    uFabricScale: { value: 30 },
    uPrint: { value: null as THREE.Texture | null },
    uPrintRect: { value: new THREE.Vector4(0, 1, 0.2, 0.2) },
    uHasPrint: { value: 0 },
    uTintOn: { value: 1 },
  };
  private shell: THREE.SkinnedMesh;
  private skirt: THREE.SkinnedMesh | null = null;
  private covered: Uint8Array;
  private levels: Levels | null = null;
  private printRect: 'chest' | 'front' = 'chest';

  constructor(rig: Rig, parts: string, category: Category) {
    this.rig = rig;
    this.parts = parts;
    this.category = category;
    this.material = this.makeMaterial();

    const body = rig.meshes[0];
    const src = body.geometry;
    const geo = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) geo.setAttribute(name, src.getAttribute(name));
    geo.morphAttributes.position = src.morphAttributes.position;
    geo.morphAttributes.normal = src.morphAttributes.normal;
    geo.morphTargetsRelative = true;
    const n = src.getAttribute('position').count;
    geo.setAttribute('aOffset', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    this.covered = new Uint8Array(n);
    this.shell = new THREE.SkinnedMesh(geo, this.material);
    this.shell.morphTargetInfluences = [...(body.morphTargetInfluences ?? [])];
    this.shell.morphTargetDictionary = body.morphTargetDictionary;
    this.shell.castShadow = true;
    rig.addMesh(this.shell);
  }

  dispose(): void {
    this.rig.removeMesh(this.shell);
    this.shell.geometry.dispose();
    if (this.skirt) {
      this.rig.removeMesh(this.skirt);
      this.skirt.geometry.dispose();
    }
    this.material.dispose();
  }

  setLook(look: Look): void {
    this.uniforms.uColor.value.set(look.color);
    const fab = fabricTexture(look.fabric);
    this.uniforms.uFabric.value = fab.texture;
    this.uniforms.uFabricScale.value = 1 / fab.tile;
    this.material.roughness = look.fabric === 'quilt' ? 0.45 : 0.85;
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
  rebuild(rest: Float32Array, body: Figure, size: SizeFit, ringY: Record<Ring, number>, tints: Partial<Record<Ring, number>>): void {
    const L = this.measureLevels(rest, ringY);
    const firstTime = !this.levels;
    this.levels = L;
    if (firstTime) this.cover(rest, L);
    this.offsets(rest, L, body, size, tints);
    this.buildSkirt(rest, L, body, size);
    this.updatePrintRect();
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
    const skirt = !!SKIRT[this.category];
    for (let v = 0; v < c.length; v++) {
      const p = +this.parts[v];
      const y = rest[v * 3 + 1];
      const z = rest[v * 3 + 2];
      let on = false;
      // Бока таза в Anny принадлежат костям бедра, поэтому низ верха считаем по торсу и бедру вместе.
      const hipBand = p === P.torso || p === P.upperleg;
      const arm = p === P.upperarm1 || p === P.upperarm2 || p === P.lowerarm;
      switch (this.category) {
        case 'top':
          on = (hipBand && y >= L.hips - 0.012 * L.H) || arm || (p === P.neck && y < L.neck + 0.012 * L.H);
          break;
        case 'outer':
          on = (hipBand && y >= L.hips - 0.03 * L.H) || arm || (p === P.neck && y < L.neck + 0.03 * L.H);
          break;
        case 'bottom':
          on = (p === P.torso && y <= L.waist + 0.006 * L.H) || p === P.upperleg || (p === P.lowerleg && y >= L.ankle + 0.025 * L.H);
          break;
        case 'dress': {
          // U-образный вырез: спереди глубже и шире, чем сзади.
          const x = rest[v * 3];
          const front = z > 0;
          const inNeckline = front
            ? y > L.neck - 0.065 * L.H && Math.abs(x) < 0.055 * L.H * Math.min(1, (y - (L.neck - 0.065 * L.H)) / (0.03 * L.H) + 0.35)
            : y > L.neck - 0.03 * L.H && Math.abs(x) < 0.05 * L.H;
          on = ((hipBand && y >= L.hips - 0.03 * L.H) || p === P.upperarm1) && !inNeckline;
          break;
        }
      }
      if (skirt && (p === P.torso || p === P.upperleg) && y < L.hips - 0.03 * L.H) on = false;
      c[v] = on ? 1 : 0;
    }
    const src = this.rig.meshes[0].geometry.index!.array;
    const idx: number[] = [];
    for (let f = 0; f < src.length; f += 3) {
      if (c[src[f]] && c[src[f + 1]] && c[src[f + 2]]) idx.push(src[f], src[f + 1], src[f + 2]);
    }
    this.shell.geometry.setIndex(idx);
  }

  // ------------------------------------------------------------ отступ от тела

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
    const gap = { chest: this.zoneGap('chest', body, size), waist: this.zoneGap('waist', body, size), hips: this.zoneGap('hips', body, size) };
    const off = (this.shell.geometry.getAttribute('aOffset') as THREE.BufferAttribute).array as Float32Array;
    const tint = (this.shell.geometry.getAttribute('aTint') as THREE.BufferAttribute).array as Float32Array;
    const color = new THREE.Color();
    const band = 0.03 * L.H;

    for (let v = 0; v < off.length; v++) {
      if (!this.covered[v]) continue;
      const p = +this.parts[v];
      const y = rest[v * 3 + 1];
      let o: number;
      if (p === P.torso) o = torsoGap(y, L, gap);
      else if (p === P.neck) o = b.collar;
      else if (p === P.upperleg || p === P.lowerleg) {
        // От бёдер к колену штанина сужается до свободы штанины, дальше прямая.
        const t = THREE.MathUtils.clamp((L.hips - y) / Math.max(0.01, L.hips - L.knee), 0, 1);
        o = THREE.MathUtils.lerp(gap.hips, b.leg, t);
      } else o = b.sleeve;
      off[v] = o + b.thick;

      // Подсветка посадки на ткани: те же пояса, что на теле.
      let w = 0;
      tint.fill(0, v * 4, v * 4 + 4);
      for (const r of ['chest', 'waist', 'hips'] as Ring[]) {
        const hex = tints[r];
        if (hex === undefined || (p !== P.torso && !(r === 'hips' && p === P.upperleg))) continue;
        const d = Math.abs(y - L[r]);
        if (d >= band) continue;
        const k = 1 - (d / band) ** 2;
        if (k > w) {
          w = k;
          color.setHex(hex);
          tint.set([color.r, color.g, color.b, 0.6 * k], v * 4);
        }
      }
    }
    this.shell.geometry.getAttribute('aOffset').needsUpdate = true;
    this.shell.geometry.getAttribute('aTint').needsUpdate = true;
  }

  // ------------------------------------------------------------ юбка

  /** Юбка от бёдер до подола: по каждой высоте обходит тело (обе ноги) с запасом и не сужается. */
  private buildSkirt(rest: Float32Array, L: Levels, body: Figure, size: SizeFit): void {
    const spec = SKIRT[this.category];
    if (!spec) return;
    const N = 72;
    const rows = 16;
    // Верх юбки прячется под лиф: начинается на линии бёдер, лиф кончается ниже.
    const top = L.hips + 0.005 * L.H;
    const hem = spec.hem * L.H;
    const gap = this.zoneGap('hips', body, size) + BUILD[this.category].thick;

    // Центр — по кольцу бёдер.
    let cx = 0, cz = 0, cnt = 0;
    for (let v = 0; v < this.covered.length; v++) {
      const p = +this.parts[v];
      if (p !== P.torso && p !== P.upperleg) continue;
      if (Math.abs(rest[v * 3 + 1] - L.hips) < 0.01 * L.H) {
        cx += rest[v * 3];
        cz += rest[v * 3 + 2];
        cnt++;
      }
    }
    cx /= cnt || 1;
    cz /= cnt || 1;

    const radii: Float32Array[] = [];
    let prev: Float32Array | null = null;
    for (let k = 0; k <= rows; k++) {
      const y = top + ((hem - top) * k) / rows;
      const pts: [number, number][] = [];
      for (let v = 0; v < this.covered.length; v++) {
        const p = +this.parts[v];
        if (p !== P.torso && p !== P.upperleg && p !== P.lowerleg) continue;
        if (Math.abs(rest[v * 3 + 1] - y) < 0.012 * L.H) pts.push([rest[v * 3] - cx, rest[v * 3 + 2] - cz]);
      }
      const r = new Float32Array(N);
      const hull = pts.length >= 3 ? convexHull(pts) : null;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const own = hull ? rayHull(hull, Math.cos(a), Math.sin(a)) + gap : 0;
        r[i] = prev ? Math.max(own, prev[i] + spec.flare) : own;
      }
      radii.push(r);
      prev = r;
    }

    const pos = new Float32Array((rows + 1) * N * 3);
    const skinIndex = new Uint16Array((rows + 1) * N * 4);
    const skinWeight = new Float32Array((rows + 1) * N * 4);
    const rig = this.rig;
    const root = rig.boneIndex('root');
    const legL = rig.boneIndex('upperleg01.L');
    const legR = rig.boneIndex('upperleg01.R');
    const halfWidth = Math.max(...radii[0]) || 0.15;
    for (let k = 0; k <= rows; k++) {
      const y = top + ((hem - top) * k) / rows;
      const t = k / rows;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const x = cx + Math.cos(a) * radii[k][i];
        const z = cz + Math.sin(a) * radii[k][i];
        const j = k * N + i;
        pos.set([x, y, z], j * 3);
        // Низ юбки идёт за бёдрами, верх — за тазом. Перёд ложится на бёдра (сидя — на колени),
        // спинка больше висит с таза.
        const front = THREE.MathUtils.clamp(0.5 + (z - cz) / (2 * (radii[k][i] || 0.1)), 0, 1);
        const legW = Math.min(0.95, t * 1.6) * (0.3 + 0.7 * front);
        const sideL = THREE.MathUtils.clamp(0.5 + (0.5 * (x - cx) * rig.left) / (halfWidth * 0.6), 0, 1);
        skinIndex.set([root, legL, legR, 0], j * 4);
        skinWeight.set([1 - legW, legW * sideL, legW * (1 - sideL), 0], j * 4);
      }
    }
    const index: number[] = [];
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < N; i++) {
        const a = k * N + i, b = k * N + ((i + 1) % N), c = a + N, d = b + N;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geo.setAttribute('aOffset', new THREE.BufferAttribute(new Float32Array(pos.length / 3), 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
    geo.setIndex(index);
    geo.computeVertexNormals();
    // Обход по углу идёт против часовой, если смотреть сверху: нормали наружу проверяем и при нужде переворачиваем.
    const n0 = geo.getAttribute('normal');
    if (n0.getX(0) * Math.cos(0) + n0.getZ(0) * Math.sin(0) < 0) {
      for (let f = 0; f < index.length; f += 3) [index[f + 1], index[f + 2]] = [index[f + 2], index[f + 1]];
      geo.setIndex(index);
      geo.computeVertexNormals();
    }

    if (this.skirt) {
      this.skirt.geometry.dispose();
      this.skirt.geometry = geo;
    } else {
      this.skirt = new THREE.SkinnedMesh(geo, this.material);
      this.skirt.castShadow = true;
      rig.addMesh(this.skirt);
    }
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
    // Фото вещи растягиваем на всю закрытую вещью переднюю часть (в A-позе, как на раскладке).
    const pos = this.rig.meshes[0].geometry.getAttribute('position');
    const box = new THREE.Box2();
    for (let v = 0; v < this.covered.length; v++) {
      if (this.covered[v]) box.expandByPoint(new THREE.Vector2(pos.getX(v), pos.getY(v)));
    }
    const spec = SKIRT[this.category];
    if (spec) box.expandByPoint(new THREE.Vector2(box.min.x, spec.hem * L.H));
    const c = box.getCenter(new THREE.Vector2());
    const s = box.getSize(new THREE.Vector2());
    rect.set(c.x, c.y, s.x, s.y);
  }

  private makeMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const u = this.uniforms;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aOffset;
attribute vec4 aTint;
varying vec3 vRest;
varying vec3 vRestN;
varying vec4 vTint;`)
        .replace('#include <morphnormal_vertex>', `#include <morphnormal_vertex>
vec3 restNormal = normalize(objectNormal);`)
        .replace('#include <morphtarget_vertex>', `#include <morphtarget_vertex>
vRest = transformed;
vRestN = restNormal;
vTint = aTint;
transformed += restNormal * aOffset;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uColor;
uniform sampler2D uFabric;
uniform float uFabricScale;
uniform sampler2D uPrint;
uniform vec4 uPrintRect;
uniform float uHasPrint;
uniform float uTintOn;
varying vec3 vRest;
varying vec3 vRestN;
varying vec4 vTint;`)
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
    };
    m.customProgramCacheKey = () => 'garment-v1';
    return m;
  }
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

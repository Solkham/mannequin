// Сцена Three.js: манекен на скелете, позы (стоит, идёт, сидит, лежит), четыре ракурса,
// свет и тень, подсветка зон посадки с бирками, табурет и коврик.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RINGS, type BodyData, type Fit, type Ring } from './body.ts';
import { Rig, type Pose } from './rig.ts';
import type { Surroundings } from './garment.ts';

export type View = 'front' | 'back' | 'left' | 'right';
/** Позы сцены: позы скелета плюс «показ» — проход по подиуму к зрителю и поворот. */
export type StagePose = Pose | 'show';

/** Показ: длина подиума (м), скорость шага (м/с) и тайминги поворота (с). */
const SHOW = { distance: 3.2, speed: 1.05, pause: 0.6, turnHalf: 2.2, holdBack: 1.2, holdFront: 1.0 };
export type { Pose };

/** Тона кожи на выбор (от светлого к тёмному). */
export const SKIN_TONES = [
  { name: 'светлый', hex: '#f0d2bf' },
  { name: 'светло-бежевый', hex: '#e2b597' },
  { name: 'средний', hex: '#c98f6c' },
  { name: 'смуглый', hex: '#9c6646' },
  { name: 'тёмный', hex: '#6a412f' },
];
const EYE = { sclera: 0xf2efea, iris: 0x5a3d24, pupil: 0x0b0806 };
const RING_COLOR = 0x2f4a3a;
// Цвета зон те же, что в интерфейсе (--ok, --warn, --bad).
export const TONE_COLOR = { ok: 0x2e7d4f, warn: 0xc98a1b, bad: 0xb3372c } as const;
// Насколько сильно зона перекрашивает кожу в центре пояса.
const TINT = 0.7;

export type Tone = keyof typeof TONE_COLOR;
export type Zones = Partial<Record<Ring, { tone: Tone; text: string }>>;

export interface LoadedBody {
  mesh: THREE.SkinnedMesh;
  data: Omit<BodyData, 'rings' | 'density'>;
}

/** Атрибут (в т.ч. нормализованный int16 с шагом) → Float32Array x y z подряд, в единицах сцены. */
function toFloat3(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if (a.array instanceof Float32Array && !('isInterleavedBufferAttribute' in a)) return a.array;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    out[i * 3] = a.getX(i);
    out[i * 3 + 1] = a.getY(i);
    out[i * 3 + 2] = a.getZ(i);
  }
  return out;
}

/**
 * Глаза: вершины глазных яблок (вес кости глаза > 0.5) делим на белок, радужку и зрачок
 * по направлению от центра глаза: вперёд смотрит радужка, в самом центре — зрачок.
 * 0 — кожа, 1 — белок, 2 — радужка, 3 — зрачок.
 */
function eyeMask(mesh: THREE.SkinnedMesh): Uint8Array {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones.map((b) => b.name);
  // Three.js при загрузке убирает точки из имён узлов: eye.L → eyeL.
  const eyes = ['eye.L', 'eye.R'].map((n) => bones.indexOf(THREE.PropertyBinding.sanitizeNodeName(n))).filter((i) => i >= 0);
  const n = pos.count;
  const owner = new Int8Array(n).fill(-1);
  const sum = eyes.map(() => new THREE.Vector3());
  const cnt = eyes.map(() => 0);
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 4; k++) {
      const e = eyes.indexOf(si.getComponent(v, k));
      if (e >= 0 && sw.getComponent(v, k) > 0.5) {
        owner[v] = e;
        sum[e].add(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)));
        cnt[e]++;
      }
    }
  }
  const centers = sum.map((s, e) => s.divideScalar(cnt[e] || 1));
  const out = new Uint8Array(n);
  const d = new THREE.Vector3();
  for (let v = 0; v < n; v++) {
    const e = owner[v];
    if (e < 0) continue;
    d.set(pos.getX(v), pos.getY(v), pos.getZ(v)).sub(centers[e]).normalize();
    out[v] = d.z > 0.965 ? 3 : d.z > 0.86 ? 2 : 1;
  }
  return out;
}

export async function loadBody(url: string): Promise<LoadedBody> {
  const gltf = await new GLTFLoader().loadAsync(url);
  let mesh: THREE.SkinnedMesh | undefined;
  gltf.scene.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error(`В ${url} нет сетки со скелетом`);
  const geo = mesh.geometry;
  const dict = mesh.morphTargetDictionary ?? {};
  const names = Object.keys(dict).sort((a, b) => dict[a] - dict[b]);
  // Цвет кожи, глаза и подсветка зон живут в цвете вершин, материал белый.
  // Кожа: физическая модель с бархатистым отблеском (sheen) — как у живой кожи, не пластик.
  mesh.material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.52, metalness: 0,
    sheen: 0.55, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xffb8a8), specularIntensity: 0.4,
  });
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
  mesh.userData.eyes = eyeMask(mesh);
  mesh.castShadow = true;
  mesh.removeFromParent();
  return {
    mesh,
    data: {
      base: geo.attributes.position.array as Float32Array,
      // Морфы в файле квантованы (int16, KHR_mesh_quantization): для расчётов — в метры.
      deltas: (geo.morphAttributes.position ?? []).map(toFloat3),
      names,
      index: geo.index!.array,
    },
  };
}

export class Stage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  private readonly controls: OrbitControls;
  private readonly host: HTMLElement;
  private readonly rings = new Map<Ring, THREE.LineLoop>();
  private readonly tags = new Map<Ring, HTMLSpanElement>();
  private readonly stool: THREE.Group;
  private readonly mat: THREE.Mesh;
  private readonly runway: THREE.Mesh;
  private readonly timer = new THREE.Timer();

  rig: Rig | null = null;
  private names: string[] = [];
  private fit: Fit | null = null;
  private weights: Record<Ring, Float32Array> | null = null;
  private anchors: Record<Ring, string> | null = null;
  private zones: Zones = {};
  private pose: StagePose = 'stand';
  private dressed = false;
  private azimuthGoal: number | null = null;
  private framedFor = '';
  /** Вызывается после смены формы тела: одежде нужно перестроиться. */
  onRebuild: (() => void) | null = null;
  /** Каждый кадр после позы: шаг симуляции ткани. */
  onFrame: ((dt: number) => void) | null = null;
  /** Поза сменилась скачком (не ходьба по кадрам). */
  onPose: (() => void) | null = null;
  /** Верх сиденья табурета в мире (для позы «сидит»). */
  private seatTop = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // Мягкие тени (дисперсионные карты): края тени размыты, как от студийного софтбокса.
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    host.prepend(this.renderer.domElement);

    // Студийное окружение: отражения и рассеянный свет со всех сторон, как в фотостудии.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xfffaf2, 0xcfc4b2, 0.9));
    const key = new THREE.DirectionalLight(0xfff4e8, 2.1);
    key.position.set(1.2, 3, 2.2);
    key.castShadow = true;
    // Тень и на всей дорожке подиума.
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
    key.shadow.bias = -0.0004;
    key.shadow.radius = 7;
    key.shadow.blurSamples = 16;
    this.scene.add(key, key.target);
    // Контровой холодный свет сзади-сбоку: отделяет силуэт от фона.
    const rim = new THREE.DirectionalLight(0xe8f0ff, 1.1);
    rim.position.set(-2, 2.5, -2);
    this.scene.add(rim);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 64), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Табурет для позы «сидит» и коврик для «лежит»: высоту ставим под фигуру.
    const wood = new THREE.MeshStandardMaterial({ color: 0xb08a63, roughness: 0.6 });
    this.stool = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 40), wood);
    seat.name = 'seat';
    seat.castShadow = seat.receiveShadow = true;
    this.stool.add(seat);
    for (let i = 0; i < 4; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 12), wood);
      leg.name = 'leg';
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      leg.position.set(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14);
      leg.castShadow = true;
      this.stool.add(leg);
    }
    this.stool.visible = false;
    this.scene.add(this.stool);
    // Дорожка подиума для показа: от глубины сцены к зрителю.
    this.runway = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, SHOW.distance + 1.2),
      new THREE.MeshStandardMaterial({ color: 0xd9cfbf, roughness: 0.95 }),
    );
    this.runway.rotation.x = -Math.PI / 2;
    this.runway.position.set(0, 0.002, -SHOW.distance / 2);
    this.runway.receiveShadow = true;
    this.runway.visible = false;
    this.scene.add(this.runway);
    this.mat = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.03, 2.1),
      new THREE.MeshStandardMaterial({ color: 0x9fb3a6, roughness: 0.9 }),
    );
    this.mat.position.y = 0.015;
    this.mat.receiveShadow = true;
    this.mat.visible = false;
    this.scene.add(this.mat);

    for (const r of RINGS) {
      const line = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: RING_COLOR }));
      line.matrixAutoUpdate = false;
      line.renderOrder = 1;
      this.rings.set(r, line);

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.hidden = true;
      host.append(tag);
      this.tags.set(r, tag);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = Math.PI * 0.15;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    this.controls.addEventListener('start', () => (this.azimuthGoal = null));

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Новая фигура (смена пола). weights — пояса зон для этой сетки. */
  setBody(rig: Rig, names: string[], weights: Record<Ring, Float32Array>): void {
    if (this.rig) this.scene.remove(this.rig.group);
    this.rig = rig;
    this.names = names;
    this.weights = weights;
    this.anchors = null;
    this.scene.add(rig.group);
    for (const line of this.rings.values()) rig.group.add(line);
    this.paint();
  }

  /** Подсветка зон и бирки: зона без записи не подсвечивается и показывает линию замера. */
  setZones(zones: Zones): void {
    this.zones = zones;
    for (const r of RINGS) {
      const z = zones[r];
      const tag = this.tags.get(r)!;
      tag.hidden = !z;
      if (z) {
        tag.className = `tag ${z.tone}`;
        tag.textContent = z.text;
      }
    }
    this.syncRingVisibility();
    this.paint();
  }

  /** Одета ли вещь: тогда линии замера не рисуем поверх ткани. */
  setDressed(on: boolean): void {
    this.dressed = on;
    this.syncRingVisibility();
  }

  /** Линии замера видны там, где нет вердикта, только раздетым и только когда манекен стоит. */
  private syncRingVisibility(): void {
    for (const r of RINGS) this.rings.get(r)!.visible = !this.zones[r] && this.pose === 'stand' && !this.dressed;
  }

  private skinTone = SKIN_TONES[1].hex;

  setSkinTone(hex: string): void {
    this.skinTone = hex;
    this.paint();
  }

  private paint(): void {
    const body = this.rig?.meshes[0];
    if (!body || !this.weights) return;
    const attr = body.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = attr.array as Float32Array;
    const skin = new THREE.Color(this.skinTone);
    const eyes = body.userData.eyes as Uint8Array | undefined;
    const eyeCol = [null, new THREE.Color(EYE.sclera), new THREE.Color(EYE.iris), new THREE.Color(EYE.pupil)];
    const tones = RINGS.map((r) => {
      const z = this.zones[r];
      return z ? { w: this.weights![r], color: new THREE.Color(TONE_COLOR[z.tone]) } : null;
    });
    for (let v = 0; v < attr.count; v++) {
      const e = eyes?.[v] ?? 0;
      if (e) {
        const ec = eyeCol[e]!;
        c[v * 3] = ec.r; c[v * 3 + 1] = ec.g; c[v * 3 + 2] = ec.b;
        continue;
      }
      let r = skin.r, g = skin.g, b = skin.b;
      for (const t of tones) {
        const k = t ? t.w[v] * TINT : 0;
        if (k <= 0) continue;
        r += (t!.color.r - r) * k;
        g += (t!.color.g - g) * k;
        b += (t!.color.b - b) * k;
      }
      c[v * 3] = r;
      c[v * 3 + 1] = g;
      c[v * 3 + 2] = b;
    }
    attr.needsUpdate = true;
  }

  /** Новая форма тела: морфы, суставы, масштаб, кольца замеров. */
  update(fit: Fit): void {
    const rig = this.rig;
    if (!rig) return;
    this.fit = fit;
    rig.setShape(fit.influences, this.names);
    for (const m of rig.meshes) {
      const inf = m.morphTargetInfluences;
      if (inf) for (let i = 0; i < inf.length; i++) inf[i] = fit.influences[i];
    }
    this.anchors ??= this.pickAnchors();

    for (const r of RINGS) {
      const { y, points } = fit.measures.hulls[r];
      // Лента чуть отступает от кожи, чтобы не тонуть в ней.
      const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
      const cz = points.reduce((s, p) => s + p[1], 0) / points.length;
      const arr = new Float32Array(points.length * 3);
      points.forEach(([x, z], i) => {
        const d = Math.hypot(x - cx, z - cz) || 1;
        arr.set([x + ((x - cx) / d) * 0.003, y, z + ((z - cz) / d) * 0.003], i * 3);
      });
      const line = this.rings.get(r)!;
      line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      line.geometry.computeBoundingSphere();
    }
    this.onRebuild?.();
    this.place(this.elapsed());
  }

  get currentFit(): Fit | null {
    return this.fit;
  }

  /** Показ закончился: манекен стоит лицом к зрителю. */
  onShowEnd: (() => void) | null = null;

  setPose(pose: StagePose): void {
    this.pose = pose;
    this.showDone = false;
    this.timer.update();
    this.poseStart = this.timer.getElapsed();
    this.syncRingVisibility();
    this.place(0);
    this.onPose?.();
  }

  setView(view: View): void {
    this.azimuthGoal = this.azimuthFor(view);
  }

  private azimuthFor(view: View): number {
    const left = this.rig?.left ?? 1;
    // Камера на +X видит ту сторону человека, что смотрит в +X.
    const side = left > 0 ? Math.PI / 2 : -Math.PI / 2;
    return { front: 0, back: Math.PI, left: side, right: -side }[view];
  }

  /** Кость, за которой следует кольцо замера в позах: ближайшая по высоте кость спины. */
  private pickAnchors(): Record<Ring, string> {
    const rig = this.rig!;
    const fit = this.fit!;
    const spine = ['root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01'];
    const out = {} as Record<Ring, string>;
    for (const r of RINGS) {
      const y = fit.measures.hulls[r].y;
      out[r] = spine.reduce((a, b) => (Math.abs(rig.head(b).y - y) < Math.abs(rig.head(a).y - y) ? b : a));
    }
    return out;
  }

  /** Поза, положение на полу, мебель, камера. t — время анимации. */
  private place(t: number): void {
    const rig = this.rig;
    const fit = this.fit;
    if (!rig || !fit) return;
    const s = fit.scale;
    const { minY, maxY, minZ } = fit.measures.rest;
    const H = maxY - minY;
    const g = rig.group;
    g.scale.setScalar(s);

    const show = this.pose === 'show' ? this.showState(t) : null;
    const drop = rig.pose(show ? show.pose : (this.pose as Pose), show ? show.t : t);
    this.stool.visible = this.pose === 'sit';
    this.mat.visible = this.pose === 'lie';
    this.runway.visible = this.pose === 'show';

    // Камера следует за моделью по подиуму: цель и камера сдвигаются вместе с ней,
    // ракурс, который выбрал человек (вращение, приближение), сохраняется.
    const follow = show ? show.z : 0;
    const dz = follow - this.followZ;
    if (dz !== 0) {
      this.controls.target.z += dz;
      this.camera.position.z += dz;
      this.followZ = follow;
    }

    if (show) {
      g.rotation.set(0, show.yaw, 0);
      g.position.set(0, (drop - minY) * s, show.z);
    } else if (this.pose === 'lie') {
      // На спину: лицо вверх (+Z → +Y), голова от камеры. Спина на коврике.
      g.rotation.set(-Math.PI / 2, 0, 0);
      g.position.set(0, -minZ * s + 0.03, (H / 2 + minY) * s);
    } else {
      g.rotation.set(0, 0, 0);
      g.position.set(0, (drop - minY) * s, 0);
    }
    if (this.pose === 'sit') {
      // Сиденье чуть ниже тазобедренного сустава: под ягодицами.
      const hip = (rig.boneY('upperleg01.L') + rig.boneY('upperleg01.R')) / 2;
      const seatTop = (hip + drop - minY - 0.075 * H) * s;
      const back = Math.min(rig.bonePos('upperleg01.L').z, rig.bonePos('upperleg01.R').z) * s;
      this.stool.position.set(0, 0, back + 0.02);
      this.seatTop.set(0, seatTop, back + 0.02);
      for (const c of this.stool.children) {
        if (c.name === 'seat') c.position.y = seatTop - 0.02;
        else {
          c.scale.y = seatTop - 0.04;
          c.position.y = (seatTop - 0.04) / 2;
        }
      }
    }
    g.updateMatrixWorld(true);

    if (this.anchors) {
      for (const r of RINGS) rig.boneDeform(this.anchors[r], this.rings.get(r)!.matrix);
    }
    const key = `${this.pose}:${H.toFixed(3)}:${s.toFixed(3)}`;
    if (key !== this.framedFor) {
      this.framedFor = key;
      this.frameCamera();
    }
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.framedFor = '';
    if (this.fit) this.place(this.elapsed());
    else this.frameBox(1.7, 0.85, 0.62);
  }

  /** Камера целиком показывает манекен в текущей позе. */
  private frameCamera(): void {
    const fit = this.fit!;
    const H = (fit.measures.rest.maxY - fit.measures.rest.minY) * fit.scale;
    if (this.pose === 'sit') this.frameBox(H * 0.78, H * 0.38, H * 0.62);
    else if (this.pose === 'lie') this.frameBox(H * 0.62, H * 0.12, H * 1.1, true);
    else this.frameBox(H, H * 0.5, H * 0.62);
  }

  private frameBox(height: number, centerY: number, width: number, fromAbove = false): void {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max((height * 1.12) / (2 * tan), (width * 1.05) / (2 * tan * this.camera.aspect));
    const target = new THREE.Vector3(0, centerY, this.followZ);
    const az = this.camera.position.lengthSq() > 0 ? this.controls.getAzimuthalAngle() : 0;
    const polar = fromAbove ? Math.PI * 0.3 : Math.PI * 0.48;
    const offset = new THREE.Vector3().setFromSphericalCoords(dist, polar, az);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.controls.minDistance = dist * 0.45;
    this.controls.maxDistance = dist * 1.6;
    this.controls.update();
  }

  /** Время с начала текущей позы, с. (Timer.reset() в Three.js не обнуляет getElapsed.) */
  private poseStart = 0;
  private elapsed(): number {
    return this.timer.getElapsed() - this.poseStart;
  }

  /** Пол и сиденье для ткани: юбка ложится на них. */
  surroundings(): Surroundings {
    return {
      floorY: this.pose === 'lie' ? 0.03 : 0,
      seat: this.pose === 'sit' ? { center: this.seatTop.clone(), r: 0.2 } : null,
    };
  }

  /**
   * Где манекен в показе в момент t: идёт к зрителю, останавливается, поворачивается спиной,
   * держит паузу, доворачивается лицом. Потом показ кончается сам.
   */
  private showState(t: number): { pose: Pose; t: number; z: number; yaw: number } {
    const walkTime = SHOW.distance / SHOW.speed;
    if (t < walkTime) return { pose: 'walk', t, z: -SHOW.distance + SHOW.speed * t, yaw: 0 };
    let u = t - walkTime - SHOW.pause;
    const ease = (x: number) => x * x * (3 - 2 * x);
    if (u < 0) return { pose: 'stand', t: 0, z: 0, yaw: 0 };
    if (u < SHOW.turnHalf) return { pose: 'stand', t: 0, z: 0, yaw: Math.PI * ease(u / SHOW.turnHalf) };
    u -= SHOW.turnHalf;
    if (u < SHOW.holdBack) return { pose: 'stand', t: 0, z: 0, yaw: Math.PI };
    u -= SHOW.holdBack;
    if (u < SHOW.turnHalf) return { pose: 'stand', t: 0, z: 0, yaw: Math.PI * (1 + ease(u / SHOW.turnHalf)) };
    u -= SHOW.turnHalf;
    if (u > SHOW.holdFront && !this.showDone) {
      this.showDone = true;
      queueMicrotask(() => this.onShowEnd?.());
    }
    return { pose: 'stand', t: 0, z: 0, yaw: 0 };
  }

  private showDone = false;
  /** Насколько камера сдвинута за моделью вдоль подиума. */
  private followZ = 0;

  private frame(): void {
    this.timer.update();
    if (this.pose === 'walk' || this.pose === 'show') this.place(this.elapsed());
    if (this.fit) this.onFrame?.(Math.min(this.timer.getDelta(), 1 / 20));
    if (this.azimuthGoal !== null) {
      const cur = this.controls.getAzimuthalAngle();
      const diff = Math.atan2(Math.sin(this.azimuthGoal - cur), Math.cos(this.azimuthGoal - cur));
      if (Math.abs(diff) < 0.002) this.azimuthGoal = null;
      else {
        const offset = this.camera.position.clone().sub(this.controls.target);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), diff * 0.15);
        this.camera.position.copy(this.controls.target).add(offset);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.placeTags();
  }

  /** Бирка встаёт справа от самой правой на экране точки пояса (с учётом позы). */
  private placeTags(): void {
    const fit = this.fit;
    const rig = this.rig;
    if (!fit || !rig || !this.anchors) return;
    const { clientWidth: W, clientHeight: H } = this.host;
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const r of RINGS) {
      const tag = this.tags.get(r)!;
      if (tag.hidden) continue;
      const { y, points } = fit.measures.hulls[r];
      m.multiplyMatrices(rig.group.matrixWorld, this.rings.get(r)!.matrix);
      let sx = -Infinity;
      let sy = 0;
      for (const [x, z] of points) {
        v.set(x, y, z).applyMatrix4(m).project(this.camera);
        const px = (v.x * 0.5 + 0.5) * W;
        if (px > sx) {
          sx = px;
          sy = (-v.y * 0.5 + 0.5) * H;
        }
      }
      const left = Math.min(sx + 10, W - tag.offsetWidth - 8);
      tag.style.transform = `translate(${Math.round(left)}px, ${Math.round(sy - tag.offsetHeight / 2)}px)`;
    }
  }
}

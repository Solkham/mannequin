// Сцена Three.js: манекен, свет, тень на полу, кольца замеров, вид спереди и сбоку.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RINGS, type BodyData, type Fit, type Ring } from './body.ts';

export type View = 'front' | 'side';

const SKIN = 0xe4dbcd;
const RING_COLOR = 0x2f4a3a;

export interface LoadedBody {
  mesh: THREE.Mesh;
  data: Omit<BodyData, 'rings' | 'density'>;
}

export async function loadBody(url: string): Promise<LoadedBody> {
  const gltf = await new GLTFLoader().loadAsync(url);
  let mesh: THREE.Mesh | undefined;
  gltf.scene.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) throw new Error(`В ${url} нет сетки`);
  const geo = mesh.geometry;
  const dict = mesh.morphTargetDictionary ?? {};
  const names = Object.keys(dict).sort((a, b) => dict[a] - dict[b]);
  mesh.material = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.72, metalness: 0 });
  mesh.castShadow = true;
  mesh.removeFromParent();
  return {
    mesh,
    data: {
      base: geo.attributes.position.array as Float32Array,
      deltas: (geo.morphAttributes.position ?? []).map((a) => a.array as Float32Array),
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
  private readonly key: THREE.DirectionalLight;
  private readonly rings = new Map<Ring, THREE.LineLoop>();
  private mesh: THREE.Mesh | null = null;
  private heightM = 1.7;
  private azimuthGoal: number | null = null;
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    host.prepend(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xfffaf2, 0xcfc4b2, 1.9));
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.position.set(1.2, 3, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.5, far: 8 });
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xfff3e0, 0.7);
    rim.position.set(-2, 2.5, -2);
    this.scene.add(rim);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 48), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    for (const r of RINGS) {
      const line = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: RING_COLOR }));
      line.renderOrder = 1;
      this.rings.set(r, line);
      this.scene.add(line);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = Math.PI * 0.2;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    this.controls.addEventListener('start', () => (this.azimuthGoal = null));

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setBody(mesh: THREE.Mesh): void {
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = mesh;
    this.scene.add(mesh);
  }

  update(fit: Fit): void {
    if (!this.mesh) return;
    const inf = this.mesh.morphTargetInfluences!;
    for (let i = 0; i < inf.length; i++) inf[i] = fit.influences[i];
    this.mesh.scale.setScalar(fit.scale);
    this.mesh.position.y = -fit.measures.minY;

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

    const h = fit.measures.height / 100;
    if (Math.abs(h - this.heightM) > 0.005) {
      this.heightM = h;
      this.frameCamera(false);
    }
  }

  setView(view: View): void {
    this.azimuthGoal = view === 'front' ? 0 : Math.PI / 2;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera(true);
  }

  /** Камера целиком показывает манекен: по высоте и по ширине с разведёнными руками. */
  private frameCamera(resetAngle: boolean): void {
    const H = this.heightM;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max((H * 1.12) / (2 * tan), (H * 0.62) / (2 * tan * this.camera.aspect));
    const target = new THREE.Vector3(0, H * 0.5, 0);
    const offset = resetAngle
      ? new THREE.Vector3(0, H * 0.04, 1)
      : this.camera.position.clone().sub(this.controls.target);
    offset.setLength(dist);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.controls.minDistance = dist * 0.45;
    this.controls.maxDistance = dist * 1.6;
    this.controls.update();
  }

  private frame(): void {
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
  }
}

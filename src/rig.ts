// Скелет манекена: кости подгоняются под фигуру (морфы двигают суставы),
// позы задаются направлениями сегментов тела в осях манекена.
//
// Оси манекена (rig space): Y вверх, лицо в +Z, левая рука человека в сторону side.L.
// Кости из экспорта без поворотов, только сдвиги, поэтому в позе покоя (A-поза)
// локальные оси каждой кости совпадают с осями манекена.

import * as THREE from 'three';

export type Pose = 'stand' | 'walk' | 'sit' | 'lie';
type Side = 'L' | 'R';

export interface BonesMeta {
  names: string[];
  parents: number[];
  heads: number[];
  headDeltas: Record<string, number[]>;
}

/** Направить сегмент кости (от её головы к голове кости to) по вектору dir. */
interface Aim {
  bone: string;
  to: string;
  dir: THREE.Vector3;
}

export class Rig {
  readonly group = new THREE.Group();
  readonly bones: THREE.Bone[];
  readonly meshes: THREE.SkinnedMesh[] = [];
  private readonly meta: BonesMeta;
  private readonly index = new Map<string, number>();
  /** Головы костей текущей фигуры (без масштаба), xyz подряд. */
  readonly heads: Float32Array;
  /** Знак X левой стороны человека. */
  readonly left: number;
  private readonly skeleton: THREE.Skeleton;
  /** Последняя поза: после пересчёта привязки её нужно вернуть. */
  private last: { pose: Pose; t: number } | null = null;

  constructor(body: THREE.SkinnedMesh, meta: BonesMeta) {
    this.meta = meta;
    this.skeleton = body.skeleton;
    this.bones = body.skeleton.bones;
    meta.names.forEach((n, i) => this.index.set(n, i));
    this.heads = new Float32Array(meta.heads);
    this.left = Math.sign(this.head('shoulder01.L').x) || 1;

    const root = this.bones[meta.parents.indexOf(-1)];
    body.position.set(0, 0, 0);
    this.group.add(body, root);
    this.addMesh(body);
  }

  /** Ещё одна сетка на этом же скелете (одежда). */
  addMesh(mesh: THREE.SkinnedMesh): void {
    mesh.frustumCulled = false;
    if (mesh !== this.meshes[0] && mesh.parent !== this.group) this.group.add(mesh);
    mesh.bind(this.skeleton, new THREE.Matrix4());
    this.meshes.push(mesh);
    this.rebind();
  }

  removeMesh(mesh: THREE.SkinnedMesh): void {
    const i = this.meshes.indexOf(mesh);
    if (i > 0) this.meshes.splice(i, 1);
    this.group.remove(mesh);
  }

  boneIndex(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`Нет кости ${name}`);
    return i;
  }

  head(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const i = this.boneIndex(name) * 3;
    return out.set(this.heads[i], this.heads[i + 1], this.heads[i + 2]);
  }

  /** Подогнать суставы под фигуру: те же влияния морфов, что у сетки. */
  setShape(influences: ArrayLike<number>, targetNames: string[]): void {
    this.heads.set(this.meta.heads);
    targetNames.forEach((name, t) => {
      const k = influences[t];
      const d = this.meta.headDeltas[name];
      if (!k || !d) return;
      for (let i = 0; i < d.length; i++) this.heads[i] += k * d[i];
    });
    this.rebind();
  }

  /** Кости в покой на новых местах, пересчёт привязки сеток. */
  private rebind(): void {
    const { parents } = this.meta;
    this.bones.forEach((b, i) => {
      const p = parents[i];
      b.position.set(
        this.heads[i * 3] - (p >= 0 ? this.heads[p * 3] : 0),
        this.heads[i * 3 + 1] - (p >= 0 ? this.heads[p * 3 + 1] : 0),
        this.heads[i * 3 + 2] - (p >= 0 ? this.heads[p * 3 + 2] : 0),
      );
      b.quaternion.identity();
    });
    // Привязка в осях группы: группа на время пересчёта без масштаба и сдвига.
    const saved = this.group.matrix.clone();
    const parent = this.group.parent;
    this.group.removeFromParent();
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.setScalar(1);
    this.group.updateMatrixWorld(true);
    this.skeleton.calculateInverses();
    for (const m of this.meshes) {
      m.bindMatrix.identity();
      m.bindMatrixInverse.identity();
    }
    saved.decompose(this.group.position, this.group.quaternion, this.group.scale);
    parent?.add(this.group);
    this.group.updateMatrixWorld(true);
    if (this.last) this.pose(this.last.pose, this.last.t);
  }

  // ------------------------------------------------------------ позы

  /** Позы: все кости в покой, затем прицелы сегментов сверху вниз по дереву. */
  private applyAims(aims: Aim[]): void {
    const { parents } = this.meta;
    const byBone = new Map(aims.map((a) => [this.boneIndex(a.bone), a]));
    const world: THREE.Quaternion[] = [];
    const rest = new THREE.Vector3();
    const cur = new THREE.Vector3();
    const tmp = new THREE.Quaternion();
    this.bones.forEach((b, i) => {
      const pw = parents[i] >= 0 ? world[parents[i]] : new THREE.Quaternion();
      const aim = byBone.get(i);
      if (!aim) {
        b.quaternion.identity();
        world[i] = pw.clone();
        return;
      }
      this.head(aim.to, rest).sub(this.head(aim.bone, cur)).normalize();
      cur.copy(rest).applyQuaternion(pw);
      const r = tmp.setFromUnitVectors(cur, aim.dir.clone().normalize());
      const w = r.clone().multiply(pw);
      world[i] = w;
      b.quaternion.copy(pw.clone().invert().multiply(w));
    });
  }

  private dir(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).normalize();
  }

  private arms(side: Side, upper: THREE.Vector3, fore: THREE.Vector3): Aim[] {
    return [
      { bone: `upperarm01.${side}`, to: `lowerarm01.${side}`, dir: upper },
      { bone: `lowerarm01.${side}`, to: `wrist.${side}`, dir: fore },
    ];
  }

  private leg(side: Side, thigh: THREE.Vector3, shin: THREE.Vector3, foot: THREE.Vector3): Aim[] {
    return [
      { bone: `upperleg01.${side}`, to: `lowerleg01.${side}`, dir: thigh },
      { bone: `lowerleg01.${side}`, to: `foot.${side}`, dir: shin },
      { bone: `foot.${side}`, to: `toe3-1.${side}`, dir: foot },
    ];
  }

  /** Направление вниз под углом a (рад) вперёд, с разводом в сторону. */
  private down(side: Side, a: number, spread: number): THREE.Vector3 {
    const s = side === 'L' ? this.left : -this.left;
    return this.dir(s * spread, -Math.cos(a), Math.sin(a));
  }

  /** Направление сегмента в покое: стопа так и остаётся ровной. */
  private restDir(bone: string, to: string): THREE.Vector3 {
    return this.head(to).sub(this.head(bone)).normalize();
  }

  /**
   * Поставить позу. t — время в секундах (для ходьбы).
   * Возвращает, насколько опустить манекен (в осях манекена), чтобы стопы стояли на полу.
   */
  pose(pose: Pose, t = 0): number {
    this.last = { pose, t };
    const aims: Aim[] = [];
    const flatFoot = (side: Side) => this.restDir(`foot.${side}`, `toe3-1.${side}`);

    if (pose === 'stand' || pose === 'lie') {
      for (const side of ['L', 'R'] as Side[]) {
        // Руки чуть отведены: кисти не проходят сквозь юбку и низ куртки.
        aims.push(...this.arms(side, this.down(side, 0.03, 0.2), this.down(side, 0.12, 0.2)));
      }
    } else if (pose === 'walk') {
      const phase = (t / 1.1) * Math.PI * 2;
      for (const side of ['L', 'R'] as Side[]) {
        const p = side === 'L' ? phase : phase + Math.PI;
        const thigh = 0.38 * Math.sin(p);
        // колено сгибается, когда нога идёт вперёд по воздуху
        const knee = 0.12 + 0.55 * Math.max(0, Math.sin(p + 1.1)) ** 2;
        const shin = thigh - knee;
        aims.push(...this.leg(side, this.down(side, thigh, 0.05), this.down(side, shin, 0.03), flatFoot(side)));
        const arm = -0.3 * Math.sin(p);
        aims.push(...this.arms(side, this.down(side, arm, 0.2), this.down(side, arm + 0.25, 0.18)));
      }
    } else if (pose === 'sit') {
      for (const side of ['L', 'R'] as Side[]) {
        aims.push(...this.leg(side, this.down(side, 1.45, 0.12), this.down(side, 0.08, 0.06), flatFoot(side)));
        aims.push(...this.arms(side, this.down(side, 0.35, 0.16), this.down(side, 1.25, 0.05)));
      }
    }
    this.applyAims(aims);
    this.group.updateMatrixWorld(true);

    if (pose === 'lie') return 0;
    // Стопа, что ниже, — на полу, как в покое.
    const restAnkle = Math.min(this.head('foot.L').y, this.head('foot.R').y);
    return restAnkle - Math.min(this.boneY('foot.L'), this.boneY('foot.R'));
  }

  /** Высота сустава в осях манекена (без масштаба группы). */
  boneY(name: string): number {
    return this.bonePos(name).y;
  }

  bonePos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const b = this.bones[this.boneIndex(name)];
    b.getWorldPosition(out);
    return this.group.worldToLocal(out);
  }

  /** Матрица кость·обратная привязка в осях манекена: переносит точку покоя в позу. */
  boneDeform(name: string, out = new THREE.Matrix4()): THREE.Matrix4 {
    return this.boneDeformAt(this.boneIndex(name), out);
  }

  /** То же по номеру кости (как в skinIndex сетки). */
  boneDeformAt(i: number, out = new THREE.Matrix4()): THREE.Matrix4 {
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    return out.multiplyMatrices(inv, this.bones[i].matrixWorld).multiply(this.skeleton.boneInverses[i]);
  }
}

// Проверка подбора фигуры на настоящих моделях из public/models.
// Запуск: npm test

import { readFileSync } from 'node:fs';
import { BodyModel, type BodyData, type Figure, type Gender } from '../src/body.ts';

const dir = new URL('../public/models/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('anny-meta.json', dir), 'utf8'));

function loadGlb(file: string): Omit<BodyData, 'rings' | 'density'> {
  const buf = readFileSync(new URL(file, dir));
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const read = (i: number) => {
    const acc = gltf.accessors[i];
    const view = gltf.bufferViews[acc.bufferView];
    const n = acc.count * (acc.type === 'VEC3' ? 3 : 1);
    const start = binStart + view.byteOffset;
    const bytes = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + view.byteLength);
    if (acc.componentType === 5126) return new Float32Array(bytes, 0, n);
    if (acc.componentType === 5123) return new Uint16Array(bytes, 0, n);
    return new Uint32Array(bytes, 0, n);
  };
  const mesh = gltf.meshes[0];
  const prim = mesh.primitives[0];
  return {
    base: read(prim.attributes.POSITION) as Float32Array,
    deltas: prim.targets.map((t: { POSITION: number }) => read(t.POSITION) as Float32Array),
    names: mesh.extras.targetNames,
    index: read(prim.indices),
  };
}

const cases: [string, Gender, Figure][] = [
  ['худая женщина', 'female', { height: 160, weight: 50, chest: 82, waist: 62, hips: 88 }],
  ['средняя женщина', 'female', { height: 168, weight: 64, chest: 92, waist: 74, hips: 100 }],
  ['плюс-сайз женщина', 'female', { height: 168, weight: 82, chest: 104, waist: 88, hips: 112 }],
  ['большой плюс-сайз женщина', 'female', { height: 165, weight: 110, chest: 124, waist: 110, hips: 132 }],
  ['средний мужчина', 'male', { height: 178, weight: 78, chest: 98, waist: 84, hips: 98 }],
  ['плюс-сайз мужчина', 'male', { height: 182, weight: 115, chest: 120, waist: 112, hips: 116 }],
];

let failed = 0;
const models = new Map<Gender, BodyModel>();
for (const [label, gender, fig] of cases) {
  const g = meta.genders[gender];
  if (!models.has(gender)) {
    models.set(gender, new BodyModel({ ...loadGlb(g.file), rings: g.rings, density: meta.density }));
  }
  const model = models.get(gender)!;

  // Базовая сетка меряется так же, как в Python-экспорте.
  const base = model.measure({ height: 0, weight: 0, chest: 0, waist: 0, hips: 0 });
  for (const k of ['chest', 'waist', 'hips'] as const) {
    if (Math.abs(base[k] - g.base[k] * 100) > 0.05) {
      console.error(`FAIL ${gender}: замер ${k} ${base[k].toFixed(2)} ≠ ${(g.base[k] * 100).toFixed(2)} из экспорта`);
      failed++;
    }
  }

  const t0 = performance.now();
  const fit = model.fit(fig);
  const ms = performance.now() - t0;
  const m = fit.measures;
  const errs = {
    height: m.height - fig.height,
    chest: m.chest - fig.chest,
    waist: m.waist - fig.waist,
    hips: m.hips - fig.hips,
    weight: m.weight - fig.weight,
  };
  // Рост и обхваты должны совпасть до сантиметра. Вес — мягкая цель, только печатаем.
  const ok = ['height', 'chest', 'waist', 'hips'].every((k) => Math.abs(errs[k as keyof typeof errs]) <= 1);
  if (!ok) failed++;
  const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(26)} рост ${fmt(errs.height)}  грудь ${fmt(errs.chest)}  ` +
      `талия ${fmt(errs.waist)}  бёдра ${fmt(errs.hips)}  вес ${fmt(errs.weight)} кг  ` +
      `(${ms.toFixed(0)} мс; ${Object.entries(fit.shape).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`,
  );
}

if (failed) {
  console.error(`${failed} проверок не прошли`);
  process.exit(1);
}

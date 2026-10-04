// Проверка симуляции ткани: юбка на двух ногах-капсулах.
// Запуск: npm test

import { Cloth, type ClothEnv, type SkirtDesign } from '../src/cloth.ts';

const cols = 96;
const top = new Float32Array(cols * 3);
for (let i = 0; i < cols; i++) {
  const a = (i / cols) * Math.PI * 2;
  top.set([Math.cos(a) * 0.17, 0.9, Math.sin(a) * 0.13], i * 3);
}
const design: SkirtDesign = { rows: 22, cols, top, center: [0, 0.9, 0], length: 0.55, flare: 1.5, stiffness: 0.05, folds: 9 };
const legs = [-0.09, 0.09].map((x) => ({ a: [x, 0.85, 0] as [number, number, number], b: [x, 0.1, 0] as [number, number, number], r: 0.07 }));
const env: ClothEnv = { gravity: [0, -9.8, 0], capsules: legs, planes: [{ n: [0, 1, 0], c: 0 }], disks: [] };

const cloth = new Cloth(design);
const t0 = performance.now();
for (let s = 0; s < 240; s++) cloth.step(1 / 60, env);
const ms = (performance.now() - t0) / 240;

const p = cloth.pos;
const hem = design.rows * cols;
let hemY = 0, minLegDist = Infinity;
const radii: number[] = [];
for (let i = 0; i < cols; i++) {
  const j = (hem + i) * 3;
  hemY += p[j + 1] / cols;
  radii.push(Math.hypot(p[j], p[j + 2]));
}
for (let v = cols; v < p.length / 3; v++) {
  for (const leg of legs) {
    const y = Math.min(leg.a[1], Math.max(leg.b[1], p[v * 3 + 1]));
    minLegDist = Math.min(minLegDist, Math.hypot(p[v * 3] - leg.a[0], p[v * 3 + 1] - y, p[v * 3 + 2]) - leg.r);
  }
}
// Складки: подол волнится — радиус то больше, то меньше по кругу.
const mean = radii.reduce((s, r) => s + r, 0) / cols;
const wobble = Math.sqrt(radii.reduce((s, r) => s + (r - mean) ** 2, 0) / cols);
let turns = 0;
for (let i = 0; i < cols; i++) {
  const a = radii[i] - radii[(i + cols - 1) % cols];
  const b = radii[(i + 1) % cols] - radii[i];
  if (a > 0 && b <= 0) turns++;
}

const checks: [string, boolean, string][] = [
  ['подол опустился под тяжестью', hemY < 0.9 - 0.45, `подол на ${hemY.toFixed(3)} м`],
  ['ткань не проходит сквозь ноги', minLegDist > -0.002, `ближе всего ${(minLegDist * 1000).toFixed(1)} мм`],
  ['подол собрался в складки', wobble > 0.006 && turns >= 5, `разброс ${(wobble * 1000).toFixed(1)} мм, складок ${turns}`],
  ['шаг укладывается в кадр', ms < 8, `${ms.toFixed(2)} мс на шаг`],
];
let failed = 0;
for (const [label, ok, info] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ткань: ${label.padEnd(32)} ${info}`);
}
if (failed) {
  console.error(`${failed} проверок не прошли`);
  process.exit(1);
}

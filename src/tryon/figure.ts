// Тело по меркам: 3D-модель Anny подгоняется под рост, вес и обхваты и снимается спереди
// в полный рост. Этот снимок — «болванка» для фото человека: сервис превращает её в живого
// человека ровно этой фигуры, а потом надевает на него вещь.

import { BodyModel, ZERO_SHAPE, zoneWeights, type Figure, type Gender } from '../body.ts';
import { Stage, loadBody } from '../stage.ts';
import { Rig, type BonesMeta } from '../rig.ts';

interface GenderMeta {
  file: string;
  rings: BodyModel['data']['rings'];
  bones: BonesMeta;
}
interface Meta {
  density: number;
  genders: Record<Gender, GenderMeta>;
}

let stage: Stage | null = null;
let meta: Promise<Meta> | null = null;
const bodies = new Map<Gender, Promise<{ model: BodyModel; rig: Rig; names: string[]; weights: ReturnType<typeof zoneWeights> }>>();

function body(models: string, gender: Gender) {
  let p = bodies.get(gender);
  if (!p) {
    p = (async () => {
      meta ??= fetch(`${models}anny-meta.json`).then((r) => r.json());
      const m = await meta;
      const g = m.genders[gender];
      const loaded = await loadBody(`${models}${g.file}`);
      const model = new BodyModel({ ...loaded.data, rings: g.rings, density: m.density });
      return { model, rig: new Rig(loaded.mesh, g.bones), names: loaded.data.names, weights: zoneWeights({ base: loaded.data.base, rings: g.rings }) };
    })();
    bodies.set(gender, p);
  }
  return p;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** Снимок тела по меркам (JPEG data URL, 2:3) и что получилось на самом деле. */
export async function figureShot(models: string, gender: Gender, figure: Figure): Promise<{ image: string; weight: number }> {
  if (!stage) {
    // Сцена вне экрана: пользователь её не видит, нужен только кадр.
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:576px;height:864px;pointer-events:none';
    document.body.append(host);
    stage = new Stage(host);
  }
  const b = await body(models, gender);
  stage.setBody(b.rig, b.names, b.weights);
  stage.setDressed(true);
  stage.setZones({});
  const fit = b.model.fit(figure, { ...ZERO_SHAPE });
  stage.update(fit);
  stage.setPose('stand');
  stage.setView('front');
  // Пара кадров: камера доезжает до ракурса, тени ложатся.
  for (let i = 0; i < 40; i++) await frame();
  return { image: stage.snapshot(), weight: fit.measures.weight };
}

import { BodyModel, ZERO_SHAPE, zoneWeights, type Figure, type Fit, type Gender, type Ring, type Shape } from './body.ts';
import { Stage, loadBody, type LoadedBody, type Pose, type Tone, type View, type Zones } from './stage.ts';
import { Rig, type BonesMeta } from './rig.ts';
import { ZONE_NAME, chipLabel, evaluate, sizeName, zoneLabel, type Item, type Status } from './sizing.ts';
import itemsJson from './data/items.json';

const ITEMS = itemsJson as Item[];

const MODELS = `${import.meta.env.BASE_URL}models/`;
const STORAGE_KEY = 'mannequin:figure:v1';

const SLIDERS: { key: keyof Figure; label: string; min: number; max: number; unit: string }[] = [
  { key: 'height', label: 'Рост', min: 140, max: 210, unit: 'см' },
  { key: 'weight', label: 'Вес', min: 35, max: 180, unit: 'кг' },
  { key: 'chest', label: 'Грудь', min: 70, max: 150, unit: 'см' },
  { key: 'waist', label: 'Талия', min: 55, max: 140, unit: 'см' },
  { key: 'hips', label: 'Бёдра', min: 75, max: 160, unit: 'см' },
];

const DEFAULTS: Record<Gender, Figure> = {
  female: { height: 168, weight: 82, chest: 104, waist: 88, hips: 112 },
  male: { height: 178, weight: 80, chest: 100, waist: 88, hips: 100 },
};

interface Saved {
  gender: Gender;
  figures: Record<Gender, Figure>;
  item: string;
}

function loadSaved(): Saved {
  const fallback: Saved = { gender: 'female', figures: structuredClone(DEFAULTS), item: ITEMS[0].id };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Saved;
    const ok = (f: Figure | undefined) => !!f && SLIDERS.every((d) => Number.isFinite(f[d.key]));
    return {
      gender: s.gender === 'male' ? 'male' : 'female',
      figures: {
        female: ok(s.figures?.female) ? s.figures.female : DEFAULTS.female,
        male: ok(s.figures?.male) ? s.figures.male : DEFAULTS.male,
      },
      item: ITEMS.some((i) => i.id === s.item) ? s.item : ITEMS[0].id,
    };
  } catch {
    return fallback;
  }
}

function save(state: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим или запрет хранилища: просто не запоминаем.
  }
}

const state = loadSaved();
const stage = new Stage(document.getElementById('stage')!);
const loading = document.getElementById('loading')!;
const fact = document.getElementById('fact')!;

// Ползунки
const inputs = new Map<keyof Figure, { input: HTMLInputElement; output: HTMLOutputElement }>();
const sliderBox = document.getElementById('sliders')!;
for (const d of SLIDERS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label for="s-${d.key}">${d.label}</label>
    <input id="s-${d.key}" type="range" min="${d.min}" max="${d.max}" step="1">
    <output for="s-${d.key}"></output>`;
  sliderBox.append(row);
  const input = row.querySelector('input')!;
  const output = row.querySelector('output')!;
  inputs.set(d.key, { input, output });
  input.addEventListener('input', () => {
    state.figures[state.gender][d.key] = Number(input.value);
    output.textContent = `${input.value} ${d.unit}`;
    schedule();
  });
}

function syncInputs(): void {
  const f = state.figures[state.gender];
  for (const d of SLIDERS) {
    const { input, output } = inputs.get(d.key)!;
    input.value = String(f[d.key]);
    output.textContent = `${f[d.key]} ${d.unit}`;
  }
}

// Модели: грузим по требованию и держим обе в памяти
interface Body extends LoadedBody {
  model: BodyModel;
  rig: Rig;
  meta: GenderMeta;
  shape: Shape;
  weights: Record<Ring, Float32Array>;
}
interface GenderMeta {
  file: string;
  rings: BodyModel['data']['rings'];
  parts: string;
  bones: BonesMeta;
}
let meta: { density: number; partNames: string[]; genders: Record<Gender, GenderMeta> } | null = null;
const bodies = new Map<Gender, Promise<Body>>();

function getBody(gender: Gender): Promise<Body> {
  let p = bodies.get(gender);
  if (!p) {
    p = (async () => {
      meta ??= await fetch(`${MODELS}anny-meta.json`).then((r) => r.json());
      const g = meta!.genders[gender];
      const loaded = await loadBody(`${MODELS}${g.file}`);
      const model = new BodyModel({ ...loaded.data, rings: g.rings, density: meta!.density });
      const weights = zoneWeights({ base: loaded.data.base, rings: g.rings });
      const rig = new Rig(loaded.mesh, g.bones);
      return { ...loaded, model, rig, meta: g, shape: { ...ZERO_SHAPE }, weights };
    })();
    bodies.set(gender, p);
  }
  return p;
}

let current: Body | null = null;
let pending = false;

function schedule(): void {
  save(state);
  renderVerdict();
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    refit();
  });
}

function refit(): void {
  if (!current) return;
  const target = state.figures[state.gender];
  const fit = current.model.fit(target, current.shape);
  current.shape = fit.shape;
  stage.update(fit);
  showFact(target, fit);
}

function showFact(target: Figure, fit: Fit): void {
  const m = fit.measures;
  const r = (v: number) => Math.round(v);
  const off = (['chest', 'waist', 'hips'] as const).filter((k) => Math.abs(m[k] - target[k]) > 1);
  const kgDiff = m.weight - target.weight;
  let warn = '';
  if (off.length) {
    const names = { chest: 'груди', waist: 'талии', hips: 'бёдер' };
    warn = `Обхват ${off.map((k) => names[k]).join(', ')} вне диапазона модели, показан ближайший возможный.`;
  } else if (Math.abs(kgDiff) > 3) {
    warn =
      kgDiff < 0
        ? `Манекен легче введённого на ${r(-kgDiff)} кг: полнее модель сделать не может. Обхваты точные, для размера важны они.`
        : `Манекен тяжелее введённого на ${r(kgDiff)} кг: при таких обхватах стройнее модель не бывает.`;
  }
  fact.innerHTML =
    `Манекен сейчас: рост <b>${r(m.height)}</b>, грудь <b>${r(m.chest)}</b>, талия <b>${r(m.waist)}</b>, ` +
    `бёдра <b>${r(m.hips)}</b> см, вес <b>≈${r(m.weight)}</b> кг` +
    (warn ? `<span class="warn">${warn}</span>` : '');
}

// Вещь и вердикт по размеру
const itemsBox = document.getElementById('items')!;
const verdictBox = document.getElementById('verdict')!;
/** Размер, который человек выбрал сам; null — показываем лучший. */
let pickedSize: string | null = null;

const ZONE_TONE: Record<Status, Tone> = { ok: 'ok', snug: 'warn', loose: 'warn', big: 'warn', tight: 'bad' };

function renderItems(): void {
  itemsBox.replaceChildren(
    ...ITEMS.map((item) => {
      const b = document.createElement('button');
      b.className = 'item';
      const has = !!item.charts[state.gender];
      b.disabled = !has;
      b.setAttribute('aria-pressed', String(item.id === state.item && has));
      const note = has ? `${item.shop} · ${item.material}` : `${item.shop} · нет ${state.gender === 'male' ? 'мужской' : 'женской'} сетки`;
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b')!.textContent = item.title;
      b.querySelector('span')!.textContent = note;
      b.addEventListener('click', () => {
        state.item = item.id;
        pickedSize = null;
        save(state);
        renderItems();
        renderVerdict();
      });
      return b;
    }),
  );
}

function renderVerdict(): void {
  const item = ITEMS.find((i) => i.id === state.item)!;
  const v = evaluate(item, state.gender, state.figures[state.gender]);
  if (!v) {
    verdictBox.innerHTML = `<div class="verdict none"><h3>Нет сетки</h3><p></p></div>`;
    verdictBox.querySelector('p')!.textContent = `У вещи «${item.title}» нет ${state.gender === 'male' ? 'мужской' : 'женской'} размерной сетки. Выберите другую вещь.`;
    stage.setZones({});
    return;
  }

  let shown = v.sizes.findIndex((s) => s.size.label === pickedSize);
  if (shown < 0) shown = v.best;
  const sel = v.sizes[shown];

  const wrap = document.createElement('div');
  wrap.className = `verdict ${v.tone}`;
  wrap.innerHTML = `<h3></h3><p></p><div class="sizes" role="group" aria-label="Размеры"></div>`;
  wrap.querySelector('h3')!.textContent = v.title;
  wrap.querySelector('p')!.textContent = v.text;
  const row = wrap.querySelector('.sizes')!;
  v.sizes.forEach((s, i) => {
    const chip = chipLabel(s, i === v.best);
    const b = document.createElement('button');
    b.className = `size ${chip.tone}${i === v.best ? ' best' : ''}`;
    b.setAttribute('aria-pressed', String(i === shown));
    b.title = `${sizeName(s.size)}: ${s.zones.map((z) => `${ZONE_NAME[z.zone].toLowerCase()} ${zoneLabel(z)}`).join(', ')}`;
    b.innerHTML = `<span></span><small></small>`;
    b.querySelector('span')!.textContent = s.size.label;
    b.querySelector('small')!.textContent = chip.text;
    b.addEventListener('click', () => {
      pickedSize = s.size.label;
      renderVerdict();
    });
    row.append(b);
  });

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `На манекене: ${sizeName(sel.size)}${shown === v.best ? ', лучший' : ''}. Нажмите на другой размер, чтобы примерить его.`;
  const src = document.createElement('p');
  src.className = 'src';
  src.textContent = `${item.source} Это подсказка по обхватам, а не гарантия.`;
  verdictBox.replaceChildren(wrap, hint, src);

  const zones: Zones = {};
  for (const z of sel.zones) zones[z.zone] = { tone: ZONE_TONE[z.status], text: `${ZONE_NAME[z.zone]}: ${zoneLabel(z)}` };
  stage.setZones(zones);
}

async function showGender(gender: Gender): Promise<void> {
  state.gender = gender;
  save(state);
  document.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.gender === gender));
  });
  syncInputs();
  renderItems();
  pickedSize = null;
  renderVerdict();
  loading.hidden = false;
  try {
    const body = await getBody(gender);
    if (state.gender !== gender) return;
    current = body;
    stage.setBody(body.rig, body.data.names, body.weights);
    refit();
    loading.hidden = true;
  } catch (e) {
    loading.textContent = 'Не удалось загрузить манекен. Обновите страницу.';
    console.error(e);
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach((b) => {
  b.addEventListener('click', () => showGender(b.dataset.gender as Gender));
});

document.querySelectorAll<HTMLButtonElement>('[data-pose]').forEach((b) => {
  b.addEventListener('click', () => {
    stage.setPose(b.dataset.pose as Pose);
    document.querySelectorAll('[data-pose]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    stage.setView(b.dataset.view as View);
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
});

showGender(state.gender);

import { BodyModel, ZERO_SHAPE, zoneWeights, type Figure, type Fit, type Gender, type Ring, type Shape } from './body.ts';
import { Stage, loadBody, type LoadedBody, type Pose, type Tone, type View, type Zones } from './stage.ts';
import { Rig, type BonesMeta } from './rig.ts';
import { ZONE_NAME, chipLabel, evaluate, sizeName, zoneLabel, type Category, type Item, type SizeFit, type Status } from './sizing.ts';
import { Garment, type Look } from './garment.ts';
import { badgePrint } from './fabrics.ts';
import { loadPhoto, type PhotoPrint } from './photo.ts';
import { TONE_COLOR } from './stage.ts';
import itemsJson from './data/items.json';

const ITEMS = itemsJson as Item[];

const MODELS = `${import.meta.env.BASE_URL}models/`;
const STORAGE_KEY = 'mannequin:figure:v1';
const PHOTO_KEY = 'mannequin:photo:v1';

const CATEGORY_NAME: Record<Category, string> = {
  top: 'Футболка, худи, свитер',
  bottom: 'Брюки, джинсы',
  dress: 'Платье',
  outer: 'Куртка, пуховик',
};

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
  /** Выбранный цвет каждой вещи: индекс в item.colors. */
  colors: Record<string, number>;
  /** Тип своей вещи (по фото). */
  custom: Category;
  /** Красить посадку цветом поверх ткани. */
  tint: boolean;
}

function loadSaved(): Saved {
  const fallback: Saved = {
    gender: 'female', figures: structuredClone(DEFAULTS), item: ITEMS[0].id, colors: {}, custom: 'top', tint: false,
  };
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
      item: s.item === 'custom' || ITEMS.some((i) => i.id === s.item) ? s.item : ITEMS[0].id,
      colors: typeof s.colors === 'object' && s.colors ? s.colors : {},
      custom: s.custom && s.custom in CATEGORY_NAME ? s.custom : 'top',
      tint: s.tint === true,
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

let photo: PhotoPrint | null = null;
let photoVersion = 0;

/** Своя вещь: стандартная сетка выбранного типа, цвет и рисунок — с фото человека. */
function customItem(): Item {
  const base = ITEMS.find((i) => i.category === state.custom)!;
  return {
    ...base,
    id: 'custom',
    title: 'Своя вещь',
    shop: photo ? 'по вашему фото' : 'загрузите фото',
    material: CATEGORY_NAME[state.custom].toLowerCase(),
    fabric: 'plain',
    print: undefined,
    colors: [{ name: 'с фото', hex: photo?.color ?? '#8a8f99' }],
    source: `Стандартная российская сетка для типа «${CATEGORY_NAME[state.custom]}».`,
  };
}

function currentItem(): Item {
  return state.item === 'custom' ? customItem() : ITEMS.find((i) => i.id === state.item)!;
}

const extrasBox = document.getElementById('item-extras')!;

function renderItems(): void {
  itemsBox.replaceChildren(
    ...[...ITEMS, customItem()].map((item) => {
      const b = document.createElement('button');
      b.className = 'item';
      const has = !!item.charts[state.gender];
      b.disabled = !has && item.id !== 'custom';
      b.setAttribute('aria-pressed', String(item.id === state.item));
      const note = has || item.id === 'custom'
        ? `${item.shop} · ${item.material}`
        : `${item.shop} · нет ${state.gender === 'male' ? 'мужской' : 'женской'} сетки`;
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
  renderExtras();
}

/** Под вещами: цвета на выбор или загрузка своего фото. */
function renderExtras(): void {
  const item = currentItem();
  extrasBox.replaceChildren();
  if (item.id === 'custom') {
    extrasBox.innerHTML = `
      <div class="custom">
        <label class="field">Тип вещи <select id="custom-type"></select></label>
        <label class="upload chip">Загрузить фото вещи<input id="custom-photo" type="file" accept="image/*" hidden></label>
        <p class="hint">Фото спереди на светлом однотонном фоне: вещь лежит или висит. Цвет и рисунок перейдут на манекен. Фото остаётся у вас на устройстве.</p>
      </div>`;
    const sel = extrasBox.querySelector<HTMLSelectElement>('#custom-type')!;
    for (const [k, v] of Object.entries(CATEGORY_NAME)) sel.add(new Option(v, k, false, k === state.custom));
    sel.addEventListener('change', () => {
      state.custom = sel.value as Category;
      pickedSize = null;
      save(state);
      renderItems();
      renderVerdict();
    });
    extrasBox.querySelector<HTMLInputElement>('#custom-photo')!.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      photo = await loadPhoto(file);
      photoVersion++;
      try {
        localStorage.setItem(PHOTO_KEY, photo.canvas.toDataURL('image/png'));
      } catch {
        // Не влезло в хранилище: фото будет до перезагрузки.
      }
      renderItems();
      renderVerdict();
    });
    return;
  }
  const row = document.createElement('div');
  row.className = 'colors';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Цвет');
  const chosen = state.colors[item.id] ?? 0;
  const label = document.createElement('span');
  label.className = 'colors-label';
  label.textContent = `Цвет: ${item.colors[chosen]?.name ?? ''}`;
  row.append(label);
  item.colors.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-pressed', String(i === chosen));
    b.addEventListener('click', () => {
      state.colors[item.id] = i;
      save(state);
      renderExtras();
      dressUp();
    });
    row.append(b);
  });
  extrasBox.append(row);
}

// ------------------------------------------------------------ вещь на манекене

let garment: Garment | null = null;
let garmentKey = '';
let garmentRig: Rig | null = null;
let lookKey = '';
let shownSize: SizeFit | null = null;
let shownTints: Partial<Record<Ring, number>> = {};

function lookFor(item: Item): Look {
  if (item.id === 'custom') {
    return { color: photo?.color ?? '#8a8f99', fabric: 'plain', print: photo ? { image: photo.canvas, rect: 'front' } : null };
  }
  const color = item.colors[state.colors[item.id] ?? 0]?.hex ?? item.colors[0].hex;
  const light = parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16) > 420;
  return {
    color,
    fabric: item.fabric,
    print: item.print === 'badge' ? { image: badgePrint(light ? '#2b2b2d' : '#f4efe6'), rect: 'chest' } : null,
  };
}

/** Надеть выбранную вещь в выбранном размере (или снять, если сетки нет). */
function dressUp(): void {
  if (!current) return;
  const item = currentItem();
  stage.setDressed(!!shownSize);
  if (!shownSize) {
    garment?.dispose();
    garment = null;
    garmentKey = '';
    return;
  }
  const key = `${state.gender}:${item.category}`;
  // Вещь живёт на скелете конкретной фигуры: сменился пол — шьём заново.
  if (!garment || key !== garmentKey || garmentRig !== current.rig) {
    garment?.dispose();
    garment = new Garment(current.rig, current.meta.parts, item.category);
    garmentKey = key;
    garmentRig = current.rig;
    lookKey = '';
  }
  const g = garment;
  const lk = `${item.id}:${state.colors[item.id] ?? 0}:${photoVersion}:${item.category}`;
  if (lk !== lookKey) {
    g.setLook(lookFor(item));
    lookKey = lk;
  }
  g.setTintVisible(state.tint);
  rebuildGarment();
}

function rebuildGarment(): void {
  const fit = stage.currentFit;
  if (!garment || !current || !fit || !shownSize) return;
  const h = fit.measures.hulls;
  garment.rebuild(
    current.model.blend(current.shape),
    state.figures[state.gender],
    shownSize,
    { chest: h.chest.y, waist: h.waist.y, hips: h.hips.y },
    shownTints,
    stage.surroundings(),
  );
}
stage.onRebuild = rebuildGarment;
stage.onFrame = (dt) => garment?.frame(dt, stage.surroundings());
stage.onPose = () => garment?.drapeForPose(stage.surroundings());

function renderVerdict(): void {
  const item = currentItem();
  const v = evaluate(item, state.gender, state.figures[state.gender]);
  if (!v) {
    shownSize = null;
    dressUp();
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
  const tint = document.createElement('label');
  tint.className = 'toggle';
  tint.innerHTML = `<input type="checkbox"> Показывать посадку цветом на вещи`;
  const box = tint.querySelector('input')!;
  box.checked = state.tint;
  box.addEventListener('change', () => {
    state.tint = box.checked;
    save(state);
    garment?.setTintVisible(state.tint);
  });
  verdictBox.replaceChildren(wrap, hint, tint, src);

  const zones: Zones = {};
  shownTints = {};
  for (const z of sel.zones) {
    const tone = ZONE_TONE[z.status];
    zones[z.zone] = { tone, text: `${ZONE_NAME[z.zone]}: ${zoneLabel(z)}` };
    shownTints[z.zone] = TONE_COLOR[tone];
  }
  stage.setZones(zones);
  shownSize = sel;
  dressUp();
}

async function showGender(gender: Gender): Promise<void> {
  state.gender = gender;
  save(state);
  document.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.gender === gender));
  });
  syncInputs();
  // Пока грузится новая фигура, старую не одеваем.
  current = null;
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
    dressUp();
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

// Сохранённое фото своей вещи: уже вырезано, только найти цвет.
(async () => {
  try {
    const url = localStorage.getItem(PHOTO_KEY);
    if (url) {
      photo = await loadPhoto(url, false);
      photoVersion++;
      renderItems();
      renderVerdict();
    }
  } catch {
    // Нет хранилища или битая картинка: без фото.
  }
})();

showGender(state.gender);


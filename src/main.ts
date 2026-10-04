import { BodyModel, ZERO_SHAPE, type Figure, type Fit, type Gender, type Shape } from './body.ts';
import { Stage, loadBody, type LoadedBody, type View } from './stage.ts';

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
}

function loadSaved(): Saved {
  const fallback: Saved = { gender: 'female', figures: structuredClone(DEFAULTS) };
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
  shape: Shape;
}
let meta: { density: number; genders: Record<Gender, { file: string; rings: BodyModel['data']['rings'] }> } | null = null;
const bodies = new Map<Gender, Promise<Body>>();

function getBody(gender: Gender): Promise<Body> {
  let p = bodies.get(gender);
  if (!p) {
    p = (async () => {
      meta ??= await fetch(`${MODELS}anny-meta.json`).then((r) => r.json());
      const g = meta!.genders[gender];
      const loaded = await loadBody(`${MODELS}${g.file}`);
      const model = new BodyModel({ ...loaded.data, rings: g.rings, density: meta!.density });
      return { ...loaded, model, shape: { ...ZERO_SHAPE } };
    })();
    bodies.set(gender, p);
  }
  return p;
}

let current: Body | null = null;
let pending = false;

function schedule(): void {
  save(state);
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

async function showGender(gender: Gender): Promise<void> {
  state.gender = gender;
  save(state);
  document.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.gender === gender));
  });
  syncInputs();
  loading.hidden = false;
  try {
    const body = await getBody(gender);
    if (state.gender !== gender) return;
    current = body;
    stage.setBody(body.mesh);
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

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    stage.setView(b.dataset.view as View);
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
});

showGender(state.gender);

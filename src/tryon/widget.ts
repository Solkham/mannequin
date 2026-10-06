// Окно «Примерить на себя» для карточки товара. Живёт в Shadow DOM: стили маркетплейса
// его не ломают, его стили — маркетплейс. Профиль (мерки, фото) хранится только в браузере.
//
// Поток: мерки (+ своё фото по желанию) → фото человека этой фигуры → вещь из карточки на нём
// + совет по размеру по стандартной российской сетке.

import type { Figure, Gender } from '../body.ts';
import { evaluate, sizeName, zoneLabel, ZONE_NAME, type Item } from '../sizing.ts';
import itemsJson from '../data/items.json';
import { avatarPrompt, makeAvatar, tryOn, type GarmentCategory } from './api.ts';
import { figureShot } from './figure.ts';
import { CSS } from './widget.css.ts';

const ITEMS = itemsJson as Item[];

/** Тип вещи: какая сетка размеров и что сервис примерки заменяет (верх, низ, целиком). */
export const KINDS = {
  tee: { name: 'Футболка', chart: 'tee', category: 'tops' },
  shirt: { name: 'Рубашка', chart: 'shirt', category: 'tops' },
  hoodie: { name: 'Худи, свитшот', chart: 'hoodie', category: 'tops' },
  tunic: { name: 'Туника, блузка', chart: 'tunic', category: 'tops' },
  jacket: { name: 'Куртка', chart: 'puffer', category: 'tops' },
  jeans: { name: 'Джинсы, брюки', chart: 'jeans', category: 'bottoms' },
  shorts: { name: 'Шорты', chart: 'shorts', category: 'bottoms' },
  skirt: { name: 'Юбка', chart: 'skirt', category: 'bottoms' },
  dress: { name: 'Платье', chart: 'dress', category: 'one-pieces' },
} as const satisfies Record<string, { name: string; chart: string; category: GarmentCategory }>;
export type Kind = keyof typeof KINDS;

export interface Product {
  /** Фото товара: ссылка (как в карточке маркетплейса) или data URL. */
  image: string;
  title: string;
  kind: Kind;
}

export interface Options {
  /** Адрес прокси примерки (worker/). Пусто — покажем фигуру по меркам и совет по размеру. */
  endpoint: string;
  /** Где лежат модели тела (anny-*.glb, anny-meta.json), со слешем в конце. */
  models: string;
}

type PhotoKind = 'full' | 'face';
interface Profile {
  gender: Gender;
  figure: Figure;
  photo?: { kind: PhotoKind; data: string };
  /** Готовое фото человека этой фигуры: ключ — от чего оно сделано. */
  avatar?: { key: string; url: string };
}

const KEY = 'mannequin-tryon-profile';
const DEFAULTS: Record<Gender, Figure> = {
  female: { height: 166, weight: 62, chest: 92, waist: 74, hips: 100 },
  male: { height: 178, weight: 78, chest: 100, waist: 86, hips: 100 },
};
const FIELDS: { key: keyof Figure; label: string; unit: string; min: number; max: number }[] = [
  { key: 'height', label: 'Рост', unit: 'см', min: 140, max: 205 },
  { key: 'weight', label: 'Вес', unit: 'кг', min: 38, max: 160 },
  { key: 'chest', label: 'Обхват груди', unit: 'см', min: 70, max: 150 },
  { key: 'waist', label: 'Обхват талии', unit: 'см', min: 55, max: 150 },
  { key: 'hips', label: 'Обхват бёдер', unit: 'см', min: 75, max: 160 },
];

function loadProfile(): Profile | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Profile | null;
    return p && p.figure && (p.gender === 'female' || p.gender === 'male') ? p : null;
  } catch {
    return null;
  }
}
function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Фото может не влезть в хранилище — тогда без него, мерки важнее.
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...p, photo: undefined }));
    } catch { /* приватный режим */ }
  }
}

/** Короткий ключ «от чего сделано фото человека»: мерки, пол, лицо. */
function avatarKey(p: Profile): string {
  const s = JSON.stringify([p.gender, p.figure, p.photo?.kind === 'face' ? p.photo.data.length + p.photo.data.slice(-64) : '']);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

/** Фото с телефона: уменьшаем до 1280 px по большей стороне, JPEG. */
function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось открыть фото'));
    };
    img.src = url;
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class TryOn {
  private readonly opts: Options;
  private root: ShadowRoot | null = null;
  private host: HTMLElement | null = null;
  private product: Product | null = null;
  private run: AbortController | null = null;
  private lastFocus: Element | null = null;

  constructor(opts: Options) {
    this.opts = opts;
  }

  open(product: Product): void {
    this.product = product;
    this.lastFocus = document.activeElement;
    if (!this.host) {
      this.host = document.createElement('div');
      this.root = this.host.attachShadow({ mode: 'open' });
      document.body.append(this.host);
    }
    this.host.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    const profile = loadProfile();
    if (profile) this.result(profile);
    else this.form(null);
  }

  close(): void {
    this.run?.abort();
    if (this.host) this.host.hidden = true;
    document.documentElement.style.overflow = '';
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  // ---------------------------------------------------------------- каркас окна

  private frame(title: string, body: string): HTMLElement {
    const root = this.root!;
    root.innerHTML = `<style>${CSS}</style>
<div class="back" data-close></div>
<section class="dlg" role="dialog" aria-modal="true" aria-labelledby="t">
  <header><h2 id="t">${esc(title)}</h2><button class="x" data-close aria-label="Закрыть">✕</button></header>
  <div class="body">${body}</div>
</section>`;
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    root.querySelector('.dlg')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.close();
    });
    const dlg = root.querySelector<HTMLElement>('.dlg')!;
    (dlg.querySelector<HTMLElement>('input, button:not(.x)') ?? dlg.querySelector<HTMLElement>('.x'))?.focus();
    return dlg;
  }

  // ---------------------------------------------------------------- шаг 1: мерки и фото

  private form(prev: Profile | null): void {
    let gender: Gender = prev?.gender ?? 'female';
    const figure: Figure = { ...(prev?.figure ?? DEFAULTS[gender]) };
    let photo = prev?.photo;
    const dlg = this.frame(
      'Ваш манекен',
      `<p class="lead">Один раз введите свои параметры — манекен будет вашей фигуры на любой вещи.</p>
<div class="seg" role="group" aria-label="Фигура">
  <button type="button" data-g="female">Женская</button><button type="button" data-g="male">Мужская</button>
</div>
<div class="grid">${FIELDS.map(
        (f) => `<label class="num"><span>${f.label}</span>
  <span class="in"><input type="number" inputmode="numeric" name="${f.key}" min="${f.min}" max="${f.max}" required><i>${f.unit}</i></span></label>`,
      ).join('')}</div>
<details class="how"><summary>Как снять мерки</summary>
<p>Грудь — по самым выступающим точкам, лента горизонтально. Талия — по самому узкому месту. Бёдра — по самым выступающим точкам ягодиц. Лента прилегает, но не утягивает.</p></details>
<fieldset class="photo"><legend>Своё фото <span class="opt">по желанию</span></legend>
  <div class="seg small" role="group" aria-label="Что на фото">
    <button type="button" data-p="">Без фото</button><button type="button" data-p="face">Лицо</button><button type="button" data-p="full">В полный рост</button>
  </div>
  <label class="file" hidden><input type="file" accept="image/*"><span>Выбрать фото</span></label>
  <img class="thumb" alt="Ваше фото" hidden>
  <p class="note" data-pnote></p>
</fieldset>
<p class="err" role="alert" hidden></p>
<button class="go" type="button">Примерить</button>
<p class="priv">Параметры и фото хранятся только на вашем устройстве. Для примерки фото уходит в сервис генерации и не сохраняется у продавца.</p>`,
    );
    const inputs = new Map(FIELDS.map((f) => [f.key, dlg.querySelector<HTMLInputElement>(`input[name=${f.key}]`)!]));
    const fill = () => FIELDS.forEach((f) => (inputs.get(f.key)!.value = String(figure[f.key])));
    const syncGender = () => dlg.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === gender)));
    let kind: PhotoKind | '' = photo?.kind ?? '';
    const fileBox = dlg.querySelector<HTMLElement>('.file')!;
    const thumb = dlg.querySelector<HTMLImageElement>('.thumb')!;
    const pnote = dlg.querySelector<HTMLElement>('[data-pnote]')!;
    const syncPhoto = () => {
      dlg.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === kind)));
      fileBox.hidden = !kind;
      const shown = kind && photo && photo.kind === kind;
      thumb.hidden = !shown;
      if (shown) thumb.src = photo!.data;
      pnote.textContent =
        kind === 'face' ? 'Чёткое фото лица анфас: манекен станет вами, фигура — по меркам.'
        : kind === 'full' ? 'Фото в полный рост, анфас, в облегающей одежде, руки чуть от тела. Вещь наденем прямо на это фото.'
        : 'Без фото покажем человека вашей фигуры.';
    };
    fill();
    syncGender();
    syncPhoto();
    dlg.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.g === gender) return;
        gender = b.dataset.g as Gender;
        Object.assign(figure, DEFAULTS[gender]);
        fill();
        syncGender();
      }),
    );
    dlg.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) =>
      b.addEventListener('click', () => {
        kind = b.dataset.p as PhotoKind | '';
        syncPhoto();
      }),
    );
    fileBox.querySelector('input')!.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !kind) return;
      photo = { kind, data: await readPhoto(file) };
      syncPhoto();
    });
    const err = dlg.querySelector<HTMLElement>('.err')!;
    dlg.querySelector('.go')!.addEventListener('click', () => {
      for (const f of FIELDS) {
        const v = Number(inputs.get(f.key)!.value);
        if (!Number.isFinite(v) || v < f.min || v > f.max) {
          err.hidden = false;
          err.textContent = `${f.label}: от ${f.min} до ${f.max} ${f.unit}.`;
          inputs.get(f.key)!.focus();
          return;
        }
        figure[f.key] = Math.round(v);
      }
      if (kind && (!photo || photo.kind !== kind)) {
        err.hidden = false;
        err.textContent = 'Выберите фото или «Без фото».';
        return;
      }
      const p: Profile = { gender, figure, photo: kind ? photo : undefined, avatar: prev?.avatar };
      saveProfile(p);
      this.result(p);
    });
  }

  // ---------------------------------------------------------------- шаг 2: фото в вещи и размер

  private result(p: Profile): void {
    const product = this.product!;
    const kind = KINDS[product.kind];
    const dlg = this.frame(
      'Примерка',
      `<div class="res">
  <figure class="shot"><div class="ph"><img class="main" alt="" hidden><div class="wait"><span class="spin"></span><b data-step>Строим фигуру по меркам…</b></div></div>
    <figcaption><img class="garm" alt=""><span>${esc(product.title)}</span></figcaption></figure>
  <div class="side">
    <div class="size" data-size></div>
    <p class="me">${p.gender === 'female' ? 'Женская' : 'Мужская'} фигура: рост ${p.figure.height}, вес ${p.figure.weight}, грудь ${p.figure.chest}, талия ${p.figure.waist}, бёдра ${p.figure.hips}${p.photo ? `, ${p.photo.kind === 'face' ? 'ваше лицо' : 'ваше фото'}` : ''}</p>
    <button class="ghost" type="button" data-edit>Изменить параметры</button>
  </div>
</div>`,
    );
    dlg.querySelector<HTMLImageElement>('.garm')!.src = product.image;
    dlg.querySelector('[data-edit]')!.addEventListener('click', () => this.form(p));
    this.renderSize(dlg.querySelector('[data-size]')!, p, kind.chart, kind.name);
    void this.shoot(dlg, p, product, kind.category);
  }

  private renderSize(box: HTMLElement, p: Profile, chartId: string, kindName: string): void {
    const item = ITEMS.find((i) => i.id === chartId);
    const v = item && evaluate(item, p.gender, p.figure);
    if (!v) {
      box.innerHTML = `<p class="note">Для этой фигуры у вещи «${esc(kindName)}» нет сетки размеров.</p>`;
      return;
    }
    const best = v.sizes[v.best];
    box.innerHTML = `<div class="badge ${v.tone}"><small>Ваш размер</small><b>${esc(sizeName(best.size))}</b></div>
<p class="vt">${esc(v.title)}</p><p class="vx">${esc(v.text)}</p>
<ul class="zones">${best.zones.map((z) => `<li class="${z.status}"><span>${ZONE_NAME[z.zone]}</span><b>${esc(zoneLabel(z))}</b></li>`).join('')}</ul>
<p class="src">По стандартной российской размерной сетке. Сетка продавца точнее — подключается вместе с карточкой.</p>`;
  }

  private async shoot(dlg: HTMLElement, p: Profile, product: Product, category: GarmentCategory): Promise<void> {
    this.run?.abort();
    const run = (this.run = new AbortController());
    const step = (t: string) => (dlg.querySelector('[data-step]')!.textContent = t);
    const main = dlg.querySelector<HTMLImageElement>('.main')!;
    const wait = dlg.querySelector<HTMLElement>('.wait')!;
    const show = (src: string, alt: string) => {
      main.src = src;
      main.alt = alt;
      main.hidden = false;
    };
    const fail = (msg: string) => {
      wait.classList.add('done');
      wait.innerHTML = `<b>${esc(msg)}</b>`;
    };
    const { endpoint, models } = this.opts;
    try {
      // Человек: своё фото в полный рост — сразу оно; иначе фото по фигуре (кэш, пока мерки те же).
      let person: string;
      if (p.photo?.kind === 'full') {
        person = p.photo.data;
        show(person, 'Ваше фото');
      } else {
        const key = avatarKey(p);
        if (p.avatar?.key === key && endpoint) {
          person = p.avatar.url;
        } else {
          const shot = await figureShot(models, p.gender, p.figure);
          if (run.signal.aborted) return;
          show(shot.image, 'Ваша фигура по меркам');
          if (!endpoint) {
            fail('Здесь будет фото: вы в этой вещи. Сервис ИИ-примерки ещё не подключён — пока показана ваша фигура по меркам.');
            return;
          }
          step(p.photo ? 'Переносим ваше лицо…' : 'Создаём фото человека вашей фигуры…');
          person = await makeAvatar(endpoint, shot.image, avatarPrompt(p.gender, p.figure, !!p.photo), p.photo?.data, run.signal);
          p.avatar = { key, url: person };
          saveProfile(p);
        }
        show(person, 'Человек вашей фигуры');
      }
      if (!endpoint) {
        fail('Сервис ИИ-примерки ещё не подключён: здесь будет это фото в выбранной вещи.');
        return;
      }
      step('Надеваем вещь…');
      const url = await tryOn(endpoint, person, product.image, category, run.signal);
      if (run.signal.aborted) return;
      show(url, `Вы в вещи: ${product.title}`);
      wait.hidden = true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      fail(`Не получилось: ${(e as Error).message}`);
    }
  }
}

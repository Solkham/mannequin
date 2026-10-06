// Демо-страница товара: карточка как на маркетплейсе и кнопка «Примерить на себя».
// Товар задаётся ссылкой на фото (или загрузкой), типом и названием; их можно передать в адресе:
// ?img=…&kind=tee&title=… — так удобно показывать демо на конкретной вещи.

import { KINDS, TryOn, type Kind } from './tryon/widget.ts';

const ENDPOINT: string = import.meta.env.VITE_GEN_URL ?? '';
const widget = new TryOn({ endpoint: ENDPOINT, models: `${import.meta.env.BASE_URL}models/` });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const img = $<HTMLImageElement>('product-img');
const drop = $('drop');
const urlIn = $<HTMLInputElement>('img-url');
const fileIn = $<HTMLInputElement>('img-file');
const kindSel = $<HTMLSelectElement>('kind');
const titleIn = $<HTMLInputElement>('title-in');

const params = new URLSearchParams(location.search);
const state = {
  image: params.get('img') ?? '',
  kind: (params.get('kind') ?? 'tee') as Kind,
  title: params.get('title') ?? '',
};
if (!(state.kind in KINDS)) state.kind = 'tee';

for (const [k, v] of Object.entries(KINDS)) kindSel.add(new Option(v.name, k));

function render(): void {
  const name = KINDS[state.kind].name;
  $('crumb').textContent = name;
  $('title').textContent = state.title || `${name} — ваш товар`;
  kindSel.value = state.kind;
  titleIn.value = state.title;
  img.hidden = !state.image;
  drop.hidden = !!state.image;
  if (state.image) {
    img.src = state.image;
    img.alt = state.title || name;
  }
  if (!state.image.startsWith('data:')) urlIn.value = state.image;
  const src = new URL('widget.js', location.href).href;
  $('snippet').textContent =
    `<script src="${src}" data-endpoint="https://ВАШ-ПРОКСИ.workers.dev" defer></script>\n\n` +
    `<button data-tryon-image="${state.image && !state.image.startsWith('data:') ? state.image : 'https://…/фото-товара.jpg'}"\n` +
    `        data-tryon-kind="${state.kind}" data-tryon-title="${state.title || KINDS[state.kind].name}">\n  Примерить на себя\n</button>`;
}

urlIn.addEventListener('change', () => {
  const v = urlIn.value.trim();
  if (v && !/^https:\/\//.test(v)) {
    urlIn.setCustomValidity('Нужна ссылка https://');
    urlIn.reportValidity();
    return;
  }
  urlIn.setCustomValidity('');
  state.image = v;
  render();
});
fileIn.addEventListener('change', () => {
  const f = fileIn.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    state.image = String(r.result);
    render();
  };
  r.readAsDataURL(f);
});
kindSel.addEventListener('change', () => {
  state.kind = kindSel.value as Kind;
  render();
});
titleIn.addEventListener('input', () => {
  state.title = titleIn.value.trim();
  render();
});
img.addEventListener('error', () => {
  if (!state.image) return;
  state.image = '';
  render();
  urlIn.setCustomValidity('Не удалось открыть фото по этой ссылке');
  urlIn.reportValidity();
});

$('tryon').addEventListener('click', () => {
  if (!state.image) {
    urlIn.focus();
    urlIn.setCustomValidity('Сначала добавьте фото товара');
    urlIn.reportValidity();
    urlIn.setCustomValidity('');
    return;
  }
  widget.open({ image: state.image, kind: state.kind, title: state.title || KINDS[state.kind].name });
});

render();

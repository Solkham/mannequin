// Размерная логика: параметры тела против размерной сетки вещи.
// Без Three.js и DOM, проверяется в tests/sizing.test.ts.

import type { Figure, Gender, Ring } from './body.ts';

export type Zone = Ring;
export const ZONES: Zone[] = ['chest', 'waist', 'hips'];

/** Обхват из сетки: одно число или диапазон «от–до», см. */
export type Span = number | [number, number];

export interface ChartSize {
  /** Как размер назван на карточке: 46, M, 28/32. */
  label: string;
  /** Подпись помельче, например буквенный аналог: «M». */
  alt?: string;
  chest?: Span;
  waist?: Span;
  hips?: Span;
}

export interface Chart {
  /**
   * body — в сетке обхваты тела, на которое сшита вещь (так пишут WB и Ozon чаще всего).
   * garment — замеры самой вещи; тогда из них вычитается свобода облегания (ease).
   */
  kind: 'body' | 'garment';
  /** Для garment: сколько см вещь должна быть больше тела, [минимум, максимум удобного]. */
  ease?: Partial<Record<Zone, [number, number]>>;
  /** Для body с одним числом на размер: сколько см вокруг числа ещё «подходит». По умолчанию ±2. */
  spread?: number;
  sizes: ChartSize[];
}

/** Тип вещи: от него зависят форма оболочки на манекене и свобода облегания. */
export type Category = 'top' | 'tee' | 'shirt' | 'bottom' | 'shorts' | 'skirt' | 'dress' | 'outer';
/** Фактура ткани на манекене (src/fabrics.ts). */
export type Fabric = 'plain' | 'knit' | 'denim' | 'quilt' | 'floral' | 'stripes' | 'plaid' | 'oxford';

export interface ItemColor {
  name: string;
  hex: string;
}

export interface Item {
  id: string;
  title: string;
  shop: string;
  material: string;
  category: Category;
  fabric: Fabric;
  /** Цвета на выбор; первый — по умолчанию. */
  colors: ItemColor[];
  /** Принт: нашивка на груди (badge) или планка с пуговицами (placket). */
  print?: 'badge' | 'placket';
  /** На сколько см ткань без вреда тянется сверх сетки: деним с эластаном 2, трикотаж 3–4. */
  stretch: number;
  url?: string;
  /** Откуда сетка: ссылка или пометка, что это типовая сетка. */
  source: string;
  charts: Partial<Record<Gender, Chart>>;
}

export type Status = 'ok' | 'snug' | 'tight' | 'loose' | 'big';

export interface ZoneFit {
  zone: Zone;
  status: Status;
  /** На сколько см тело вышло за удобный диапазон (0, если внутри). */
  diff: number;
  /** Удобный диапазон тела для этого размера. */
  range: [number, number];
}

export interface SizeFit {
  size: ChartSize;
  zones: ZoneFit[];
  /** Худшая зона: по ней подписывается размер. */
  worst: ZoneFit;
  score: number;
}

export interface Verdict {
  sizes: SizeFit[];
  best: number;
  /** ok — сядет, warn — сядет с оговоркой, bad — ни один размер не подойдёт. */
  tone: 'ok' | 'warn' | 'bad';
  title: string;
  text: string;
}

// Сколько см недобора считаем «свободно», дальше уже «велико».
const LOOSE_LIMIT = 4;
// Если тело в последнем сантиметре диапазона, пишем «впритык».
const SNUG_EDGE = 1;

const SEVERITY: Record<Status, number> = { ok: 0, loose: 1, snug: 2, big: 3, tight: 4 };

/** Удобный диапазон тела по зоне для одного размера, или null, если зоны нет в сетке. */
export function bodyRange(chart: Chart, size: ChartSize, zone: Zone): [number, number] | null {
  const span = size[zone];
  if (span === undefined) return null;
  if (chart.kind === 'garment') {
    const ease = chart.ease?.[zone];
    if (!ease) return null;
    const g = typeof span === 'number' ? span : (span[0] + span[1]) / 2;
    return [g - ease[1], g - ease[0]];
  }
  if (typeof span === 'number') {
    const s = chart.spread ?? 2;
    return [span - s, span + s];
  }
  return span;
}

export function fitZone(body: number, range: [number, number], stretch: number): Omit<ZoneFit, 'zone' | 'range'> {
  const [lo, hi] = range;
  if (body > hi + stretch) return { status: 'tight', diff: body - hi - stretch };
  if (body > hi - SNUG_EDGE) return { status: 'snug', diff: Math.max(0, body - hi) };
  if (body >= lo) return { status: 'ok', diff: 0 };
  const diff = lo - body;
  return { status: diff <= LOOSE_LIMIT ? 'loose' : 'big', diff };
}

/** Штраф размера: тесно намного хуже, чем свободно, — тесную вещь не наденешь. */
function score(zones: ZoneFit[]): number {
  let s = 0;
  for (const z of zones) {
    if (z.status === 'tight') s += 20 + 4 * z.diff;
    else if (z.status === 'snug') s += 1 + z.diff;
    else if (z.status === 'loose') s += 0.6 * z.diff;
    else if (z.status === 'big') s += 3 + z.diff;
  }
  return s;
}

export function evaluate(item: Item, gender: Gender, body: Figure): Verdict | null {
  const chart = item.charts[gender];
  if (!chart || chart.sizes.length === 0) return null;

  const sizes: SizeFit[] = chart.sizes.map((size) => {
    const zones: ZoneFit[] = [];
    for (const zone of ZONES) {
      const range = bodyRange(chart, size, zone);
      if (!range) continue;
      zones.push({ zone, range, ...fitZone(body[zone], range, item.stretch) });
    }
    const worst = zones.reduce((a, b) =>
      SEVERITY[b.status] > SEVERITY[a.status] || (SEVERITY[b.status] === SEVERITY[a.status] && b.diff > a.diff) ? b : a,
    );
    return { size, zones, worst, score: score(zones) };
  });

  let best = 0;
  sizes.forEach((s, i) => {
    if (s.score < sizes[best].score) best = i;
  });
  return { sizes, best, ...describe(sizes, best) };
}

// ---------------------------------------------------------------- тексты

export const ZONE_NAME: Record<Zone, string> = { chest: 'Грудь', waist: 'Талия', hips: 'Бёдра' };
const ZONE_IN: Record<Zone, string> = { chest: 'в груди', waist: 'в талии', hips: 'в бёдрах' };

export function sizeName(s: ChartSize): string {
  return s.alt ? `${s.label} (${s.alt})` : s.label;
}

const cm = (v: number) => `${Math.max(1, Math.round(v))} см`;

/** Короткая подпись зоны: для бирки на манекене. */
export function zoneLabel(z: ZoneFit): string {
  switch (z.status) {
    case 'ok': return 'подходит';
    case 'snug': return 'впритык';
    case 'tight': return `мало на ${cm(z.diff)}`;
    case 'loose': return `свободно на ${cm(z.diff)}`;
    case 'big': return `велико на ${cm(z.diff)}`;
  }
}

/** Подпись под номером размера в ряду размеров. */
export function chipLabel(s: SizeFit, isBest: boolean): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  const st = s.worst.status;
  if (st === 'tight') return { text: s.worst.diff > 3 ? 'мало' : 'тесно', tone: 'bad' };
  if (isBest) return { text: 'лучший', tone: st === 'ok' ? 'ok' : 'warn' };
  if (st === 'ok') return { text: 'подходит', tone: 'ok' };
  if (st === 'snug') return { text: 'впритык', tone: 'warn' };
  if (st === 'loose') return { text: 'свободно', tone: 'warn' };
  return { text: 'велико', tone: 'warn' };
}

/** «тесно в бёдрах на 3 см» — главная проблема размера. */
function problem(z: ZoneFit): string {
  switch (z.status) {
    case 'tight': return `тесно ${ZONE_IN[z.zone]} на ${cm(z.diff)}`;
    case 'snug': return `впритык ${ZONE_IN[z.zone]}`;
    case 'loose': return `свободно ${ZONE_IN[z.zone]} на ${cm(z.diff)}`;
    case 'big': return `велико ${ZONE_IN[z.zone]} на ${cm(z.diff)}`;
    case 'ok': return 'всё сядет';
  }
}

function describe(sizes: SizeFit[], best: number): Pick<Verdict, 'tone' | 'title' | 'text'> {
  const b = sizes[best];
  const name = sizeName(b.size);

  if (b.worst.status === 'tight') {
    const last = sizes[sizes.length - 1];
    return {
      tone: 'bad',
      title: 'Ни один размер не подойдёт',
      text: `Даже в самом большом, ${sizeName(last.size)}, ${problem(last.worst)}.`,
    };
  }
  if (b.worst.status === 'big' && best === 0) {
    return {
      tone: 'warn',
      title: 'Все размеры великоваты',
      text: `Даже в самом маленьком, ${sizeName(b.size)}, ${problem(b.worst)}.`,
    };
  }

  const parts: string[] = [];
  const issues = b.zones.filter((z) => z.status !== 'ok');
  if (issues.length) {
    parts.push(`В ${b.size.label} ${issues.map(problem).join(', ')}, остальное сядет.`);
  }
  const smaller = sizes[best - 1];
  const larger = sizes[best + 1];
  if (smaller) parts.push(`В ${smaller.size.label} ${problem(smaller.worst)}.`);
  if (larger) parts.push(`В ${larger.size.label} ${problem(larger.worst)}.`);

  const allOk = issues.length === 0;
  return {
    tone: allOk ? 'ok' : 'warn',
    title: allOk ? `Берите ${name}` : `Лучше взять ${name}`,
    text: parts.join(' '),
  };
}

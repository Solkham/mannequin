// Проверка размерной логики на вещах из src/data/items.json.
// Запуск: npm test

import items from '../src/data/items.json' with { type: 'json' };
import { evaluate, chipLabel, sizeName, type Item } from '../src/sizing.ts';
import type { Figure, Gender } from '../src/body.ts';

// Сетка по замерам самой вещи: обхват изделия минус свобода облегания.
const garmentChart: Item = {
  ...(items as Item[])[0],
  id: 'garment-chart',
  charts: {
    female: {
      kind: 'garment',
      ease: { chest: [8, 30] },
      sizes: [{ label: 'S', chest: 112 }, { label: 'M', chest: 120 }, { label: 'L', chest: 128 }],
    },
  },
};
const byId = (id: string) => [...(items as Item[]), garmentChart].find((i) => i.id === id)!;
const fig = (chest: number, waist: number, hips: number): Figure => ({ height: 168, weight: 70, chest, waist, hips });

interface Case {
  label: string;
  item: string;
  gender: Gender;
  body: Figure;
  best?: string;
  tone?: 'ok' | 'warn' | 'bad';
  text?: RegExp;
  none?: true;
}

const cases: Case[] = [
  { label: 'платье ровно по сетке', item: 'dress', gender: 'female', body: fig(92, 74, 100), best: '46', tone: 'ok' },
  {
    label: 'платье: широкие бёдра решают', item: 'dress', gender: 'female', body: fig(96, 74, 108),
    best: '50', tone: 'warn', text: /велико в талии на 6 см.*В 48 тесно в бёдрах на 2 см/,
  },
  {
    label: 'плюс-сайз, джинсы из макета', item: 'jeans', gender: 'female', body: fig(104, 88, 112),
    best: '52', tone: 'warn', text: /впритык в талии.*В 54 свободно в бёдрах/,
  },
  { label: 'большой плюс-сайз, платье', item: 'dress', gender: 'female', body: fig(130, 120, 140), tone: 'bad', text: /Даже в самом большом/ },
  { label: 'маленькая фигура, платье', item: 'dress', gender: 'female', body: fig(70, 55, 75), best: '42', tone: 'warn', text: /велико/ },
  { label: 'худи, двойные размеры', item: 'hoodie', gender: 'female', body: fig(104, 88, 112), best: 'L', tone: 'ok' },
  { label: 'сетка по замерам изделия', item: 'garment-chart', gender: 'female', body: fig(104, 88, 112), best: 'M', tone: 'ok' },
  { label: 'мужчина, пуховик', item: 'puffer', gender: 'male', body: fig(100, 88, 104), best: '50', tone: 'ok' },
  { label: 'мужчина, платье', item: 'dress', gender: 'male', body: fig(100, 88, 104), none: true },
  { label: 'мужчина, юбка', item: 'skirt', gender: 'male', body: fig(100, 88, 104), none: true },
  { label: 'юбка по талии и бёдрам', item: 'skirt', gender: 'female', body: fig(96, 78, 104), best: '48', tone: 'ok' },
  { label: 'шорты, мужчина', item: 'shorts', gender: 'male', body: fig(100, 88, 104), best: '50', tone: 'ok' },
  { label: 'рубашка, мужчина', item: 'shirt', gender: 'male', body: fig(104, 92, 108), best: '52', tone: 'ok' },
];

let failed = 0;
for (const c of cases) {
  const v = evaluate(byId(c.item), c.gender, c.body);
  const errors: string[] = [];
  if (c.none) {
    if (v) errors.push('ждали, что сетки нет');
  } else if (!v) {
    errors.push('нет вердикта');
  } else {
    const best = v.sizes[v.best];
    if (c.best && best.size.label !== c.best) errors.push(`лучший ${best.size.label}, ждали ${c.best}`);
    if (c.tone && v.tone !== c.tone) errors.push(`тон ${v.tone}, ждали ${c.tone}`);
    if (c.text && !c.text.test(v.text)) errors.push(`текст не похож на ${c.text}`);
  }
  if (errors.length) failed++;
  const summary = v
    ? `${v.title}. ${v.text} [${v.sizes.map((s, i) => `${sizeName(s.size)}:${chipLabel(s, i === v.best).text}`).join(' ')}]`
    : 'сетки нет';
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${c.label.padEnd(30)} ${summary}${errors.length ? '\n     ' + errors.join('; ') : ''}`);
}

if (failed) {
  console.error(`${failed} проверок не прошли`);
  process.exit(1);
}

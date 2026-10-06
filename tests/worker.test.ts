// Проверка прокси примерки (worker/index.js) без сети: сервис fal.ai подменён.
// Запуск: npm test

// @ts-expect-error — воркер на JS, типов нет
import worker from '../worker/index.js';

let fails = 0;
const check = (name: string, ok: boolean, info = '') => {
  console.log(`${ok ? 'ок ' : 'ОШИБКА'} ${name}${info ? ` — ${info}` : ''}`);
  if (!ok) fails++;
};

const SITE = 'https://solkham.github.io';
const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify({ images: [{ url: 'https://cdn.example/photo.jpg' }] }), { status: 200 });
}) as typeof fetch;

const post = (body: unknown, origin = SITE) =>
  new Request('https://w.example/', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const IMG = 'data:image/jpeg;base64,AAAA';
const WB = 'https://basket-01.wbbasket.ru/vol1/part1/1/images/big/1.webp';
const env = { FAL_KEY: 'secret-key' };

let r = await worker.fetch(post({ action: 'tryon', person: IMG, garment: WB }), {});
check('без ключа — просит подключить сервис', r.status === 503 && (await r.json()).error === 'Подключите сервис примерки');
r = await worker.fetch(post({ action: 'tryon', person: IMG, garment: WB }, 'https://evil.example'), env);
check('чужой сайт не пускаем', r.status === 403);
r = await worker.fetch(post({ action: 'tryon', person: IMG, garment: 'javascript:alert(1)' }), env);
check('вещь — только картинка или https', r.status === 400);
r = await worker.fetch(post({ action: 'tryon', person: IMG, garment: WB, category: 'hats' }), env);
check('неизвестный тип вещи', r.status === 400);
r = await worker.fetch(post({ action: 'rm -rf' }), env);
check('неизвестное действие', r.status === 400);
r = await worker.fetch(new Request('https://w.example/', { method: 'OPTIONS', headers: { origin: SITE } }), env);
check('CORS для сайта', r.headers.get('access-control-allow-origin') === SITE);

r = await worker.fetch(post({ action: 'tryon', person: IMG, garment: WB, category: 'tops' }), env);
let data = await r.json();
check('примерка: адрес картинки', r.status === 200 && data.url === 'https://cdn.example/photo.jpg', JSON.stringify(data));
const t = calls.at(-1)!;
check('примерка: FASHN, фото человека и товара', t.url.endsWith('fal-ai/fashn/tryon/v1.6') && t.body.model_image === IMG && t.body.garment_image === WB && t.body.category === 'tops');
check('ключ уходит только сервису', t.auth === 'Key secret-key' && !JSON.stringify(data).includes('secret'));

r = await worker.fetch(post({ action: 'avatar', body: IMG, prompt: 'p' }), env);
data = await r.json();
const a = calls.at(-1)!;
check('аватар по фигуре: Kontext', r.status === 200 && a.url.endsWith('fal-ai/flux-pro/kontext') && a.body.image_url === IMG);
await worker.fetch(post({ action: 'avatar', body: IMG, face: IMG, prompt: 'p' }), env);
const f = calls.at(-1)!;
check('аватар с лицом: две картинки', f.url.endsWith('kontext/max/multi') && Array.isArray(f.body.image_urls) && (f.body.image_urls as string[]).length === 2);

if (fails) process.exit(1);

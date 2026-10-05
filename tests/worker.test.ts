// Проверка прокси «Фото в этой вещи» (worker/index.js) без сети: сервис генерации подменён.
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
const good = { image: 'data:image/jpeg;base64,AAAA', prompt: 'a person' };

let r = await worker.fetch(post(good), {});
check('без ключа — просит подключить сервис', r.status === 503 && (await r.json()).error === 'Подключите сервис генерации');

const env = { FAL_KEY: 'secret-key' };
r = await worker.fetch(post(good, 'https://evil.example'), env);
check('чужой сайт не пускаем', r.status === 403);
r = await worker.fetch(post({ image: 'https://x/y.jpg', prompt: 'p' }), env);
check('нужен снимок, а не ссылка', r.status === 400);
r = await worker.fetch(new Request('https://w.example/', { method: 'OPTIONS', headers: { origin: SITE } }), env);
check('CORS для сайта', r.headers.get('access-control-allow-origin') === SITE);

r = await worker.fetch(post(good), env);
const data = await r.json();
check('отдаёт адрес картинки', r.status === 200 && data.url === 'https://cdn.example/photo.jpg', JSON.stringify(data));
check('ключ уходит только сервису', calls.length === 1 && calls[0].auth === 'Key secret-key' && !JSON.stringify(data).includes('secret'));
check('снимок и текст переданы', calls[0].body.image_url === good.image && calls[0].body.prompt === good.prompt);

if (fails) process.exit(1);

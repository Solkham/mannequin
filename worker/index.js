// Прокси для «Фото в этой вещи»: сайт (публичный) шлёт сюда снимок манекена и текст,
// прокси добавляет ключ сервиса генерации (секрет воркера) и возвращает адрес картинки.
// Сервис — fal.ai, модель FLUX Kontext (правка картинки по тексту): ~$0.04 за фото.

const MODEL = 'https://fal.run/fal-ai/flux-pro/kontext';
const MAX_BODY = 4_000_000; // снимок в JPEG — сотни КБ; больше не пропускаем

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? 'https://solkham.github.io').split(',').map((s) => s.trim());
    const cors = {
      'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0],
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'Только POST' });
    if (!allowed.includes(origin)) return reply(403, { error: 'Чужой сайт' });
    if (!env.FAL_KEY) return reply(503, { error: 'Подключите сервис генерации' });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return reply(413, { error: 'Снимок слишком большой' });

    let input;
    try {
      input = await request.json();
    } catch {
      return reply(400, { error: 'Нужен JSON' });
    }
    const { image, prompt } = input ?? {};
    if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > MAX_BODY) return reply(400, { error: 'Нужен снимок' });
    if (typeof prompt !== 'string' || prompt.length > 2000) return reply(400, { error: 'Нужен текст' });

    const res = await fetch(MODEL, {
      method: 'POST',
      headers: { authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, image_url: image, num_images: 1, output_format: 'jpeg', safety_tolerance: '2' }),
    });
    const data = await res.json().catch(() => ({}));
    const url = data?.images?.[0]?.url;
    if (!res.ok || !url) return reply(502, { error: 'Сервис генерации не ответил', detail: data?.detail ?? res.status });
    return reply(200, { url });
  },
};

// Прокси примерки: сайт или виджет на маркетплейсе (публичный код) шлёт сюда картинки,
// прокси добавляет ключ сервиса (секрет воркера) и возвращает адрес готового фото.
// Сервис — fal.ai:
//   avatar — фото человека по фигуре: снимок тела по меркам (+ лицо, если есть) → FLUX Kontext;
//   tryon  — вещь из карточки товара на этом человеке → FASHN Try-On.

const FAL = 'https://fal.run/';
const MODELS = {
  avatar: 'fal-ai/flux-pro/kontext',
  avatarFace: 'fal-ai/flux-pro/kontext/max/multi',
  tryon: 'fal-ai/fashn/tryon/v1.6',
};
const CATEGORIES = ['auto', 'tops', 'bottoms', 'one-pieces'];
const MAX_BODY = 12_000_000; // до трёх фото в JPEG по ~1–3 МБ

/** Картинка: data URL или https-ссылка (фото товара с маркетплейса). */
const isImage = (v) =>
  typeof v === 'string' && v.length < MAX_BODY && (v.startsWith('data:image/') || /^https:\/\/[^\s]+$/.test(v));

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
    if (!env.FAL_KEY) return reply(503, { error: 'Подключите сервис примерки' });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return reply(413, { error: 'Фото слишком большие' });

    let input;
    try {
      input = await request.json();
    } catch {
      return reply(400, { error: 'Нужен JSON' });
    }
    const { action } = input ?? {};
    let model, body;
    if (action === 'avatar') {
      const { body: figure, face, prompt } = input;
      if (!isImage(figure) || (face !== undefined && !isImage(face))) return reply(400, { error: 'Нужен снимок фигуры' });
      if (typeof prompt !== 'string' || prompt.length > 2000) return reply(400, { error: 'Нужен текст' });
      model = face ? MODELS.avatarFace : MODELS.avatar;
      body = face
        ? { prompt, image_urls: [figure, face], num_images: 1, output_format: 'jpeg', safety_tolerance: '2' }
        : { prompt, image_url: figure, num_images: 1, output_format: 'jpeg', safety_tolerance: '2' };
    } else if (action === 'tryon') {
      const { person, garment, category = 'auto' } = input;
      if (!isImage(person) || !isImage(garment)) return reply(400, { error: 'Нужны фото человека и вещи' });
      if (!CATEGORIES.includes(category)) return reply(400, { error: 'Неизвестный тип вещи' });
      model = MODELS.tryon;
      body = { model_image: person, garment_image: garment, category, mode: 'quality', output_format: 'jpeg' };
    } else {
      return reply(400, { error: 'Неизвестное действие' });
    }

    const res = await fetch(FAL + model, {
      method: 'POST',
      headers: { authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const url = data?.images?.[0]?.url;
    if (!res.ok || !url) return reply(502, { error: 'Сервис примерки не ответил', detail: data?.detail ?? res.status });
    return reply(200, { url });
  },
};

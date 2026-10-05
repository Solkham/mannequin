// «Фото в этой вещи»: снимок манекена + описание вещи и фигуры → реалистичное фото через
// сервис генерации. Ключ сервиса живёт только в прокси (worker/), сайт знает лишь его адрес.
// Фото пользователя не используется: человек «собирается» из манекена.

import type { Figure, Gender } from './body.ts';

/** Адрес прокси (Cloudflare Worker). Пусто — генерация не подключена. */
export const GEN_URL: string = import.meta.env.VITE_GEN_URL ?? '';

export interface ShootInfo {
  gender: Gender;
  figure: Figure;
  /** Вещь словами: «футболка в полоску, тёмно-синяя полоска, хлопок». */
  item: string;
  pose: string;
}

const POSE: Record<string, string> = {
  stand: 'standing', walk: 'walking', sit: 'sitting on a stool', lie: 'lying on a mat', show: 'walking a runway',
};

/** Текст для модели: держать позу, фигуру, посадку и длину вещи со снимка, заменить манекен человеком. */
export function shootPrompt(s: ShootInfo): string {
  const f = s.figure;
  const who = s.gender === 'female' ? 'woman' : 'man';
  return [
    `Photorealistic studio fashion photo of a real ${who}, ${f.height} cm tall, ${f.weight} kg,`,
    `chest ${f.chest} cm, waist ${f.waist} cm, hips ${f.hips} cm, ${POSE[s.pose] ?? 'standing'},`,
    `wearing: ${s.item}.`,
    'Replace the faceless wooden mannequin with a real person of exactly this body shape and pose.',
    'Keep the garment exactly as on the reference: same fit, tightness, length, folds, color and print.',
    'Natural face and hair, soft studio light, plain light background, full body in frame.',
  ].join(' ');
}

/** Отправить снимок и текст в прокси, вернуть адрес готовой картинки. */
export async function generateShoot(snapshot: string, prompt: string, signal?: AbortSignal): Promise<string> {
  if (!GEN_URL) throw new Error('Подключите сервис генерации');
  const res = await fetch(GEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: snapshot, prompt }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error || `Сервис ответил ${res.status}`);
  return data.url;
}

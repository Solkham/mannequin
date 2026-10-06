// Запросы к прокси примерки (worker/). Ключ сервиса живёт только там.

import type { Figure, Gender } from '../body.ts';

export type GarmentCategory = 'tops' | 'bottoms' | 'one-pieces' | 'auto';

async function call(url: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error || `Сервис ответил ${res.status}`);
  return data.url;
}

/** Текст для фото человека по снимку тела: та же фигура и поза, простая облегающая одежда. */
export function avatarPrompt(gender: Gender, f: Figure, withFace: boolean): string {
  const who = gender === 'female' ? 'woman' : 'man';
  const basics = gender === 'female' ? 'a plain black fitted tank top and black fitted leggings' : 'a plain black fitted t-shirt and black fitted shorts';
  return [
    withFace
      ? `Replace the faceless wooden mannequin in the first image with the person from the second image: same face, hair and skin tone.`
      : `Replace the faceless wooden mannequin with a photorealistic real ${who}.`,
    `Keep exactly the same body shape, proportions and standing pose as the mannequin: ${f.height} cm tall, ${f.weight} kg,`,
    `chest ${f.chest} cm, waist ${f.waist} cm, hips ${f.hips} cm.`,
    `The person wears ${basics}, barefoot, arms slightly away from the body.`,
    'Full body in frame, front view, soft studio light, plain light grey background, natural realistic photo.',
  ].join(' ');
}

export function makeAvatar(url: string, body: string, prompt: string, face?: string, signal?: AbortSignal): Promise<string> {
  return call(url, { action: 'avatar', body, prompt, ...(face ? { face } : {}) }, signal);
}

export function tryOn(url: string, person: string, garment: string, category: GarmentCategory, signal?: AbortSignal): Promise<string> {
  return call(url, { action: 'tryon', person, garment, category }, signal);
}

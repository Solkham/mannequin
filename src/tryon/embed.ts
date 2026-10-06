// Виджет для маркетплейса одной строкой:
//   <script src="https://…/widget.js" data-endpoint="https://…workers.dev" defer></script>
//   <button data-tryon-image="https://…/photo.jpg" data-tryon-kind="tee" data-tryon-title="Футболка">Примерить на себя</button>
// Или из кода: MannequinTryOn.open({ image, kind, title }).

import { KINDS, TryOn, type Kind, type Product } from './widget.ts';

const script = document.currentScript as HTMLScriptElement | null;
const base = script?.src ? new URL('.', script.src).href : './';
const widget = new TryOn({ endpoint: script?.dataset.endpoint ?? '', models: `${base}models/` });

document.addEventListener('click', (e) => {
  const b = (e.target as Element | null)?.closest<HTMLElement>('[data-tryon-image]');
  if (!b) return;
  e.preventDefault();
  const kind = (b.dataset.tryonKind ?? 'tee') as Kind;
  widget.open({ image: b.dataset.tryonImage!, kind: kind in KINDS ? kind : 'tee', title: b.dataset.tryonTitle ?? '' });
});

export function open(product: Product): void {
  widget.open(product);
}

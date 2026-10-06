// Стили окна примерки (внутри Shadow DOM). Цвета — переменными: маркетплейс задаёт свои
// через --tryon-accent на элементе страницы.
export const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
* { box-sizing: border-box; margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.back { position: fixed; inset: 0; background: rgba(17, 16, 22, 0.55); z-index: 2147483000; }
.dlg { --a: var(--tryon-accent, #5b3df5); --ink: #17151c; --mute: #6c6878; --line: #e7e4ee; --soft: #f5f4f9;
  position: fixed; z-index: 2147483001; inset: 4vh 50% auto auto; transform: translateX(50%);
  width: min(920px, calc(100vw - 32px)); max-height: 92vh; overflow: auto; background: #fff; color: var(--ink);
  border-radius: 20px; box-shadow: 0 24px 80px rgba(0,0,0,.28); font-size: 15px; line-height: 1.45; }
@media (max-width: 640px) { .dlg { inset: auto 0 0 0; transform: none; width: 100%; max-height: 94vh; border-radius: 20px 20px 0 0; } }
header { position: sticky; top: 0; background: #fff; display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 10px; z-index: 1; }
h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.x { border: 0; background: var(--soft); width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 15px; color: var(--ink); }
.body { padding: 4px 20px 22px; }
.lead { color: var(--mute); margin-bottom: 14px; }
button { font: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--a); outline-offset: 2px; }
.seg { display: inline-flex; background: var(--soft); border-radius: 999px; padding: 3px; gap: 2px; margin-bottom: 14px; }
.seg button { border: 0; background: transparent; padding: 8px 16px; border-radius: 999px; color: var(--ink); }
.seg button[aria-pressed="true"] { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); font-weight: 600; }
.seg.small button { padding: 6px 12px; font-size: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.num { display: grid; gap: 4px; font-size: 13px; color: var(--mute); }
.in { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; background: #fff; }
.in:focus-within { border-color: var(--a); }
.in input { border: 0; outline: 0; width: 100%; padding: 11px 0; font-size: 17px; font-weight: 600; color: var(--ink); background: transparent; }
.in i { font-style: normal; color: var(--mute); }
.how { margin: 12px 0 4px; font-size: 13px; color: var(--mute); }
.how summary { cursor: pointer; color: var(--a); }
.how p { margin-top: 6px; }
.photo { border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px 14px; margin-top: 14px; }
.photo legend { padding: 0 6px; font-weight: 600; }
.opt { font-weight: 400; color: var(--mute); font-size: 13px; }
.photo .seg { margin: 4px 0 8px; }
.file { display: inline-block; }
.file input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.file span { display: inline-block; border: 1px dashed var(--a); color: var(--a); padding: 8px 14px; border-radius: 10px; }
.file:focus-within span { outline: 2px solid var(--a); outline-offset: 2px; }
.thumb { display: block; max-height: 140px; border-radius: 10px; margin-top: 10px; }
.note, .priv, .src, .me { font-size: 13px; color: var(--mute); margin-top: 8px; }
.err { color: #b3261e; margin-top: 10px; font-weight: 600; }
.go { display: block; width: 100%; margin-top: 16px; border: 0; border-radius: 14px; padding: 14px; background: var(--a); color: #fff; font-size: 16px; font-weight: 700; }
.ghost { margin-top: 14px; border: 1px solid var(--line); background: #fff; border-radius: 12px; padding: 10px 14px; color: var(--ink); }
.res { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 640px) { .res { grid-template-columns: 1fr; } }
.shot { margin: 0; }
.ph { position: relative; aspect-ratio: 2 / 3; background: var(--soft); border-radius: 16px; overflow: hidden; }
.main { width: 100%; height: 100%; object-fit: cover; display: block; }
.wait { position: absolute; inset: auto 12px 12px 12px; display: flex; gap: 10px; align-items: center; background: rgba(255,255,255,.92);
  padding: 12px 14px; border-radius: 12px; font-size: 14px; }
.wait.done { display: block; }
.spin { flex: none; width: 18px; height: 18px; border: 2px solid var(--line); border-top-color: var(--a); border-radius: 50%; animation: s 0.9s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 3s; } }
figcaption { display: flex; gap: 10px; align-items: center; margin-top: 10px; font-size: 14px; color: var(--mute); }
.garm { width: 44px; height: 56px; object-fit: cover; border-radius: 8px; background: var(--soft); }
.badge { display: inline-grid; padding: 10px 16px; border-radius: 14px; background: var(--soft); }
.badge small { font-size: 12px; color: var(--mute); }
.badge b { font-size: 26px; letter-spacing: -0.01em; }
.badge.ok { background: #e6f4ea; } .badge.warn { background: #fdf0d5; } .badge.bad { background: #fbe3e1; }
.vt { font-weight: 700; margin-top: 12px; }
.vx { color: var(--mute); margin-top: 4px; }
.zones { list-style: none; padding: 0; margin-top: 12px; display: grid; gap: 6px; }
.zones li { display: flex; justify-content: space-between; padding: 8px 12px; border-radius: 10px; background: var(--soft); font-size: 14px; }
.zones li.ok b { color: #1e7a45; } .zones li.snug b, .zones li.loose b, .zones li.big b { color: #9a6200; } .zones li.tight b { color: #b3261e; }
`;

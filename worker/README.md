# Прокси «Фото в этой вещи»

Сайт публичный, поэтому ключ сервиса генерации в него класть нельзя. Этот воркер Cloudflare
хранит ключ как секрет и пересылает запрос сервису fal.ai (модель FLUX Kontext, ~$0.04 за фото).

## Подключение (один раз)

1. Ключ: зарегистрироваться на https://fal.ai, пополнить баланс, создать API key.
2. Воркер: `cd worker && npx wrangler login && npx wrangler deploy` — в ответ придёт адрес
   вида `https://mannequin-photo.<аккаунт>.workers.dev`.
3. Секрет: `npx wrangler secret put FAL_KEY` и вставить ключ.
4. Сайт: в репозитории GitHub → Settings → Secrets and variables → Actions → Variables
   создать переменную `GEN_URL` с адресом воркера. Следующая выкладка включит кнопку.

Локально: `VITE_GEN_URL=https://… npm run dev`.

Без `GEN_URL` кнопка на сайте пишет «Подключите сервис генерации», остальное работает как раньше.

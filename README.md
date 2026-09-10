# Obrador Ixtlahuacán — WhatsApp Bot (Next.js / Vercel)

Bot de WhatsApp para **Obrador Ixtlahuacán** (mayorista de carne, Ixtlahuacán del Río, Jalisco).

**Stack:** Next.js App Router + TypeScript → Whapi.cloud → OpenAI Chat Completions (tool `enviar_pedido_a_admin`) → Vercel.

Puerto desde el bot Python/FastAPI. Plantilla base: Flujo Propio starter.

---

## Qué incluye

| Pieza | Rol |
|-------|-----|
| `app/api/webhook/route.ts` | Entrada Whapi: secret, `fromMe`, dedupe, GPS, historial, tool lead, reply |
| `app/api/health/route.ts` | Health check (sin secretos en claro) |
| `lib/whapi.ts` | `sendText(to, body)` → `POST {WHAPI_BASE_URL}/messages/text` |
| `lib/mexicoJid.ts` | Normaliza MX a `521XXXXXXXXXX@s.whatsapp.net` |
| `lib/brief.ts` | System prompt + tool desde `config/client-brief.json` |
| `lib/bot.ts` | Flujo OpenAI + handoff admin (1 lead + 1 update por chat) |
| `lib/dedupe.ts` | Dedupe en memoria por `message.id` |
| `lib/history.ts` | Historial corto en memoria por `chat_id` |
| `lib/leads.ts` | Tracking de leads enviados al admin |
| `config/client-brief.json` | Catálogo, horario, dirección, política de cotización |

---

## Auth del webhook

1. **Preferido:** header `x-bot-webhook-secret: <WEBHOOK_SECRET>`
2. **Fallback:** query `?secret=<WEBHOOK_SECRET>`

Si `WEBHOOK_SECRET` no está definido, el endpoint responde **401**.

Forma de URL:

```text
https://<proyecto>.vercel.app/api/webhook
https://<proyecto>.vercel.app/api/webhook?secret=<WEBHOOK_SECRET>
```

Ejemplo curl:

```bash
curl -X POST "https://<proyecto>.vercel.app/api/webhook" \
  -H "Content-Type: application/json" \
  -H "x-bot-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"messages":[{"id":"test-1","from_me":false,"chat_id":"5215551234567@s.whatsapp.net","type":"text","text":{"body":"Hola"}}]}'
```

---

## Variables de entorno

```bash
WHAPI_TOKEN=
WHAPI_BASE_URL=https://gate.whapi.cloud
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
WEBHOOK_SECRET=
ADMIN_PHONE=5213312974282@s.whatsapp.net
MAX_HISTORY=24
```

Nunca commits de `.env`, `.env.local` ni `.secrets.json`.

---

## Orden de deploy

1. **Primero Vercel** (importa este repo, configura env, deploy).
2. **Después Whapi**: apunta el webhook a la URL pública de Vercel.
3. **No uses túneles** para producción.

En Whapi (Settings → Webhook):

- URL: `https://<proyecto>.vercel.app/api/webhook`
- Método: **POST**
- Eventos: **`messages`** y/o **`messages.post`**
- Activa **`callback_persist`**
- Envía el secret en header `x-bot-webhook-secret` (o `?secret=` en la URL)

### JID México

Móviles MX en Whapi: `521` + **10 dígitos** + `@s.whatsapp.net`  
Ejemplo: `5213312974282@s.whatsapp.net`

---

## Funciones del bot

- Cotización **solo por volumen** (nunca inventa precios).
- Catálogo mayorista (canales, cabezas, vísceras, grasas); mínimo ~10 kg.
- Ubicación GPS (`location` + `live_location`) con lat/lng null-safe → Maps link.
- Tool `enviar_pedido_a_admin`: notifica al admin una vez por lead + una actualización.
- Historial y dedupe en memoria (se pierden en cold start; usar DB en prod multi-instancia).

---

## Desarrollo local

```bash
cp .env.example .env.local
# llena WHAPI_TOKEN, OPENAI_API_KEY, WEBHOOK_SECRET
npm install
npm run build
npm run dev
```

Health: `GET http://localhost:3000/api/health`

---

## Personalizar

Edita `config/client-brief.json` (catálogo, horario, FAQs) y redeploy en Vercel.

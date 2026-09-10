# Obrador Ixtlahuacán — WhatsApp Bot

Bot de WhatsApp para **Obrador Ixtlahuacán** (canal Whapi `STARLD-SMKHX`, +52 33 1451 8120).

Stack: Python 3 + FastAPI + Whapi.Cloud + OpenAI Chat Completions.

## Setup

```bash
cd /workspace/obrador-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # llenar WHAPI_TOKEN y OPENAI_API_KEY
```

## Run

```bash
source .venv/bin/activate
export WHAPI_TOKEN=... OPENAI_API_KEY=...
uvicorn main:app --host 0.0.0.0 --port 8080
```

## Endpoints

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/webhook` | Webhook Whapi (`messages` / `messages.post`) |

En Whapi Settings, apunta el webhook a `https://<tu-tunnel>/webhook` y habilita el evento `messages.post`.

## Notas

- Historial corto en memoria por `chat_id` (se pierde al reiniciar).
- Deduplica por message `id`.
- Ignora eventos no-mensaje, mensajes `from_me` y tipos no-texto.
- Secretos solo desde variables de entorno; nunca se loguean.


## Deploy en Render (free)

1. Sube este repo a GitHub.
2. En [Render](https://render.com) → **New** → **Web Service** → conecta el repo.
3. Runtime: Python. Build: `pip install -r requirements.txt`. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`.
4. Environment variables:
   - `WHAPI_TOKEN`
   - `OPENAI_API_KEY`
   - `ADMIN_PHONE=5213312974282@s.whatsapp.net`
5. Tras el deploy, en Whapi Settings pon:
   `https://<tu-servicio>.onrender.com/webhook`
   con evento `messages` / `messages.post`.

Nota: el plan free puede *dormir* sin tráfico; el primer mensaje a veces tarda.

"""WhatsApp bot for Obrador Ixtlahuacán — Whapi.Cloud + OpenAI tool calling."""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse
from openai import OpenAI

from prompt import LEAD_TOOL, SYSTEM_PROMPT

# ---------------------------------------------------------------------------
# Secrets helpers (never log secret values)
# ---------------------------------------------------------------------------


def _load_openai_key_from_box_secrets() -> str:
    """Read OPENAI_API_KEY from local bot secrets or box-secrets. Never log the value."""
    for path in (
        Path("/workspace/obrador-bot/.secrets.json"),
        Path("/home/box/agent-data/box-secrets.json"),
        Path("/home/box/sand-data/box-secrets.json"),
    ):
        try:
            if not path.exists():
                continue
            data = json.loads(path.read_text())
            if path.name == ".secrets.json":
                key = (data.get("OPENAI_API_KEY") or "").strip()
            else:
                secrets = data.get("secrets") or {}
                key = (secrets.get("OPENAI_API_KEY") or "").strip()
            if key:
                return key
        except Exception:
            continue
    return ""


def _resolve_openai_key() -> str:
    env_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if env_key:
        return env_key
    return _load_openai_key_from_box_secrets()


# ---------------------------------------------------------------------------
# Config (secrets ONLY from env / box-secrets — never logged as values)
# ---------------------------------------------------------------------------
WHAPI_TOKEN = os.environ.get("WHAPI_TOKEN", "")
OPENAI_API_KEY = _resolve_openai_key()
if OPENAI_API_KEY and not os.environ.get("OPENAI_API_KEY"):
    # Make available to OpenAI client / child code without printing
    os.environ["OPENAI_API_KEY"] = OPENAI_API_KEY

WHAPI_BASE_URL = os.environ.get("WHAPI_BASE_URL", "https://gate.whapi.cloud").rstrip("/")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
PORT = int(os.environ.get("PORT", "8080"))
MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "24"))
# Mexico mobile format for Whapi: 521 + 10 digits
ADMIN_PHONE = os.environ.get("ADMIN_PHONE", "5213312974282@s.whatsapp.net").strip()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("obrador-bot")

app = FastAPI(title="Obrador Ixtlahuacán WhatsApp Bot", version="0.2.2")

# In-memory state
_history: dict[str, deque] = defaultdict(lambda: deque(maxlen=MAX_HISTORY))
_seen_ids: set[str] = set()
_seen_lock = threading.Lock()
_SEEN_MAX = 5000

# Lead handoff tracking: chat_id -> {"sent": bool, "updated": bool}
_leads: dict[str, dict[str, bool]] = {}
_leads_lock = threading.Lock()

_openai: OpenAI | None = None


def get_openai() -> OpenAI:
    global _openai
    if _openai is None:
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set")
        _openai = OpenAI(api_key=OPENAI_API_KEY)
    return _openai


def _mark_seen(msg_id: str) -> bool:
    """Return True if this is a new id (should process); False if duplicate."""
    if not msg_id:
        return True
    with _seen_lock:
        if msg_id in _seen_ids:
            return False
        _seen_ids.add(msg_id)
        if len(_seen_ids) > _SEEN_MAX:
            for _ in range(len(_seen_ids) // 2):
                _seen_ids.pop()
        return True


def _maps_link(lat: float, lng: float) -> str:
    return f"https://maps.google.com/?q={lat},{lng}"


def extract_text(msg: dict[str, Any]) -> str | None:
    """Extract inbound user content from a Whapi message (text or location)."""
    mtype = msg.get("type") or ""
    if mtype == "text":
        text = msg.get("text") or {}
        body = text.get("body") if isinstance(text, dict) else None
        return (body or "").strip() or None
    if mtype == "link_preview":
        lp = msg.get("link_preview") or {}
        body = lp.get("body") if isinstance(lp, dict) else None
        return (body or "").strip() or None
    if mtype == "location":
        loc = msg.get("location") or {}
        if not isinstance(loc, dict):
            return None
        try:
            lat = float(loc["latitude"])
            lng = float(loc["longitude"])
        except (KeyError, TypeError, ValueError):
            return None
        name = (loc.get("name") or "").strip()
        address = (loc.get("address") or "").strip()
        comment = (loc.get("comment") or "").strip()
        parts = [
            "[El cliente compartió su ubicación GPS]",
            f"Lat: {lat}, Lng: {lng}",
            f"Maps: {_maps_link(lat, lng)}",
        ]
        if name:
            parts.append(f"Nombre: {name}")
        if address:
            parts.append(f"Dirección: {address}")
        if comment:
            parts.append(f"Comentario: {comment}")
        return "\n".join(parts)
    if mtype == "live_location":
        loc = msg.get("live_location") or {}
        if not isinstance(loc, dict):
            return None
        try:
            lat = float(loc["latitude"])
            lng = float(loc["longitude"])
        except (KeyError, TypeError, ValueError):
            return None
        caption = (loc.get("caption") or "").strip()
        parts = [
            "[El cliente compartió ubicación en vivo (GPS)]",
            f"Lat: {lat}, Lng: {lng}",
            f"Maps: {_maps_link(lat, lng)}",
        ]
        if caption:
            parts.append(f"Caption: {caption}")
        return "\n".join(parts)
    return None


def send_whapi_text(to: str, body: str) -> None:
    if not WHAPI_TOKEN:
        log.error("WHAPI_TOKEN missing; cannot send message")
        return
    url = f"{WHAPI_BASE_URL}/messages/text"
    headers = {
        "Authorization": f"Bearer {WHAPI_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"to": to, "body": body}
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            log.error(
                "Whapi send failed status=%s body_len=%s to=%s",
                resp.status_code,
                len(resp.text or ""),
                to,
            )
            resp.raise_for_status()
        log.info("Whapi text sent to=%s chars=%s", to, len(body))


def _format_admin_message(
    chat_id: str,
    from_number: str | None,
    args: dict[str, Any],
    *,
    is_update: bool,
) -> str:
    header = "🔄 ACTUALIZACIÓN de cotización" if is_update else "🥩 NUEVA cotización / lead"
    lines = [
        header,
        f"WhatsApp chat_id: {chat_id}",
    ]
    if from_number:
        lines.append(f"Número: {from_number}")
    lines.extend(
        [
            f"Nombre: {args.get('nombre_contacto') or '—'}",
            f"Negocio: {args.get('nombre_negocio') or '—'}",
            f"Productos: {args.get('productos') or '—'}",
            f"Entrega/recoge: {args.get('entrega_o_recoge') or '—'}",
            f"Día/horario: {args.get('dia_horario') or '—'}",
            f"Notas: {args.get('notas') or '—'}",
            f"Resumen: {args.get('resumen') or '—'}",
        ]
    )
    return "\n".join(lines)


def handle_enviar_pedido_a_admin(
    chat_id: str,
    from_number: str | None,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Notify admin once per completed lead; allow one update if revised."""
    es_actualizacion = bool(args.get("es_actualizacion"))

    with _leads_lock:
        state = _leads.setdefault(chat_id, {"sent": False, "updated": False})
        if not state["sent"]:
            # First lead for this chat
            is_update = False
            state["sent"] = True
        elif es_actualizacion and not state["updated"]:
            is_update = True
            state["updated"] = True
        elif not state["updated"]:
            # Model forgot es_actualizacion but we already sent once — treat as update once
            is_update = True
            state["updated"] = True
        else:
            log.info(
                "Skip duplicate admin alert chat_id=%s (already sent+updated)",
                chat_id,
            )
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_notified",
                "message": "Ya se notificó al admin de este pedido y su actualización.",
            }

    body = _format_admin_message(chat_id, from_number, args, is_update=is_update)
    try:
        send_whapi_text(ADMIN_PHONE, body)
        log.info(
            "Admin notified chat_id=%s update=%s admin=%s",
            chat_id,
            is_update,
            ADMIN_PHONE,
        )
        return {
            "ok": True,
            "skipped": False,
            "is_update": is_update,
            "message": "Pedido enviado al administrador del obrador.",
        }
    except Exception as exc:
        log.exception("Failed to notify admin chat_id=%s", chat_id)
        # Roll back flag so a retry can try again
        with _leads_lock:
            st = _leads.get(chat_id)
            if st:
                if is_update:
                    st["updated"] = False
                else:
                    st["sent"] = False
        return {
            "ok": False,
            "error": type(exc).__name__,
            "message": "No se pudo notificar al admin; intenta de nuevo si el cliente confirma.",
        }


def generate_reply(
    chat_id: str,
    user_text: str,
    *,
    from_number: str | None = None,
) -> str:
    history = _history[chat_id]
    history.append({"role": "user", "content": user_text})

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *list(history),
    ]
    client = get_openai()

    completion = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        tools=[LEAD_TOOL],
        tool_choice="auto",
        temperature=0.7,
        max_tokens=500,
    )
    msg = completion.choices[0].message

    # Tool-calling loop (usually one round for lead handoff)
    for _ in range(3):
        tool_calls = msg.tool_calls or []
        if not tool_calls:
            break

        # Persist assistant message with tool_calls in history for coherence
        assistant_entry: dict[str, Any] = {
            "role": "assistant",
            "content": msg.content or "",
        }
        # OpenAI SDK objects → serializable dicts for our history deque
        serialized_calls = []
        for tc in tool_calls:
            serialized_calls.append(
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
            )
        assistant_entry["tool_calls"] = serialized_calls
        history.append(assistant_entry)
        messages.append(
            {
                "role": "assistant",
                "content": msg.content or None,
                "tool_calls": serialized_calls,
            }
        )

        for tc in tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            if name == "enviar_pedido_a_admin":
                result = handle_enviar_pedido_a_admin(chat_id, from_number, args)
            else:
                result = {"ok": False, "error": f"unknown_tool:{name}"}

            tool_content = json.dumps(result, ensure_ascii=False)
            tool_msg = {
                "role": "tool",
                "tool_call_id": tc.id,
                "content": tool_content,
            }
            history.append(tool_msg)
            messages.append(tool_msg)

        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=messages,
            tools=[LEAD_TOOL],
            tool_choice="auto",
            temperature=0.7,
            max_tokens=500,
        )
        msg = completion.choices[0].message

    reply = (msg.content or "").strip()
    if not reply:
        reply = (
            "¡Listo! Alguien del obrador te va a contactar pronto con la cotización. "
            "Gracias por escribir a Obrador Ixtlahuacán."
        )
    history.append({"role": "assistant", "content": reply})
    return reply


def process_inbound(msg: dict[str, Any]) -> None:
    msg_id = msg.get("id") or ""
    if not _mark_seen(msg_id):
        log.info("Duplicate message id=%s — skip", msg_id)
        return

    if msg.get("from_me") is True:
        log.info("Ignore from_me id=%s", msg_id)
        return

    chat_id = msg.get("chat_id") or ""
    if not chat_id:
        log.warning("Message without chat_id id=%s", msg_id)
        return

    text = extract_text(msg)
    if not text:
        log.info(
            "Ignore non-text type=%s id=%s chat_id=%s",
            msg.get("type"),
            msg_id,
            chat_id,
        )
        return

    from_number = msg.get("from") or None
    from_name = msg.get("from_name") or from_number or "?"
    log.info(
        "Inbound msg chat_id=%s from=%s id=%s chars=%s",
        chat_id,
        from_name,
        msg_id,
        len(text),
    )

    try:
        reply = generate_reply(chat_id, text, from_number=from_number)
    except Exception:
        log.exception("OpenAI failed for chat_id=%s", chat_id)
        reply = (
            "Gracias por escribir a Obrador Ixtlahuacán. "
            "En este momento no puedo generar una respuesta automática; "
            "un humano te atenderá pronto. WhatsApp: 33 1451 8120."
        )

    try:
        send_whapi_text(chat_id, reply)
    except Exception:
        log.exception("Failed to send Whapi reply chat_id=%s", chat_id)


@app.on_event("startup")
def on_startup() -> None:
    whapi_ok = bool(WHAPI_TOKEN)
    openai_ok = bool(OPENAI_API_KEY)
    log.info(
        "Starting Obrador bot | WHAPI_TOKEN=%s (len=%s) | OPENAI_API_KEY=%s (len=%s) | "
        "model=%s | max_history=%s | admin=%s | port=%s",
        "set" if whapi_ok else "MISSING",
        len(WHAPI_TOKEN) if whapi_ok else 0,
        "set" if openai_ok else "MISSING",
        len(OPENAI_API_KEY) if openai_ok else 0,
        OPENAI_MODEL,
        MAX_HISTORY,
        ADMIN_PHONE,
        PORT,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "obrador-ixtlahuacan-bot",
        "version": "0.2.2",
        "whapi_token": "set" if WHAPI_TOKEN else "missing",
        "openai_api_key": "set" if OPENAI_API_KEY else "missing",
        "model": OPENAI_MODEL,
        "max_history": MAX_HISTORY,
        "admin_phone": ADMIN_PHONE,
    }


@app.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        log.warning("Webhook body is not JSON")
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)

    event = payload.get("event") or {}
    event_type = event.get("type") if isinstance(event, dict) else None
    event_name = event.get("event") if isinstance(event, dict) else None

    messages = payload.get("messages")
    if messages is None:
        log.info(
            "Ignore non-message webhook event_type=%s event_name=%s keys=%s",
            event_type,
            event_name,
            list(payload.keys())[:12],
        )
        return JSONResponse({"ok": True, "ignored": True})

    if event_type and event_type != "messages":
        log.info("Ignore event_type=%s", event_type)
        return JSONResponse({"ok": True, "ignored": True})

    if not isinstance(messages, list):
        log.warning("messages is not a list")
        return JSONResponse({"ok": True, "ignored": True})

    for msg in messages:
        if isinstance(msg, dict):
            background_tasks.add_task(process_inbound, msg)

    return JSONResponse({"ok": True})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)

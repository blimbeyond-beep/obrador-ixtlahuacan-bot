import { NextRequest, NextResponse } from "next/server";
import { generateReply } from "@/lib/bot";
import { markSeen } from "@/lib/dedupe";
import { toMexicoWhatsappJid } from "@/lib/mexicoJid";
import { sendText } from "@/lib/whapi";

export const runtime = "nodejs";
export const maxDuration = 60;

type LocFields = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  name?: string;
  address?: string;
  comment?: string;
  caption?: string;
};

type WhapiMessage = {
  id?: string;
  from_me?: boolean;
  fromMe?: boolean;
  chat_id?: string;
  from?: string;
  from_name?: string;
  type?: string;
  text?: { body?: string } | string;
  body?: string;
  link_preview?: { body?: string };
  location?: LocFields;
  live_location?: LocFields;
};

/**
 * Auth: prefer header `x-bot-webhook-secret`, also accept `?secret=` fallback.
 */
function verifySecret(req: NextRequest): boolean {
  const expected = process.env.WEBHOOK_SECRET || "";
  if (!expected) {
    console.warn("[bot] WEBHOOK_SECRET missing — rejecting webhook");
    return false;
  }
  const header =
    req.headers.get("x-bot-webhook-secret") ||
    req.headers.get("X-Bot-Webhook-Secret") ||
    "";
  const query = req.nextUrl.searchParams.get("secret") || "";
  return header === expected || query === expected;
}

function mapsLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/** Parse lat/lng null-safely (accepts number or numeric string; rejects null/NaN). */
function parseCoord(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function extractText(msg: WhapiMessage): string | null {
  const mtype = msg.type || "";

  if (mtype === "text") {
    if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
    if (msg.text && typeof msg.text === "object" && msg.text.body?.trim()) {
      return msg.text.body.trim();
    }
    if (typeof msg.body === "string" && msg.body.trim()) return msg.body.trim();
    return null;
  }

  if (mtype === "link_preview") {
    const body = msg.link_preview?.body?.trim();
    return body || null;
  }

  if (mtype === "location" || (!mtype && msg.location)) {
    const loc = msg.location;
    if (!loc) return null;
    const lat = parseCoord(loc.latitude);
    const lng = parseCoord(loc.longitude);
    if (lat === null || lng === null) return null;
    const parts = [
      "[El cliente compartió su ubicación GPS]",
      `Lat: ${lat}, Lng: ${lng}`,
      `Maps: ${mapsLink(lat, lng)}`,
    ];
    const name = (loc.name || "").trim();
    const address = (loc.address || "").trim();
    const comment = (loc.comment || "").trim();
    if (name) parts.push(`Nombre: ${name}`);
    if (address) parts.push(`Dirección: ${address}`);
    if (comment) parts.push(`Comentario: ${comment}`);
    return parts.join("\n");
  }

  if (mtype === "live_location" || msg.live_location) {
    const loc = msg.live_location;
    if (!loc) return null;
    const lat = parseCoord(loc.latitude);
    const lng = parseCoord(loc.longitude);
    if (lat === null || lng === null) return null;
    const parts = [
      "[El cliente compartió ubicación en vivo (GPS)]",
      `Lat: ${lat}, Lng: ${lng}`,
      `Maps: ${mapsLink(lat, lng)}`,
    ];
    const caption = (loc.caption || "").trim();
    if (caption) parts.push(`Caption: ${caption}`);
    return parts.join("\n");
  }

  // Fallback: plain text shapes without type
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  if (msg.text && typeof msg.text === "object" && msg.text.body?.trim()) {
    return msg.text.body.trim();
  }
  if (typeof msg.body === "string" && msg.body.trim()) return msg.body.trim();
  return null;
}

function collectMessages(payload: unknown): WhapiMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;

  const event = p.event;
  if (event && typeof event === "object") {
    const et = (event as Record<string, unknown>).type;
    if (typeof et === "string" && et && et !== "messages") {
      return [];
    }
  }

  if (Array.isArray(p.messages)) {
    return p.messages.filter(
      (m): m is WhapiMessage => !!m && typeof m === "object",
    );
  }

  if (p.message && typeof p.message === "object") {
    return [p.message as WhapiMessage];
  }
  if (p.data && typeof p.data === "object") {
    const d = p.data as Record<string, unknown>;
    if (Array.isArray(d.messages)) {
      return d.messages.filter(
        (m): m is WhapiMessage => !!m && typeof m === "object",
      );
    }
  }
  return [];
}

async function processMessage(msg: WhapiMessage): Promise<void> {
  const msgId = msg.id || "";
  if (!markSeen(msgId)) {
    console.info("[bot] DUPLICATE_MESSAGE id=%s", msgId);
    return;
  }

  const fromMe = msg.from_me === true || msg.fromMe === true;
  if (fromMe) {
    console.info("[bot] ignore fromMe id=%s", msgId);
    return;
  }

  const chatId = msg.chat_id || msg.from || "";
  if (!chatId) {
    console.warn("[bot] message without chat_id/from id=%s", msgId);
    return;
  }

  const text = extractText(msg);
  if (!text) {
    console.info("[bot] ignore non-text type=%s id=%s", msg.type, msgId);
    return;
  }

  let toJid: string;
  try {
    toJid = toMexicoWhatsappJid(chatId);
  } catch {
    toJid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;
  }

  const fromNumber = msg.from || null;
  console.info(
    "[bot] inbound id=%s to=%s chars=%s",
    msgId,
    toJid,
    text.length,
  );

  let reply: string;
  try {
    reply = await generateReply(chatId, text, fromNumber);
  } catch (err) {
    console.error("[bot] OpenAI failed chat_id=%s", chatId, err);
    reply =
      "Gracias por escribir a Obrador Ixtlahuacán. " +
      "En este momento no puedo generar una respuesta automática; " +
      "un humano te atenderá pronto. WhatsApp: 33 1451 8120.";
  }

  await sendText(toJid, reply);
  console.info("[bot] replied id=%s chars=%s", msgId, reply.length);
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 },
    );
  }

  const messages = collectMessages(payload);
  if (messages.length === 0) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const errors: string[] = [];
  for (const msg of messages) {
    try {
      await processMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[bot] process error:", message);
      errors.push(message);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: messages.length,
    errors: errors.length ? errors.length : undefined,
  });
}

/** Optional GET for human smoke-checks (does not replace Whapi POST). */
export async function GET(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    hint: "Webhook listo. Configura Whapi POST a esta URL con eventos messages / messages.post.",
  });
}

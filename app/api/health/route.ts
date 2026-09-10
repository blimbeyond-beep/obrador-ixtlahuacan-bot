import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    status: "ok",
    service: "obrador-ixtlahuacan-bot",
    version: "1.0.0",
    whapi_token: process.env.WHAPI_TOKEN ? "set" : "missing",
    openai_api_key: process.env.OPENAI_API_KEY ? "set" : "missing",
    webhook_secret: process.env.WEBHOOK_SECRET ? "set" : "missing",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    max_history: Number.parseInt(process.env.MAX_HISTORY || "24", 10) || 24,
    admin_phone:
      process.env.ADMIN_PHONE || "5213312974282@s.whatsapp.net",
  });
}

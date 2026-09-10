import OpenAI from "openai";
import { LEAD_TOOL, buildSystemPrompt } from "@/lib/brief";
import { appendHistory, getHistory } from "@/lib/history";
import { getLeadState, resetLeadFlag } from "@/lib/leads";
import { sendText } from "@/lib/whapi";

export type LeadArgs = {
  nombre_contacto?: string;
  nombre_negocio?: string;
  productos?: string;
  entrega_o_recoge?: string;
  dia_horario?: string;
  notas?: string;
  resumen?: string;
  es_actualizacion?: boolean;
};

function adminPhone(): string {
  return (
    process.env.ADMIN_PHONE || "5213312974282@s.whatsapp.net"
  ).trim();
}

function formatAdminMessage(
  chatId: string,
  fromNumber: string | null | undefined,
  args: LeadArgs,
  isUpdate: boolean,
): string {
  const header = isUpdate
    ? "🔄 ACTUALIZACIÓN de cotización"
    : "🥩 NUEVA cotización / lead";
  const lines = [header, `WhatsApp chat_id: ${chatId}`];
  if (fromNumber) lines.push(`Número: ${fromNumber}`);
  lines.push(
    `Nombre: ${args.nombre_contacto || "—"}`,
    `Negocio: ${args.nombre_negocio || "—"}`,
    `Productos: ${args.productos || "—"}`,
    `Entrega/recoge: ${args.entrega_o_recoge || "—"}`,
    `Día/horario: ${args.dia_horario || "—"}`,
    `Notas: ${args.notas || "—"}`,
    `Resumen: ${args.resumen || "—"}`,
  );
  return lines.join("\n");
}

async function handleEnviarPedidoAAdmin(
  chatId: string,
  fromNumber: string | null | undefined,
  args: LeadArgs,
): Promise<Record<string, unknown>> {
  const esActualizacion = Boolean(args.es_actualizacion);
  const state = getLeadState(chatId);

  let isUpdate = false;
  if (!state.sent) {
    isUpdate = false;
    state.sent = true;
  } else if (esActualizacion && !state.updated) {
    isUpdate = true;
    state.updated = true;
  } else if (!state.updated) {
    // Model forgot es_actualizacion but we already sent once — treat as update once
    isUpdate = true;
    state.updated = true;
  } else {
    console.info(
      "[bot] Skip duplicate admin alert chat_id=%s (already sent+updated)",
      chatId,
    );
    return {
      ok: true,
      skipped: true,
      reason: "already_notified",
      message:
        "Ya se notificó al admin de este pedido y su actualización.",
    };
  }

  const body = formatAdminMessage(chatId, fromNumber, args, isUpdate);
  try {
    await sendText(adminPhone(), body);
    console.info(
      "[bot] Admin notified chat_id=%s update=%s",
      chatId,
      isUpdate,
    );
    return {
      ok: true,
      skipped: false,
      is_update: isUpdate,
      message: "Pedido enviado al administrador del obrador.",
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error("[bot] Failed to notify admin chat_id=%s", chatId, err);
    resetLeadFlag(chatId, isUpdate ? "updated" : "sent");
    return {
      ok: false,
      error: name,
      message:
        "No se pudo notificar al admin; intenta de nuevo si el cliente confirma.",
    };
  }
}

export async function generateReply(
  chatId: string,
  userText: string,
  fromNumber?: string | null,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const client = new OpenAI({ apiKey });

  appendHistory(chatId, { role: "user", content: userText });
  const history = getHistory(chatId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
  ];

  let completion = await client.chat.completions.create({
    model,
    messages,
    tools: [LEAD_TOOL],
    tool_choice: "auto",
    temperature: 0.7,
    max_tokens: 500,
  });

  let msg = completion.choices[0]?.message;

  for (let round = 0; round < 3; round++) {
    const toolCalls = msg?.tool_calls;
    if (!toolCalls?.length) break;

    const serializedCalls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const assistantEntry: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: msg?.content || null,
      tool_calls: serializedCalls,
    };
    appendHistory(chatId, assistantEntry);
    messages.push(assistantEntry);

    for (const tc of toolCalls) {
      let args: LeadArgs = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as LeadArgs;
      } catch {
        args = {};
      }

      let result: Record<string, unknown>;
      if (tc.function.name === "enviar_pedido_a_admin") {
        result = await handleEnviarPedidoAAdmin(chatId, fromNumber, args);
      } else {
        result = { ok: false, error: `unknown_tool:${tc.function.name}` };
      }

      const toolMsg: OpenAI.Chat.ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      };
      appendHistory(chatId, toolMsg);
      messages.push(toolMsg);
    }

    completion = await client.chat.completions.create({
      model,
      messages,
      tools: [LEAD_TOOL],
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 500,
    });
    msg = completion.choices[0]?.message;
  }

  let reply = (msg?.content || "").trim();
  if (!reply) {
    reply =
      "¡Listo! Alguien del obrador te va a contactar pronto con la cotización. " +
      "Gracias por escribir a Obrador Ixtlahuacán.";
  }
  appendHistory(chatId, { role: "assistant", content: reply });
  return reply;
}

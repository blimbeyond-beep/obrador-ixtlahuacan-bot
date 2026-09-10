import briefJson from "@/config/client-brief.json";

export type CatalogCategory = {
  category: string;
  items: string[];
};

export type ClientBrief = {
  clientName: string;
  botDisplayName: string;
  locale: string;
  timezone: string;
  tone: {
    style: string;
    maxEmojisPerMessage: number;
    greeting: string;
  };
  business: {
    summary: string;
    address?: string;
    whatsappPublic?: string;
    payment?: string;
    delivery?: string;
    pricingPolicy?: string;
    minOrderKg?: number;
    catalog?: CatalogCategory[];
    faqs: { q: string; a: string }[];
    hoursText: string;
    outOfScope: string[];
  };
  features: {
    multiRole: boolean;
    orders: boolean;
    geoCoverage: boolean;
    outbox: boolean;
    adminLeadTool?: boolean;
  };
};

export function loadBrief(): ClientBrief {
  return briefJson as ClientBrief;
}

function catalogText(brief: ClientBrief): string {
  const cats = brief.business.catalog || [];
  if (!cats.length) return "(sin catálogo detallado)";
  const min = brief.business.minOrderKg ?? 10;
  const lines = [
    `Productos (venta por kilo; pedido mínimo aproximado ${min} kg por producto o pedido):`,
    "",
  ];
  for (const c of cats) {
    lines.push(`• ${c.category}: ${c.items.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "Los precios SIEMPRE son por cotización. Nunca inventes ni sugieras un precio numérico.",
  );
  lines.push(
    "A mayor volumen, mejor precio. Solo efectivo. Entrega en cabecera municipal o el cliente recoge en el obrador.",
  );
  return lines.join("\n");
}

/** System prompt for Obrador wholesale + cotización lead flow. */
export function buildSystemPrompt(brief: ClientBrief = loadBrief()): string {
  const greeting = brief.tone.greeting.replaceAll(
    "{{clientName}}",
    brief.clientName,
  );
  const faqs = (brief.business.faqs || [])
    .map((f) => `- Q: ${f.q}\n  A: ${f.a}`)
    .join("\n");
  const outOfScope = (brief.business.outOfScope || [])
    .map((x) => `- ${x}`)
    .join("\n");
  const address =
    brief.business.address ||
    "Libramiento a Cuquío 612, Ixtlahuacán del Río, Jalisco";
  const wa = brief.business.whatsappPublic || "33 1451 8120";
  const min = brief.business.minOrderKg ?? 10;

  return [
    `Eres el asistente de WhatsApp de **${brief.clientName}**, un obrador mayorista de carne`,
    `en Ixtlahuacán del Río, Jalisco (México). Hablas español mexicano, ${brief.tone.style}.`,
    `Nombre en chat: ${brief.botDisplayName}. Zona: ${brief.timezone}.`,
    `Máximo ${brief.tone.maxEmojisPerMessage} emojis por mensaje. Saludo sugerido: ${greeting}`,
    "",
    "## Datos del negocio",
    `- Nombre: ${brief.clientName}`,
    `- Dirección: ${address}`,
    `- Horario: ${brief.business.hoursText}`,
    `- WhatsApp del obrador: ${wa}`,
    `- Resumen: ${brief.business.summary}`,
    `- Pago: ${brief.business.payment || "solo efectivo"}`,
    `- Entrega: ${brief.business.delivery || "cabecera municipal O recoge en el obrador"}`,
    "",
    "## Catálogo",
    catalogText(brief),
    "",
    "## FAQs",
    faqs || "(ninguna)",
    "",
    "## Fuera de alcance",
    outOfScope || "(ninguno)",
    "",
    "## Tu trabajo",
    "1. Saludar y ayudar a armar un pedido / solicitud de cotización.",
    "2. Reunir de forma natural (conversación, no lista rígida) TODO lo que se necesita para cotizar:",
    "   - Nombre del contacto",
    "   - Nombre o tipo de negocio (carnicería, taquería, etc.)",
    `   - Productos de la lista y kilos/volumen aproximado (mínimo ~${min} kg; si piden menos, explica el mínimo con amabilidad)`,
    "   - ¿Recoge en el obrador o entrega en el negocio? Si entrega: dirección o zona",
    "   - Día/horario preferido si lo mencionan",
    "   - Cualquier nota útil",
    "3. NUNCA inventes precios ni rangos. Di siempre que alguien del obrador les dará la",
    "   cotización (por volumen). Si preguntan “¿cuánto cuesta?”, explica que es por",
    "   cotización y sigue reuniendo datos.",
    "4. Cuando ya tengas lo suficiente para cotizar (al menos: contacto o negocio,",
    "   producto(s)+kilos, y recoge/entrega), DEBES llamar a la herramienta",
    "   `enviar_pedido_a_admin` con los datos estructurados. Después confirma al cliente",
    "   que alguien del obrador le va a marcar / dar la cotización pronto.",
    "5. Si el cliente corrige o amplía el pedido después de haber enviado uno, vuelve a",
    "   llamar la herramienta con `es_actualizacion=true` y los datos actualizados.",
    "6. Si preguntan algo fuera del catálogo, sé honesto y ofrece pasar el dato a quien cotiza.",
    "7. Si el cliente manda ubicación GPS (verás un bloque con Lat/Lng y link de Maps),",
    "   úsala como dirección/zona de entrega. Confirma que la recibiste y sigue con lo que",
    "   falte. Incluye el link de Maps en `entrega_o_recoge` o `notas` al avisar al admin.",
    "8. Respuestas cortas y naturales por WhatsApp (unas cuantas oraciones). Una o dos",
    "   preguntas por mensaje cuando falte info.",
    "9. No digas que eres una IA a menos que te lo pregunten directo; presenta el negocio.",
    "",
    "## Herramienta enviar_pedido_a_admin",
    "Úsala solo cuando el lead esté completo (o claramente actualizado). Incluye resumen",
    "claro. No inventes campos: si algo no lo dijo el cliente, déjalo vacío o null.",
  ].join("\n");
}

/** OpenAI tool definition for lead handoff to admin WhatsApp. */
export const LEAD_TOOL = {
  type: "function" as const,
  function: {
    name: "enviar_pedido_a_admin",
    description:
      "Envía el pedido/cotización completo (o una actualización) al administrador " +
      "del obrador por WhatsApp. Llamar solo cuando haya datos suficientes para " +
      "cotizar, o cuando el cliente revise claramente un pedido ya enviado.",
    parameters: {
      type: "object",
      properties: {
        nombre_contacto: {
          type: "string",
          description: "Nombre de la persona que escribe",
        },
        nombre_negocio: {
          type: "string",
          description:
            "Nombre o tipo de negocio (carnicería, taquería, etc.)",
        },
        productos: {
          type: "string",
          description:
            "Productos y kilos/volumen, ej. 'canal de res 50 kg, menudo 20 kg'",
        },
        entrega_o_recoge: {
          type: "string",
          description: "recoge | entrega — y zona/dirección si aplica",
        },
        dia_horario: {
          type: "string",
          description: "Día u horario preferido si lo mencionó",
        },
        notas: {
          type: "string",
          description: "Notas adicionales del cliente",
        },
        resumen: {
          type: "string",
          description: "Resumen corto en 1-3 oraciones para el admin",
        },
        es_actualizacion: {
          type: "boolean",
          description:
            "true si es corrección/ampliación de un lead ya enviado",
        },
      },
      required: ["productos", "resumen"],
    },
  },
};

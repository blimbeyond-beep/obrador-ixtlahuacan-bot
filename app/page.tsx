export default function HomePage() {
  return (
    <main style={{ padding: "2rem", maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>Obrador Ixtlahuacán — Bot OK</h1>
      <p>
        Bot de WhatsApp mayorista: webhook Whapi → OpenAI (tool{" "}
        <code>enviar_pedido_a_admin</code>) → reply. Usa{" "}
        <code>/api/health</code> y <code>/api/webhook</code>.
      </p>
    </main>
  );
}

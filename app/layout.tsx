import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Obrador Ixtlahuacán Bot",
  description: "WhatsApp bot mayorista (Whapi → OpenAI → Vercel)",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}

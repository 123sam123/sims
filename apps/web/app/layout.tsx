import type { Metadata, Viewport } from "next";
import MapStage from "@/components/MapStage";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Civilization Earth",
  description:
    "A spectator's window on five AI-run civilisations growing on the real Earth: the whole site is the planet — drag to pan, zoom to a settlement, and every feed, civilisation and event opens as an overlay on the map.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c0f" },
  ],
};

/**
 * The map is the site. It mounts here, in the layout, so it persists across
 * every navigation; each route's content renders as an overlay above it.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MapStage />
        {children}
      </body>
    </html>
  );
}

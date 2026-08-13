import WorldMap from "@/components/WorldMap";

export default function Page() {
  return (
    <main className="wrap">
      <header className="masthead">
        <h1>AI Civilization Earth</h1>
        <span className="sub">
          A spectator's map — drawn in code, from what the world actually is.
        </span>
      </header>
      <WorldMap />
      <p className="foot">
        The coastlines, mountains, rivers and orefields are the real Earth and are fixed. Everything
        made — settlements, borders, the buildings you see up close — is the civilisations' own, and
        a settlement is only ever drawn from materials its people can actually make. Nothing here can
        be steered; this is a window, not a control room. The view polls the running world and
        redraws when it advances.
      </p>
    </main>
  );
}

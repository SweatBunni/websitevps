import Link from "next/link";

const features = [
  {
    title: "Three loaders, one studio",
    body: "Switch between Fabric, Forge, and NeoForge. Each workspace ships with Gradle, wrapper scripts, and loader-aware templates.",
  },
  {
    title: "Versions from the source",
    body: "Minecraft versions are loaded dynamically from official Fabric, Forge, and NeoForge metadata so pick lists stay current.",
  },
  {
    title: "AI that writes real project files",
    body: "The model streams its answer in chat and CodexMC extracts fenced project files into your workspace automatically.",
  },
  {
    title: "Build JARs on your VPS",
    body: "Run Gradle builds from the UI with a live console. Point JAVA_HOME at Temurin 21 or 25 using the bundled JDK setup script.",
  },
  {
    title: "Ollama-first local inference",
    body: "CodexMC runs against Ollama on your VPS by default, with Qwen coder models and configurable fallbacks.",
  },
  {
    title: "Chat-first workflow",
    body: "The generator mirrors a familiar chat layout: new session, history in the thread, and a dedicated log panel for Gradle output.",
  },
];

export default function Home() {
  return (
    <div className="min-h-full codexmc-grid">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold tracking-tight">
            Codex<span className="text-[var(--accent)]">MC</span>
          </span>
          <Link
            href="/studio"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#06261a] transition hover:opacity-90"
          >
            Open studio
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm font-medium uppercase tracking-widest text-[var(--accent)]">
          Minecraft mod generation
        </p>
        <h1 className="mt-3 max-w-2xl text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
          Ship loader-ready mods with AI and a real Gradle pipeline.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-[var(--muted)]">
          CodexMC scaffolds full buildable projects, keeps versions in sync with each
          ecosystem, and streams AI output plus build logs so you always see what the
          system is doing.
        </p>
        <div className="mt-10 flex flex-wrap gap-4">
          <Link
            href="/studio"
            className="rounded-xl bg-[var(--accent)] px-6 py-3 text-base font-semibold text-[#06261a] shadow-lg shadow-[var(--accent)]/15 transition hover:opacity-95"
          >
            Start generating
          </Link>
          <a
            href="#features"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-6 py-3 text-base font-medium text-[var(--foreground)] transition hover:bg-[var(--surface-hover)]"
          >
            Explore features
          </a>
        </div>

        <section id="features" className="mt-24 scroll-mt-24">
          <h2 className="text-2xl font-semibold tracking-tight">What you get</h2>
          <p className="mt-2 max-w-2xl text-[var(--muted)]">
            Built for self-hosted VPS workflows: JDK layout hooks, Gradle wrapper assets,
            and isolated workspaces under <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-sm">/workspaces</code>.
          </p>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2">
            {features.map((f) => (
              <li
                key={f.title}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm transition hover:border-[var(--accent-dim)]/50"
              >
                <h3 className="font-semibold text-[var(--foreground)]">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="mt-auto border-t border-[var(--border)] py-8 text-center text-sm text-[var(--muted)]">
        CodexMC — AI-assisted mods, real Gradle builds.
      </footer>
    </div>
  );
}

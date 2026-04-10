import { runGradleBuild } from "@/lib/build-runner";

export const maxDuration = 600;

export async function POST(req: Request) {
  const body = (await req.json()) as { sessionId?: string };
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return new Response(JSON.stringify({ error: "sessionId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: string) => controller.enqueue(encoder.encode(`${line}\n`));
      try {
        const { code } = await runGradleBuild(body.sessionId!, send);
        send(`[codexmc] Gradle exited with code ${code ?? "unknown"}.`);
      } catch (e) {
        send(
          `[codexmc] Build error: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

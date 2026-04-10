import { readFile } from "node:fs/promises";
import { findBuiltModJar } from "@/lib/artifact";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  if (!sessionId || sessionId.length < 4) {
    return new Response(JSON.stringify({ error: "sessionId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const found = await findBuiltModJar(sessionId);
  if (!found) {
    return new Response(
      JSON.stringify({
        error:
          "No mod JAR found. Run Build JAR after a successful Gradle build (build/libs).",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const safeName = found.filename.replace(/[^\w.\-()+]/g, "_");
  const buf = await readFile(found.absolutePath);

  return new Response(buf, {
    headers: {
      "Content-Type": "application/java-archive",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "no-store",
    },
  });
}

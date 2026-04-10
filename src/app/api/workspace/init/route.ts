import { NextResponse } from "next/server";
import { z } from "zod";
import { isLoaderId } from "@/lib/loaders";
import { initWorkspace } from "@/lib/workspace";

const bodySchema = z.object({
  sessionId: z.string().min(4).max(128),
  loader: z.string(),
  version: z.string().min(2).max(120),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { sessionId, loader, version } = parsed.data;
  if (!isLoaderId(loader)) {
    return NextResponse.json({ error: "Invalid loader." }, { status: 400 });
  }
  try {
    await initWorkspace(sessionId, loader, version);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Workspace init failed." },
      { status: 500 },
    );
  }
}

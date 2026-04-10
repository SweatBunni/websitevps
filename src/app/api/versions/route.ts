import { NextResponse } from "next/server";
import { isLoaderId } from "@/lib/loaders";
import { versionsForLoader } from "@/lib/versions";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const loader = searchParams.get("loader") ?? "fabric";
  if (!isLoaderId(loader)) {
    return NextResponse.json({ error: "Invalid loader." }, { status: 400 });
  }
  try {
    const versions = await versionsForLoader(loader);
    return NextResponse.json({ versions });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Version fetch failed." },
      { status: 502 },
    );
  }
}

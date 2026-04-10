import { NextResponse } from "next/server";
import { resolveJavaHome } from "@/lib/jdk";

export async function GET() {
  const j21 = resolveJavaHome("21");
  const j25 = resolveJavaHome("25");
  const j17 = resolveJavaHome("17");
  const fallback = resolveJavaHome();
  return NextResponse.json({
    JDK_21_HOME: j21 ?? null,
    JDK_25_HOME: j25 ?? null,
    JDK_17_HOME: j17 ?? null,
    effective: fallback ?? null,
  });
}

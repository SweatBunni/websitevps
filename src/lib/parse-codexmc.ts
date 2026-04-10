const BLOCK = /```codexmc:([^\n]+)\n([\s\S]*?)```/g;

export type ParsedFile = { path: string; content: string };

export function extractCodexMcFiles(text: string): ParsedFile[] {
  const out: ParsedFile[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const rel = m[1].trim().replace(/^["']|["']$/g, "");
    const content = m[2].replace(/\r\n/g, "\n");
    if (!rel || rel.includes("..")) continue;
    out.push({ path: rel.replace(/\\/g, "/"), content });
  }
  return out;
}

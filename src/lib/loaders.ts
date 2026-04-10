export const LOADERS = ["fabric", "forge", "neoforge"] as const;
export type LoaderId = (typeof LOADERS)[number];

export function isLoaderId(s: string): s is LoaderId {
  return (LOADERS as readonly string[]).includes(s);
}

export type RegisteredHarbor = { port: string; region: string };

function normalizedHarborName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, "").replace(/항$/, "");
}

export function resolveDetectedHarbor(
  evidence: string,
  registeredSources: RegisteredHarbor[],
): { port: string | null; region: string | null } {
  const normalizedEvidence = evidence
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const harbors = new Map<string, RegisteredHarbor[]>();

  for (const source of registeredSources) {
    const key = normalizedHarborName(source.port);
    if (!key) continue;
    const rows = harbors.get(key) ?? [];
    rows.push(source);
    harbors.set(key, rows);
  }

  const matches = [...harbors.entries()].filter(([key]) => normalizedEvidence.includes(key));
  if (matches.length !== 1) return { port: null, region: null };

  const [, sources] = matches[0];
  const ports = [...new Set(sources.map((source) => source.port.trim()).filter(Boolean))];
  const port = ports.find((value) => value.replace(/\s+/g, "").endsWith("항")) ?? ports[0] ?? null;
  const regions = [...new Set(sources.map((source) => source.region.trim()).filter(Boolean))];
  return {
    port,
    region: regions.length === 1 ? regions[0] : null,
  };
}

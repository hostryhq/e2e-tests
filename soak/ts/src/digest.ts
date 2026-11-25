import { createHash } from "node:crypto";
import { canonicalize } from "@hostry/client-core";
import meta from "./entities.generated.json";

type Meta = { owner: string; day_parent: string | null; day_parent_ref: string | null; outside_digest: boolean; fields: Record<string, { pii: boolean }>; has_business_date: boolean };
const M = meta as unknown as Record<string, Meta>;
type Row = Record<string, unknown> & { id: string };

export type EntityDigest = { entity: string; row_count: number; hash: string };
export type Digest = { state_hash: string; entities: EntityDigest[] };

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The projection digest of one service for one business day, computed from a device's rows exactly as
 * sync/protocol-v1.md `sha256-canon-v1` says: the rows of the entities the service owns that belong to the day (own
 * business_date, or the business_date reached by following day_parent), JCS of id plus every set non-pii schema field,
 * SHA-256 over the row texts in id order, then the state hash over `<entity>\n<count>\n<hash>\n`.
 */
export function deviceDigest(owner: "orders" | "billing", date: string, rows: Record<string, Row[]>): Digest {
  const byId = new Map<string, Row>();
  for (const [e, list] of Object.entries(rows)) for (const r of list) byId.set(`${e}|${r.id}`, r);
  const dayOf = (entity: string, r: Row, depth = 0): string | undefined => {
    const m = M[entity];
    if (!m || depth > 6) return undefined;
    if (m.has_business_date && typeof r.business_date === "string") return r.business_date;
    if (m.day_parent && m.day_parent_ref) {
      const pid = r[m.day_parent];
      const parent = typeof pid === "string" ? byId.get(`${m.day_parent_ref}|${pid}`) : undefined;
      return parent ? dayOf(m.day_parent_ref, parent, depth + 1) : undefined;
    }
    return undefined;
  };
  const entities: EntityDigest[] = [];
  for (const entity of Object.keys(M).sort()) {
    const m = M[entity]!;
    if (m.owner !== owner || m.outside_digest) continue;
    const list = (rows[entity] ?? []).filter((r) => !(r as { _deleted?: boolean })._deleted && dayOf(entity, r) === date);
    if (list.length === 0) continue;
    const texts = list
      .map((r) => {
        const o: Record<string, unknown> = { id: r.id };
        for (const [f, fm] of Object.entries(m.fields)) {
          if (fm.pii) continue;
          const v = r[f];
          if (v !== undefined && v !== null) o[f] = v;
        }
        return { id: r.id, text: canonicalize(o) };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    entities.push({ entity, row_count: texts.length, hash: sha(texts.map((t) => t.text + "\n").join("")) });
  }
  return { entities, state_hash: sha(entities.map((e) => `${e.entity}\n${e.row_count}\n${e.hash}\n`).join("")) };
}

/** Entity-level comparison of a device digest and a service digest: what differs, and in what way. */
export function compareDigests(dev: Digest, svc: Digest): string[] {
  const out: string[] = [];
  const d = new Map(dev.entities.map((e) => [e.entity, e]));
  const s = new Map(svc.entities.map((e) => [e.entity, e]));
  for (const name of [...new Set([...d.keys(), ...s.keys()])].sort()) {
    const a = d.get(name);
    const b = s.get(name);
    if (!a) out.push(`${name}: service lists ${b!.row_count} rows, device has none`);
    else if (!b) out.push(`${name}: device has ${a.row_count} rows, service lists none`);
    else if (a.row_count !== b.row_count) out.push(`${name}: rows device ${a.row_count} vs service ${b.row_count}`);
    else if (a.hash !== b.hash) out.push(`${name}: ${a.row_count} rows, content hash differs`);
  }
  return out;
}

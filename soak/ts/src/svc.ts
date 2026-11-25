import { execFileSync } from "node:child_process";

/** Reads of the real orders and billing services as the owner of the onboarded organisation. */
export class Svc {
  private token = "";
  constructor(
    private readonly o: { billing: string; orders: string; outlet: string; mobile: string },
  ) {}

  /** Owner sign-in through the real identity service (OTP via the dev capture aid); access tokens live 15 minutes. */
  private loggedAt = 0;
  async login(): Promise<void> {
    if (this.token && Date.now() - this.loggedAt < 600_000) return; // one sign-in serves the run: identity limits sign-ins, tokens live 15 minutes
    const bin = process.env.SOAK_ONBOARD_BIN ?? "/tmp/hostry-soak/soak-onboard";
    const wrap = process.env.SOAK_ENV_WRAPPER ?? "";
    for (let i = 0; i < 6; i++) {
      try {
        this.token = (wrap ? execFileSync(wrap, [bin, "-login-only", "-mobile", this.o.mobile]) : execFileSync(bin, ["-login-only", "-mobile", this.o.mobile])).toString().trim();
        if (this.token.length > 100) {
          this.loggedAt = Date.now();
          return;
        }
      } catch {
        /* rate limited: wait and retry */
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    throw new Error("owner sign-in failed");
  }

  /** GET on the real identity service as the owner (a device's latest offline pack). */
  async identity(path: string): Promise<{ status: number; json: any }> {
    const r = await fetch(`${process.env.SOAK_IDENTITY_URL}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  async get(service: "billing" | "orders", path: string): Promise<{ status: number; json: any }> {
    const r = await fetch(`${this.o[service]}${path}`, { headers: { authorization: `Bearer ${this.token}`, "x-outlet-id": this.o.outlet } });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave text */
    }
    return { status: r.status, json };
  }

  /** Every item of a cursor-paginated list. */
  async all(service: "billing" | "orders", path: string): Promise<any[]> {
    const out: any[] = [];
    let cursor = "";
    for (let i = 0; i < 200; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await this.get(service, `${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (r.status !== 200) throw new Error(`${service} ${path}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      out.push(...(r.json.items ?? []));
      cursor = r.json.next_cursor ?? "";
      if (!cursor) break;
    }
    return out;
  }
}

/** psql inside the stack's Postgres container (the gateway's own tables; RLS does not apply to the superuser). */
export function psql(db: string, sql: string): string[][] {
  const out = execFileSync("docker", ["exec", process.env.SOAK_PG_CONTAINER ?? "hostry-soak-postgres-1", "psql", "-U", "hostry", "-d", db, "-tA", "-F", "\t", "-c", sql]).toString();
  return out.split("\n").filter(Boolean).map((l) => l.split("\t"));
}

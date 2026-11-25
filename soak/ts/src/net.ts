import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { HttpTransport, KeyRing, SoftwareSigner, TransportError, bearerAuth, lanAuth, type CredentialEnvelope, type SyncTransport, type SeriesGrant } from "@hostry/client-core";
import { OUTLET_STREAM, createRuntime, openDeviceSession, type Runtime, type RuntimeOptions } from "../../../../app-restaurant/src/runtime";
import type { ApprovalProofInput, DevicePack, PinProver, SessionProofInput } from "../../../../app-restaurant/src/data/auth/pack";
import { ensureDayOpen } from "../../../../app-restaurant/src/data/trading/orders";

export type FxSeries = { id: string; code: string; doc_type: string; status: string };
export type FxDevice = { device_id: string; kind: "pos" | "waiter" | "kds"; name: string; kid: string; pub: string; pkcs8: string; cred: CredentialEnvelope; series: FxSeries[]; pack: Record<string, any> };
export type Staff = { id: string; name: "Asha" | "Ravi" | "Meena" | "Anand"; role: string; pin: string };
export type Fixture = {
  tenant_id: string;
  outlet_id: string;
  brand_id: string;
  identity_pub: string;
  cloud_keys: Record<string, string>;
  devices: FxDevice[];
  hub: { id: string; cred: CredentialEnvelope };
  cloud_url: string;
  hub_url: string;
  ctl_url: string;
  staff: Staff[];
  proof_keys: Record<string, { pin_v: number; proof_key: string }>;
};

/** The fixture of soakgw (devices, LAN credentials) plus the onboarding output (staff, PINs, proof keys). */
export const loadFixture = (path = process.env.SOAK_FIXTURE ?? ""): Fixture => {
  const fx = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const ob = JSON.parse(readFileSync(process.env.SOAK_ONBOARD ?? "", "utf8")) as { staff: Staff[]; proof_keys: Fixture["proof_keys"] };
  return { ...fx, staff: ob.staff, proof_keys: ob.proof_keys };
};

const canonTime = (iso: string): string => new Date(iso).toISOString(); // UTC, milliseconds, like identity's canonTime
const quote = (v: string): string => JSON.stringify(v); // strconv.Quote for the ASCII text of the harness
const hmacB64u = (key: Buffer, msg: string): string => createHmac("sha256", key).update(msg).digest("base64url");

/**
 * Stands in for the native shell's PIN prover (H1: it needs the shell, so the app has only a fixture HMAC): checks the PIN of
 * the staff list and makes identity's REAL proofs with the proof key the onboarding derived from the PIN and the pack's salt
 * (ADR-0005 s5, s7, s8: HMAC-SHA256 over the message identity builds, base64url).
 */
export class HarnessProver implements PinProver {
  constructor(private readonly fx: Fixture) {}
  private key(memberId: string, pin: string, pinV: number): Buffer | undefined {
    const st = this.fx.staff.find((x) => x.id === memberId);
    const pk = this.fx.proof_keys[memberId];
    if (!st || st.pin !== pin || !pk || pk.pin_v !== pinV) return undefined;
    return Buffer.from(pk.proof_key, "base64");
  }
  async sessionProof(i: SessionProofInput): Promise<string | undefined> {
    const k = this.key(i.memberId, i.pin, i.pinV);
    return k ? hmacB64u(k, ["session", i.sid, i.deviceId, i.memberId, i.packV, i.pinV, canonTime(i.openedAt)].join("|")) : undefined;
  }
  /**
   * The app builds the approval record and its action hash (client-core approvalActionHash over intent, permission, requester, target,
   * approval id, reason and values) and hands hash, target and reason to the prover; the message is identity's (ADR-0005 A3.1 item 2).
   */
  async approvalProof(i: ApprovalProofInput): Promise<string | undefined> {
    const k = this.key(i.approverId, i.pin, i.pinV);
    if (!k) return undefined;
    return hmacB64u(k, [["approval", i.actionHash, i.deviceId, i.approverId, i.packV, i.pinV].join("|"), i.approvalId, i.permission, quote(i.target), i.requesterId, canonTime(i.at), quote(i.reason)].join("|"));
  }
}

/** The pack the native shell would hand the app, from the signed pack claims identity issued to the device plus tenancy's series ids. */
export function packOf(fx: Fixture, d: FxDevice): DevicePack {
  const c = d.pack;
  const roleOf = new Map(fx.staff.map((x) => [x.id, x.role]));
  const own = d.series ?? [];
  const grants: SeriesGrant[] = own.map((x) => ({ code: x.code, docType: x.doc_type as SeriesGrant["docType"], state: x.status as SeriesGrant["state"], seriesId: x.id }));
  const invoice = own.find((x) => x.doc_type === "tax_invoice");
  return {
    tenantId: fx.tenant_id,
    brandId: fx.brand_id,
    outletId: fx.outlet_id,
    deviceId: d.device_id,
    deviceKind: d.kind,
    kid: d.kid,
    deviceCode: invoice?.code ?? d.name,
    packV: c.pack_v,
    expiresAt: c.offline_valid_until,
    series: grants,
    members: (c.members as any[]).map((m) => ({ memberId: m.member_id, displayName: m.display_name, role: roleOf.get(m.member_id) ?? "member", perms: m.permissions, pinV: m.pin_v ?? 1 })),
    manualBooks: ((c.manual_books as any[]) ?? []).map((b) => b.code),
  };
}

/** Deterministic virtual clock, pushed to the gateway and hub before every sync round (they read the same time). */
export class Clock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
  minutes(n: number): void {
    this.advance(n * 60_000);
  }
}

/** The proof the stub directory mints for (device, actor): "p1:" + the first 24 hex digits of HMAC-SHA256(secret, device|actor). */
export function stubProof(device: string, actor: string): string {
  return "p1:" + createHmac("sha256", "test-only-proof-secret").update(`${device}|${actor}`).digest("hex").slice(0, 24);
}

export type Link = { up: boolean };
type Fault = { kind: "lose_ack"; n: number };

/** A real HTTP transport behind a switch: a cut link refuses the call; `lose_ack` lets the server apply the push and loses the answer. */
export class GatedTransport implements SyncTransport {
  faults: Fault[] = [];
  /** What the upstream refused or held, for the report (never dropped silently). */
  refusals: Array<Record<string, unknown>> = [];
  holds: Array<Record<string, unknown>> = [];
  calls = { hello: 0, push: 0, pull: 0, refused: 0 };
  constructor(
    private readonly inner: SyncTransport,
    private readonly link: Link,
    private readonly label: string,
  ) {}
  private gate(): void {
    if (!this.link.up) {
      this.calls.refused++;
      throw new TransportError(0, `${this.label}: link down`, true);
    }
  }
  async hello(req: Parameters<SyncTransport["hello"]>[0]) {
    this.gate();
    this.calls.hello++;
    return this.inner.hello(req);
  }
  async push(req: Parameters<SyncTransport["push"]>[0]) {
    this.gate();
    this.calls.push++;
    const res = await this.inner.push(req);
    if (res.refused?.length) this.refusals.push(...res.refused.map((r) => ({ ...r, via: this.label })));
    if (res.held?.length) this.holds.push(...res.held.map((h) => ({ ...h, via: this.label })));
    const f = this.faults[0];
    if (f && f.kind === "lose_ack" && req.items.length > 0) {
      if (--f.n <= 0) this.faults.shift();
      throw new TransportError(0, `${this.label}: answer lost after the server applied the push`, true);
    }
    return res;
  }
  async pull(req: Parameters<SyncTransport["pull"]>[0]) {
    this.gate();
    this.calls.pull++;
    return this.inner.pull(req);
  }
}

export class Ctl {
  constructor(readonly url: string) {}
  private async post(path: string): Promise<void> {
    const r = await fetch(this.url + path, { method: "POST" });
    if (!r.ok) throw new Error(`ctl ${path}: ${r.status} ${await r.text()}`);
  }
  async token(device: string): Promise<string> {
    const r = await fetch(`${this.url}/soak/token?device=${encodeURIComponent(device)}`);
    return r.text();
  }
  clock(ms: number): Promise<void> {
    return this.post(`/soak/clock?ms=${ms}`);
  }
  uplink(up: boolean): Promise<void> {
    return this.post(`/soak/uplink?up=${up ? 1 : 0}`);
  }
  hub(op: "stop" | "start" | "wipe"): Promise<void> {
    return this.post(`/soak/hub?op=${op}`);
  }
  /** One hub round with the cloud; resolves to null while the internet is cut or the hub is down. */
  async hubSync(): Promise<{ pushed: number; pulled: number; refused: number; epoch_changed: boolean; refusals?: unknown[] } | null> {
    const r = await fetch(`${this.url}/soak/hub?op=sync`, { method: "POST" });
    if (!r.ok) return null;
    return (await r.json()) as { pushed: number; pulled: number; refused: number; epoch_changed: boolean; refusals?: unknown[] };
  }
  /** The real gateway process, stopped or started by the stack script (up-full.sh stop|start|restart sync). */
  async gateway(op: "down" | "up" | "restart"): Promise<void> {
    const verb = op === "down" ? "stop" : op === "up" ? "start" : "restart";
    execFileSync("bash", [`${process.env.SOAK_SCRIPTS ?? "/mnt/d/40_Projects/Ventures/hostry-repos/e2e-tests/soak/scripts"}/stack.sh`, verb, "sync"], { stdio: "pipe" });
  }
  /** A cloud restore stamps a newer restore epoch (svc-sync's dev epoch table); the gateway is restarted to read it. */
  async epoch(id: string): Promise<void> {
    await this.post(`/soak/epoch?id=${encodeURIComponent(id)}`);
    await this.gateway("restart");
  }
}

export type Dev = {
  fx: FxDevice;
  rt: Runtime;
  hubT: GatedTransport;
  cloudT: GatedTransport;
  lan: Link;
  net: Link;
  /** Every op this device recorded (intent and reference), for the claims that name specific ops. */
  opLog: Array<{ intent: string; origin: string; stream: string; seq: number }>;
  powered: boolean;
  signIn(name: Name): Promise<void>;
};

export type Name = "Asha" | "Ravi" | "Meena" | "Anand";

/** The outlet as the soak sees it: real gateway, real hub, real HTTP, links that can be cut per device. */
export class SoakNet {
  readonly ring: KeyRing;
  readonly devs = new Map<string, Dev>();
  readonly ctl: Ctl;
  internet = false;
  /** Set after a cloud restore: the hub re-offers its pii-bearing ops on every round for a day (see settle). */
  piiResend = false;
  hubRounds: Array<{ pushed: number; pulled: number; refused: number; epoch_changed: boolean; refusals?: unknown[] }> = [];
  constructor(readonly fx: Fixture, readonly clock: Clock) {
    this.ring = new KeyRing(fx.identity_pub);
    this.ctl = new Ctl(fx.ctl_url);
  }

  /** A member of the staff by name: id and PIN. */
  S(name: Name): Staff {
    return this.fx.staff.find((x) => x.name === name)!;
  }

  static async create(fx: Fixture, clock: Clock): Promise<SoakNet> {
    const n = new SoakNet(fx, clock);
    for (const [kid, pub] of Object.entries(fx.cloud_keys)) await n.ring.addCloudKey(kid, pub);
    await n.ctl.clock(clock.ms);
    return n;
  }

  /** Bring up one device (by fixture name). `seed` makes it hold the demo configuration, like the app's first device. */
  async add(name: string, o: Pick<RuntimeOptions, "store"> & { openDay?: boolean; offsetMs?: number; links?: { lan: boolean; net: boolean } } = {}): Promise<Dev> {
    const d = this.fx.devices.find((x) => x.name === name);
    if (!d) throw new Error(`no fixture device ${name}`);
    for (const p of this.fx.devices) await this.ring.add(p.device_id, p.kid, p.pub);
    const signer = await SoftwareSigner.import(d.kid, d.pkcs8, d.pub);
    const lan: Link = { up: o.links?.lan ?? true };
    const net: Link = { up: o.links?.net ?? false };
    const offsetMs = o.offsetMs ?? 0;
    if (offsetMs) this.offsets.set(name, offsetMs);
    const devNow = (): number => this.clock.ms + offsetMs;
    const hubT = new GatedTransport(
      new HttpTransport({ baseUrl: this.fx.hub_url, auth: lanAuth({ cred: d.cred, signer, identityPub: this.fx.identity_pub, outlet: this.fx.outlet_id, nowSeconds: () => Math.floor(this.clock.ms / 1000) }) }),
      lan,
      `lan:${name}`,
    );
    const cloudT = new GatedTransport(new HttpTransport({ baseUrl: this.fx.cloud_url, auth: bearerAuth(() => this.ctl.token(d.device_id)) }), net, `net:${name}`);
    const prover = new HarnessProver(this.fx);
    const rt = await createRuntime({
      now: devNow,
      ...(o.store ? { store: o.store } : {}),
      pack: packOf(this.fx, d),
      prover,
      signer,
      upstream: { hub: hubT, cloud: cloudT, verifier: this.ring },
    });
    const record = rt.engine.record.bind(rt.engine);
    const opLog: Dev["opLog"] = o.store ? (this.devs.get(name)?.opLog ?? []) : [];
    // Observation only (the claims that name specific ops read opLog); the spec passes through unchanged.
    rt.engine.record = (async (spec: Parameters<typeof record>[0]) => {
      const op = await record(spec);
      opLog.push({ intent: spec.intent, origin: op.origin, stream: op.stream, seq: op.seq });
      return op;
    }) as typeof rt.engine.record;
    const net_ = this;
    const dev: Dev = {
      fx: d,
      rt,
      hubT,
      cloudT,
      lan,
      net,
      opLog,
      powered: true,
      async signIn(who) {
        const st = net_.S(who);
        const r = await rt.identity.signIn(st.id, st.pin);
        if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
        rt.setSession(r.session);
      },
    };
    this.devs.set(name, dev);
    // A KDS screen has no PIN: the app's own openDeviceSession (type device, no proof) is called on its first start; the writer renews it per business day.
    if (d.kind === "kds") await openDeviceSession(rt);
    if (o.openDay) {
      const day = await rt.identity.signIn(this.S("Meena").id, this.S("Meena").pin);
      if (day.ok) {
        rt.setSession(day.session);
        await ensureDayOpen(rt.ctx);
        rt.setSession(undefined);
      }
    }
    return dev;
  }

  /** Kill a device process and start it again on the same disk (its store) and key: what it stored is all it has. */
  async restart(name: string): Promise<Dev> {
    const old = this.dev(name);
    old.powered = false;
    this.retired.push(old); // what its printers captured before it died still counts
    return this.add(name, { store: old.rt.store, offsetMs: this.offsets.get(name) ?? 0, links: { lan: old.lan.up, net: old.net.up } });
  }

  readonly offsets = new Map<string, number>();
  readonly retired: Dev[] = [];

  dev(name: string): Dev {
    const d = this.devs.get(name);
    if (!d) throw new Error(`device ${name} not started`);
    return d;
  }

  /** LAN up or down for every device (hub, router and the Wi-Fi: a blackout is `lan(false)`). */
  lan(up: boolean): void {
    for (const d of this.devs.values()) d.lan.up = up;
  }

  /** The internet for the hub and for every device's direct path. */
  async setInternet(up: boolean): Promise<void> {
    this.internet = up;
    await this.ctl.uplink(up);
    for (const d of this.devs.values()) d.net.up = up;
  }

  /** One round per powered device, twice (what the others pushed in the first pass is pulled in the second). */
  async sync(): Promise<void> {
    await this.ctl.clock(this.clock.ms);
    for (let i = 0; i < 2; i++) for (const d of this.devs.values()) if (d.powered) await d.rt.sync.syncNow();
    for (const d of this.devs.values()) if (d.powered) await d.rt.data.refresh();
  }

  /** Repeat rounds until every vector, the hub's and the cloud's stops moving. */
  async settle(maxRounds = 60): Promise<number> {
    let last = "";
    const trace: string[] = [];
    for (let i = 1; i <= maxRounds; i++) {
      this.clock.advance(5_000);
      await this.ctl.clock(this.clock.ms);
      const hr = this.internet ? await this.ctl.hubSync() : null;
      await this.sync();
      if (hr) this.hubRounds.push(hr);
      const vs = await Promise.all([...this.devs.values()].filter((d) => d.powered).map(async (d) => Object.entries(await d.rt.engine.vector()).sort()));
      const sig = JSON.stringify([vs, hr?.pushed ?? 0, hr?.pulled ?? 0]);
      trace.push(`round ${i}: hub ${hr ? `pushed ${hr.pushed} pulled ${hr.pulled} refused ${hr.refused}` : "no round"}; vectors ${last === "" || sig.split("]],")[0] !== last.split("]],")[0] ? "moved" : "same"}`);
      // After a cloud restore the engine offers the pii-bearing ops again on EVERY round for a day (svc-sync engine ResendPII, ADR-0014 A3.1): the hub pushes
      // them each time and the cloud already holds them, so `pushed` is not progress then; the vectors and what is pulled are.
      if (sig === last && (!hr || (hr.pulled === 0 && (hr.pushed === 0 || this.piiResend)))) return i;
      last = sig;
    }
    throw new Error(`settle: did not quiesce in ${maxRounds} rounds; last rounds: ${trace.slice(-4).join(" | ")}`);
  }
}

export { OUTLET_STREAM };

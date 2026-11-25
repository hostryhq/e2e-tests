import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpTransport, KeyRing, SoftwareSigner, TransportError, bearerAuth, lanAuth, type CredentialEnvelope, type SyncTransport, type SeriesGrant } from "@hostry/client-core";
import { OUTLET_STREAM, createRuntime, type Runtime, type RuntimeOptions } from "../../../../app-restaurant/src/runtime";
import { ensureDayOpen } from "../../../../app-restaurant/src/data/trading/orders";

export type FxDevice = { device_id: string; kind: "pos" | "waiter" | "kds"; name: string; kid: string; pub: string; pkcs8: string; cred: CredentialEnvelope; series: SeriesGrant[] };
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
};

export const loadFixture = (path = process.env.SOAK_FIXTURE ?? ""): Fixture => JSON.parse(readFileSync(path, "utf8")) as Fixture;

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
  async hubSync(): Promise<{ pushed: number; pulled: number; refused: number; epoch_changed: boolean } | null> {
    const r = await fetch(`${this.url}/soak/hub?op=sync`, { method: "POST" });
    if (!r.ok) return null;
    return (await r.json()) as { pushed: number; pulled: number; refused: number; epoch_changed: boolean };
  }
  gateway(op: "down" | "up" | "restart"): Promise<void> {
    return this.post(`/soak/gateway?op=${op}`);
  }
  async erase(ref: { origin: string; stream: string; seq: number }): Promise<{ status: number; body: string }> {
    const r = await fetch(`${this.url}/soak/erase?origin=${encodeURIComponent(ref.origin)}&stream=${encodeURIComponent(ref.stream)}&seq=${ref.seq}`, { method: "POST" });
    return { status: r.status, body: await r.text() };
  }
  epoch(id: string): Promise<void> {
    return this.post(`/soak/gateway?op=epoch&id=${encodeURIComponent(id)}`);
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
const PINS = { Asha: ["m-asha", "1111"], Ravi: ["m-ravi", "2222"], Meena: ["m-meena", "3333"], Anand: ["m-anand", "4444"] } as const;

/** The outlet as the soak sees it: real gateway, real hub, real HTTP, links that can be cut per device. */
export class SoakNet {
  readonly ring: KeyRing;
  readonly devs = new Map<string, Dev>();
  readonly ctl: Ctl;
  internet = false;
  hubRounds: Array<{ pushed: number; pulled: number; refused: number; epoch_changed: boolean }> = [];
  constructor(readonly fx: Fixture, readonly clock: Clock) {
    this.ring = new KeyRing(fx.identity_pub);
    this.ctl = new Ctl(fx.ctl_url);
  }

  static async create(fx: Fixture, clock: Clock): Promise<SoakNet> {
    const n = new SoakNet(fx, clock);
    for (const [kid, pub] of Object.entries(fx.cloud_keys)) await n.ring.addCloudKey(kid, pub);
    await n.ctl.clock(clock.ms);
    return n;
  }

  /** Bring up one device (by fixture name). `seed` makes it hold the demo configuration, like the app's first device. */
  async add(name: string, o: Pick<RuntimeOptions, "seed" | "store"> & { openDay?: boolean; offsetMs?: number; links?: { lan: boolean; net: boolean } } = {}): Promise<Dev> {
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
    const rt = await createRuntime({
      now: devNow,
      ...(o.store ? { store: o.store } : {}),
      seed: o.seed ?? false,
      deviceKind: d.kind,
      deviceCode: d.name,
      billing: d.kind !== "kds",
      deviceId: d.device_id,
      signer,
      upstream: { hub: hubT, cloud: cloudT, verifier: this.ring },
    });
    // The app's StubIdentity produces no PIN-derived proof, so the gateway would void every config-class op as
    // `proof_failed` and flag every other op `attribution_unverified`. The stub directory accepts the proof it would
    // itself mint for (device, actor); stamp it on every op the way the auth layer is meant to (reported as a finding).
    const record = rt.engine.record.bind(rt.engine);
    const opLog: Dev["opLog"] = o.store ? (this.devs.get(name)?.opLog ?? []) : [];
    rt.engine.record = (async (spec: Parameters<typeof record>[0]) => {
      const actor = spec.actor ?? rt.engine.session?.actor;
      const op = await record({ ...spec, ...(actor && actor !== "system" && !spec.proof ? { proof: stubProof(d.device_id, actor) } : {}) });
      opLog.push({ intent: spec.intent, origin: op.origin, stream: op.stream, seq: op.seq });
      return op;
    }) as typeof rt.engine.record;
    // The series come from tenancy (through identity's pack), not from the app's demo grants.
    if (!o.store) await rt.engine.setSeriesGrants(d.series ?? []); // a restarted device keeps the grants and counters it stored
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
        const [mid, pin] = PINS[who];
        const r = await rt.identity.signIn(mid, pin);
        if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
        rt.setSession(r.session);
      },
    };
    this.devs.set(name, dev);
    if (o.openDay) {
      const day = await rt.identity.signIn("m-meena", "3333");
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
    for (let i = 1; i <= maxRounds; i++) {
      this.clock.advance(5_000);
      await this.ctl.clock(this.clock.ms);
      const hr = this.internet ? await this.ctl.hubSync() : null;
      await this.sync();
      if (hr) this.hubRounds.push(hr);
      const vs = await Promise.all([...this.devs.values()].filter((d) => d.powered).map((d) => d.rt.engine.vector()));
      const sig = JSON.stringify([vs, hr?.pushed ?? 0, hr?.pulled ?? 0]);
      if (sig === last && (!hr || (hr.pushed === 0 && hr.pulled === 0))) return i;
      last = sig;
    }
    throw new Error(`settle: did not quiesce in ${maxRounds} rounds`);
  }
}

export { OUTLET_STREAM };

import { createHmac } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { HttpTransport, KeyRing, LanTransport, SoftwareSigner, TransportError, bearerAuth, type SyncTransport, type SeriesGrant } from "@hostry/client-core";
import { nodeLanChannel } from "@hostry/client-core/node";
import { createRuntime, openDeviceSession, type Runtime, type RuntimeOptions } from "../../../../app-restaurant/src/runtime";
import { loadVerifiedPack, type ApprovalProofInput, type DevicePack, type PinProver, type SessionProofInput } from "../../../../app-restaurant/src/data/auth/pack";
import { ensureDayOpen } from "../../../../app-restaurant/src/data/trading/orders";

export type FxSeries = { id: string; code: string; doc_type: string; status: string };
export type FxDevice = { device_id: string; kind: "pos" | "waiter" | "kds"; name: string; kid: string; pub: string; pkcs8: string; series: FxSeries[]; pack: Record<string, any>; pack_jws: string };
export type Staff = { id: string; name: "Asha" | "Ravi" | "Meena" | "Anand"; role: string; pin: string };
export type Fixture = {
  tenant_id: string;
  outlet_id: string;
  brand_id: string;
  cloud_keys: Record<string, string>;
  devices: FxDevice[];
  /** The real cmd/hub the driver runs: its state directory and listen address, and the (switchable) identity and cloud URLs it uses. */
  hub: { state_dir: string; addr: string; cloud_url: string; identity_url: string; identity_direct_url: string };
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

/**
 * The pack the native shell would store at activation: the view of the signed pack claims identity issued to the device (its own `store`
 * and `issuer_env` included) plus tenancy's series ids, together with the pack's JWS. The app's own `loadVerifiedPack` then checks the
 * signature and that the view agrees with the signed claims, so a wrong view or a bad signature fails the run here.
 */
export async function loadPack(fx: Fixture, d: FxDevice): Promise<DevicePack> {
  const c = d.pack;
  const roleOf = new Map(fx.staff.map((x) => [x.id, x.role]));
  const own = d.series ?? [];
  const grants: SeriesGrant[] = own.map((x) => ({ code: x.code, docType: x.doc_type as SeriesGrant["docType"], state: x.status as SeriesGrant["state"], seriesId: x.id }));
  const invoice = own.find((x) => x.doc_type === "tax_invoice");
  const view = {
    tenantId: fx.tenant_id,
    brandId: fx.brand_id,
    outletId: fx.outlet_id,
    deviceId: d.device_id,
    deviceKind: d.kind,
    kid: d.kid,
    store: c.device?.store ?? "unprotected",
    issuerEnv: c.issuer_env,
    deviceCode: invoice?.code ?? d.name,
    packV: c.pack_v,
    expiresAt: c.offline_valid_until,
    series: grants,
    members: (c.members as any[]).map((m) => ({ memberId: m.member_id, displayName: m.display_name, role: roleOf.get(m.member_id) ?? "member", perms: m.permissions, pinV: m.pin_v ?? 1 })),
    manualBooks: ((c.manual_books as any[]) ?? []).map((b) => b.code),
    // The signed `entitlements` claim as identity put it in the pack (ADR-0014 T10); absent or malformed means none, trading continues.
    ...(c.entitlements ? { entitlements: c.entitlements } : {}),
    jws: d.pack_jws,
  };
  return loadVerifiedPack(view);
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

/** The real cmd/hub as a child process of the driver, and the few things soakgw still does (internet switch, wall clock, tokens, epoch). */
export class Ctl {
  private proc: ChildProcess | undefined;
  constructor(readonly url: string, private readonly fx: Fixture) {}
  private async post(path: string): Promise<void> {
    const r = await fetch(this.url + path, { method: "POST" });
    if (!r.ok) throw new Error(`ctl ${path}: ${r.status} ${await r.text()}`);
  }
  async token(device: string): Promise<string> {
    const r = await fetch(`${this.url}/soak/token?device=${encodeURIComponent(device)}`);
    return r.text();
  }
  /** The wall clock of the real hub, gateway and identity (nothing in them can be set). */
  async wallNow(): Promise<number> {
    return Number(await (await fetch(`${this.url}/soak/now`)).text());
  }
  /** Kept so the scenarios read the same: the real gateway and hub run on wall time and are not set; the virtual clock is the devices'. */
  clock(_ms: number): Promise<void> {
    return Promise.resolve();
  }
  uplink(up: boolean): Promise<void> {
    return this.post(`/soak/uplink?up=${up ? 1 : 0}`);
  }
  private hubEnv(): NodeJS.ProcessEnv {
    const h = this.fx.hub;
    const work = process.env.SOAK_WORK ?? "";
    const tag = process.env.SOAK_TAG ?? "";
    return {
      PATH: process.env.PATH ?? "",
      HOSTRY_ENV: "dev",
      SYNC_HUB_STATE_DIR: h.state_dir,
      SYNC_HUB_KEY_PROVIDER: "dev",
      SYNC_HUB_DEV_KEY_FILE: `${work}/${tag}-hub/dev.key`,
      SYNC_HUB_IDENTITY_URL: h.identity_url,
      SYNC_HUB_CLOUD_URL: h.cloud_url,
      SYNC_HUB_ADDR: h.addr,
      SYNC_HUB_MDNS: "0",
      // The dev key provider is NOT protection (the key sits beside the file), so this hub declares store unprotected; the lift lets it
      // keep customer details anyway so T1 can see where they go. The placement on the tills is what the claim checks.
      SYNC_HUB_DEV_PII_LIFT: "1",
    };
  }
  private async listening(): Promise<void> {
    const [host, port] = this.fx.hub.addr.split(":") as [string, string];
    for (let i = 0; i < 150; i++) {
      const ok = await new Promise<boolean>((res) => {
        const c = connect({ host, port: Number(port) });
        c.once("connect", () => (c.destroy(), res(true)));
        c.once("error", () => res(false));
      });
      if (ok) return;
      if (this.proc && this.proc.exitCode !== null) throw new Error(`the hub exited with ${this.proc.exitCode} (see ${process.env.SOAK_WORK}/${process.env.SOAK_TAG}.hub.log)`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the hub did not listen");
  }
  /** Run the real cmd/hub (hub run) on its state directory. */
  async hubStart(): Promise<void> {
    const work = process.env.SOAK_WORK ?? "";
    const tag = process.env.SOAK_TAG ?? "";
    const log = openSync(`${work}/${tag}.hub.log`, "a");
    this.proc = spawn(process.env.SOAK_HUB_BIN ?? "", ["run"], { env: this.hubEnv(), stdio: ["ignore", log, log] });
    writeFileSync(`${work}/${tag}.hub.pid`, String(this.proc.pid));
    await this.listening();
  }
  /** The hub process dies (SIGKILL: a crash or a power cut, nothing flushed by the hub). */
  async hubStop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    if (p.exitCode === null) {
      const done = new Promise<void>((r) => p.once("exit", () => r()));
      p.kill("SIGKILL");
      await done;
    }
  }
  /** A new disk: the old state is gone, so the replaced hub is a NEW device with a NEW activation code (ADR-0002 A3.1 item 6). */
  async hubWipe(onboard: { owner_mobile: string; outlet_id: string }): Promise<void> {
    await this.hubStop();
    execFileSync("bash", [`${process.env.SOAK_SCRIPTS_DIR}/hub-activate.sh`, process.env.SOAK_WORK ?? "", process.env.SOAK_TAG ?? "", onboard.owner_mobile, onboard.outlet_id], { stdio: "pipe" });
    await this.hubStart();
  }
  async hub(op: "stop" | "start" | "wipe"): Promise<void> {
    if (op === "stop") return this.hubStop();
    if (op === "start") return this.hubStart();
    const ob = JSON.parse(readFileSync(process.env.SOAK_ONBOARD ?? "", "utf8")) as { owner_mobile: string; outlet_id: string };
    return this.hubWipe(ob);
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
  constructor(readonly fx: Fixture, readonly clock: Clock) {
    this.ring = new KeyRing();
    this.ctl = new Ctl(fx.ctl_url, fx);
  }

  /** A member of the staff by name: id and PIN. */
  S(name: Name): Staff {
    return this.fx.staff.find((x) => x.name === name)!;
  }

  static async create(fx: Fixture, clock: Clock): Promise<SoakNet> {
    const n = new SoakNet(fx, clock);
    for (const [kid, pub] of Object.entries(fx.cloud_keys)) await n.ring.addCloudKey(kid, pub);
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
    const pack = await loadPack(this.fx, d);
    // The LAN channel of the node runtime (client-core/node): TLS 1.3, any certificate accepted and the peer proven by helloLan and openLanSession
    // with the identity-signed credentials of the packs (the hub's own credential is checked against the identity keys of THIS device's pack).
    const lanT = new LanTransport({
      channel: nodeLanChannel({ baseUrl: this.fx.hub_url }),
      credential: d.pack.device.credential as string,
      deviceId: d.device_id,
      signer,
      identityKeys: () => pack.identityKeys ?? {},
      tenantId: this.fx.tenant_id,
      outletId: this.fx.outlet_id,
      nowSeconds: () => Math.floor(this.clock.ms / 1000),
    });
    const hubT = new GatedTransport(lanT, lan, `lan:${name}`);
    const cloudT = new GatedTransport(new HttpTransport({ baseUrl: this.fx.cloud_url, auth: bearerAuth(() => this.ctl.token(d.device_id)) }), net, `net:${name}`);
    const prover = new HarnessProver(this.fx);
    const rt = await createRuntime({
      now: devNow,
      ...(o.store ? { store: o.store } : {}),
      pack,
      target: "native", // a native development build: the pack's store claim (protected) and its issuer_env (dev) are honoured
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

  /**
   * Repeat rounds until the devices agree with each other and, while the internet is up, with the cloud, and nothing has moved for two rounds.
   * The real hub syncs with the cloud on its own timer (about every 2 s, up to 75 s after the internet returns: its own backoff), so a round
   * waits on the wall clock when the internet is up; with it cut only the LAN is awaited.
   */
  async settle(maxRounds = 60): Promise<number> {
    let last = "";
    let still = 0;
    const trace: string[] = [];
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    for (let i = 1; i <= maxRounds; i++) {
      this.clock.advance(5_000);
      if (this.internet) await wait(2_500);
      await this.sync();
      const powered = [...this.devs.values()].filter((d) => d.powered);
      const vs = await Promise.all(powered.map(async (d) => Object.entries(await d.rt.engine.vector()).sort()));
      let cloudSig = "";
      let agree = vs.every((v) => JSON.stringify(v) === JSON.stringify(vs[0]));
      if (this.internet) {
        const h = await powered[0]!.cloudT.hello({ protocol: 1 }).catch(() => undefined);
        const cv: Record<string, number> = {};
        for (const [k, v] of Object.entries(((h as { vector?: Record<string, number> } | undefined)?.vector) ?? {})) if (k.endsWith(`/outlet:${this.fx.outlet_id}`)) cv[k.split("/")[0]!] = v;
        cloudSig = JSON.stringify(Object.entries(cv).sort());
        const mine = (vs[0] ?? []).filter(([, n]) => (n as number) > 0).map(([o, n]) => [o, n] as [string, number]);
        agree = agree && h !== undefined && JSON.stringify(mine) === cloudSig;
      }
      const sig = JSON.stringify([vs, cloudSig]);
      still = sig === last ? still + 1 : 0;
      trace.push(`round ${i}: devices ${agree ? "agree" : "differ"}; ${still} quiet`);
      if (agree && still >= (this.internet ? 2 : 1)) return i;
      last = sig;
      if (Date.now() - t0 > 240_000) break;
    }
    throw new Error(`settle: did not quiesce in ${maxRounds} rounds; last rounds: ${trace.slice(-4).join(" | ")}`);
  }
}


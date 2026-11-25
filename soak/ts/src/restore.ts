import { execFileSync } from "node:child_process";
import * as T from "../../../../app-restaurant/src/data/trading";
import type { SoakNet } from "./net";
import { psql } from "./svc";

const pg = (args: string[]): string => execFileSync("docker", ["exec", process.env.SOAK_PG_CONTAINER ?? "hostry-soak-postgres-1", ...args]).toString();

/**
 * A cloud restore (ADR-0002 A2.4): the gateway database is rolled back to a backup taken earlier, a newer restore epoch is
 * stamped, and the gateway restarts. Everything the cloud accepted after the backup is gone from it; the devices and the hub
 * still hold those ops and must re-offer them. Returns what happened, as evidence.
 */
export async function cloudRestore(net: SoakNet, tenant: string, seed: number): Promise<Record<string, unknown>> {
  const ev: Record<string, unknown> = {};
  const count = (): number => Number(psql("sync", `select count(*) from ops where tenant_id='${tenant}'`)[0]![0]);
  ev.ops_at_backup = count();
  pg(["sh", "-c", "pg_dump -U hostry -d sync --data-only --disable-triggers > /tmp/soak-sync-backup.sql"]);
  // New activity after the backup (the day is closed, so no sales): bill reprints on the counters, which the cloud accepts. Reprints are
  // append ops; the earlier availability changes were last-writer-wins configuration ops, which the real gateway holds for review when the
  // device clock is more than 10 minutes ahead of its own (and the virtual day runs hours ahead of the wall clock).
  for (const [i, name] of ["A07", "A08", "A07", "A08", "A07", "A08"].entries()) {
    const d = net.dev(name);
    await d.signIn("Meena");
    const bills = ((await d.rt.engine.rows("bill")) as Array<{ id: string; number: string }>).sort((a, b) => (a.number < b.number ? -1 : 1));
    await T.reprintBill(d.rt.ctx, bills[i % bills.length]!.id);
  }
  await net.settle(60);
  ev.ops_before_restore = count();
  const hashOf = async (): Promise<Record<string, string>> => Object.fromEntries(await Promise.all([...net.devs.values()].map(async (d) => [d.fx.name, await d.rt.engine.stateHash()] as const)));
  ev.hashes_before = await hashOf();
  // The disaster: the cloud database goes back to the backup.
  await net.ctl.gateway("down");
  const tables = psql("sync", "select table_name from information_schema.tables where table_schema='public' and table_name <> 'schema_migrations'").map((r) => r[0]!);
  pg(["psql", "-U", "hostry", "-d", "sync", "-c", `TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`]);
  pg(["sh", "-c", "psql -U hostry -d sync -q < /tmp/soak-sync-backup.sql > /dev/null"]);
  ev.ops_after_restore = count();
  await net.ctl.epoch(`soak-restore-${seed}`);
  // The nodes meet the new epoch and re-offer what the restored cloud lost.
  let rounds = 0;
  const t0 = Date.now();
  for (let k = 0; k < 6; k++) {
    rounds = await net.settle(60);
    if (count() >= (ev.ops_before_restore as number)) break;
  }
  ev.ops_after_reoffer = count();
  ev.hashes_after = await hashOf();
  ev.settle_rounds = rounds;
  ev.reoffer_wall_ms = Date.now() - t0;
  ev.hub_epoch_changed = net.hubRounds.some((r) => r.epoch_changed);
  return ev;
}

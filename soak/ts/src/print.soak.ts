import { describe, expect, it } from "vitest";
import { publishConfig } from "./config";
import { Clock, SoakNet, loadFixture } from "./net";

// Diagnostic of the print numbering mode: what the devices hold after the configuration push.
describe("print mode configuration", () => {
  it("shows billing_settings on a counter and a captain", async () => {
    const fx = loadFixture();
    const clock = new Clock(Date.now() - 10_000);
    const net = await SoakNet.create(fx, clock);
    const counter = await net.add("A07");
    const cap = await net.add("B3K");
    await net.setInternet(true);
    const rep = await publishConfig(net, counter, "print");
    await net.settle();
    for (const d of [counter, cap]) {
      const v = await d.rt.engine.vector();
      const rows = Object.fromEntries(await Promise.all(["billing_settings", "outlet_tax_profile", "tax_rule_set", "tax_rule", "item", "category"].map(async (e) => [e, ((await d.rt.engine.rows(e)) as unknown[]).length])));
      console.log("VECTOR", d.fx.name, JSON.stringify(v), JSON.stringify(rows), "held", JSON.stringify(d.rt.engine.heldOps()), "clockq", JSON.stringify(await d.rt.engine.clockQuarantine()), "refusals", JSON.stringify(d.hubT.refusals.slice(0, 3)), JSON.stringify(d.hubT.holds.slice(0, 3)));
    }
    for (const d of [counter, cap]) console.log("SETTINGS", d.fx.name, JSON.stringify(d.rt.data.snapshot().list("billing_settings")), "conflicts", JSON.stringify(await d.rt.engine.conflicts()), JSON.stringify(rep.emits.map((e) => e.status)));
    expect(true).toBe(true);
  });
});

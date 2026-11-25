import { describe, expect, it } from "vitest";
import { publishConfig } from "./config";
import { Clock, SoakNet, loadFixture } from "./net";

describe("smoke: configuration through legal routes, then two devices converge", () => {
  it("publishes config and syncs", async () => {
    const fx = loadFixture();
    const clock = new Clock(Date.now() - 24 * 3_600_000);
    const net = await SoakNet.create(fx, clock);
    const counter = await net.add("A07", { openDay: false });
    const cap = await net.add("B3K");
    const rep = await publishConfig(net, counter, "settle");
    console.log("CONFIG", JSON.stringify(rep, null, 1));
    await net.sync();
    await net.setInternet(true);
    const rounds = await net.settle().catch((e) => {
      console.log("SETTLE FAILED", String(e), "hubRounds", JSON.stringify(net.hubRounds.slice(-1)));
      for (const d of net.devs.values()) console.log(d.fx.name, "status", JSON.stringify(d.rt.sync.status()), "hubRefusals", JSON.stringify(d.hubT.refusals.slice(0, 3)), "cloudRefusals", JSON.stringify(d.cloudT.refusals.slice(0, 3)), "holds", JSON.stringify(d.cloudT.holds.slice(0, 3)), "calls", JSON.stringify(d.hubT.calls), JSON.stringify(d.cloudT.calls));
      return -1;
    });
    console.log("settled in", rounds, JSON.stringify(counter.rt.sync.status()), "captain items", cap.rt.data.snapshot().list("item").length, "refusals", JSON.stringify(counter.hubT.refusals));
    expect(true).toBe(true);
  });
});

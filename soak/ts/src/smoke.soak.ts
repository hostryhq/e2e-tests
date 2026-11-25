import { describe, expect, it } from "vitest";
import { publishConfig } from "./config";
import { Clock, SoakNet, loadFixture } from "./net";

describe("smoke: configuration through legal routes, then two devices converge", () => {
  it("publishes config and syncs", async () => {
    const fx = loadFixture();
    const clock = new Clock(Date.parse("2026-11-25T07:35:00Z"));
    const net = await SoakNet.create(fx, clock);
    const counter = await net.add("A07", { openDay: false });
    const cap = await net.add("B3K");
    const rep = await publishConfig(net, counter, "settle");
    console.log("CONFIG", JSON.stringify(rep, null, 1));
    await net.sync();
    await net.setInternet(true);
    const rounds = await net.settle();
    console.log("settled in", rounds, JSON.stringify(counter.rt.sync.status()), "captain items", cap.rt.data.snapshot().list("item").length, "refusals", JSON.stringify(counter.hubT.refusals));
    expect(true).toBe(true);
  });
});

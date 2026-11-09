import { describe, it, expect } from "vitest";
import { bisect } from "../src/poll.ts";

describe("bisect", () => {
  it("finds the first height where the predicate turns true", async () => {
    const calls: number[] = [];
    const h = await bisect(1000, 2000, async (x) => (calls.push(x), x >= 1337));
    expect(h).toBe(1337);
    expect(calls.length).toBeLessThanOrEqual(11); // log2(1000) ≈ 10
  });
  it("returns hi when the change is at hi", async () => {
    expect(await bisect(5, 6, async (x) => x >= 6)).toBe(6);
  });
});

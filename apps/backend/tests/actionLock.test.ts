import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { withCallbackActionLock } from "../src/bot/callback-action.js";
import { withActionLock } from "../src/foundation/action-lock.js";

/** Resolves only when the test says so, so two calls can be genuinely
 * concurrent rather than merely sequential-with-awaits. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withActionLock", () => {
  it("acknowledges a duplicate callback through the shared adapter", async () => {
    const gate = deferred<string>();
    let answers = 0;
    const ctx = {
      answerCallbackQuery: async () => {
        answers += 1;
      },
    } as unknown as Context;
    const first = withCallbackActionLock(ctx, "callback:1", async () => gate.promise);

    expect(await withCallbackActionLock(ctx, "callback:1", async () => "second")).toEqual({ ok: false });
    expect(answers).toBe(1);

    gate.resolve("first");
    expect(await first).toEqual({ ok: true, value: "first" });
  });

  it("runs the action and returns its value", async () => {
    expect(await withActionLock("publish:1", async () => "published")).toEqual({ ok: true, value: "published" });
  });

  it("rejects a second tap while the first is still in flight, without running it", async () => {
    const gate = deferred<string>();
    let runs = 0;
    const first = withActionLock("publish:1", async () => {
      runs += 1;
      return gate.promise;
    });

    expect(
      await withActionLock("publish:1", async () => {
        runs += 1;
        return "second";
      }),
    ).toEqual({ ok: false });
    expect(runs).toBe(1);

    gate.resolve("first");
    expect(await first).toEqual({ ok: true, value: "first" });
  });

  it("keeps different keys independent", async () => {
    const gate = deferred<string>();
    const first = withActionLock("publish:1", async () => gate.promise);

    expect(await withActionLock("publish:2", async () => "other")).toEqual({ ok: true, value: "other" });

    gate.resolve("first");
    await first;
  });

  it("releases the key after the action resolves, so a later tap is allowed", async () => {
    expect(await withActionLock("cancel:1", async () => 1)).toEqual({ ok: true, value: 1 });
    expect(await withActionLock("cancel:1", async () => 2)).toEqual({ ok: true, value: 2 });
  });

  it("releases the key when the action throws, so a retry is not locked out forever", async () => {
    await expect(
      withActionLock("deploy", async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");

    expect(await withActionLock("deploy", async () => "retried")).toEqual({ ok: true, value: "retried" });
  });
});

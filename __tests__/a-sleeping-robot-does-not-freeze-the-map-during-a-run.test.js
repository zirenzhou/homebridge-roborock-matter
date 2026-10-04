"use strict";

/**
 * Measured on a P20 Ultra Plus: the map camera's tile refreshes while the
 * robot slept in its dock were never answered, the unanswered-request
 * register counted them, and by the time the robot left the dock the map
 * request was already shelved for six hours — the picture froze at the door.
 *
 * Silence from a docked robot is not evidence about a robot mid-run, so it is
 * not counted against it; and a request that did trip the breaker is tried
 * again within two minutes while the robot is out cleaning.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  UnansweredMethodBreaker,
} = require("../roborockLib/lib/unansweredMethodBreaker");

const silence = () =>
  Object.assign(new Error("timed out after 10 seconds"), {
    unansweredRequest: true,
    transportWasUp: true,
  });

describe("the breaker", () => {
  test("forgive takes back the silences counted since a given count and reopens a tripped method", () => {
    let now = 1000;
    const breaker = new UnansweredMethodBreaker({ now: () => now });
    breaker.govern("d", "m");
    for (let i = 0; i < 6; i++) breaker.recordFailure("d", "m", silence());
    expect(breaker.shouldSkip("d", "m")).toBe(true);

    breaker.forgive("d", "m", 2);
    expect(breaker.failureCount("d", "m")).toBe(2);
    expect(breaker.shouldSkip("d", "m")).toBe(false);
  });

  test("a caller mid-run retries after maxWaitMs, not after the cooldown", () => {
    let now = 1000;
    const breaker = new UnansweredMethodBreaker({ now: () => now });
    breaker.govern("d", "m");
    for (let i = 0; i < 6; i++) breaker.recordFailure("d", "m", silence());

    now += 60_000;
    expect(breaker.shouldSkip("d", "m", { maxWaitMs: 120_000 })).toBe(true);
    now += 61_000;
    expect(breaker.shouldSkip("d", "m", { maxWaitMs: 120_000 })).toBe(false);
    // Still silent: one more failure shelves it again straight away.
    breaker.recordFailure("d", "m", silence());
    expect(breaker.shouldSkip("d", "m")).toBe(true);
  });
});

describe("the map camera's fetch", () => {
  function createApi(sendRequest) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "mapfetch-")),
      enableMapCamera: true,
    });
    api.describeDevice = (duid) => `Robot ${duid}`;
    api.getVacuumDeviceInfo = () => "1.0";
    api.messageQueueHandler = { sendRequest };
    return api;
  }

  test("docked silence is not held against the robot", async () => {
    const api = createApi(async () => {
      // What the message layer does on a timeout.
      api.noteRequestUnanswered("d", "get_map_v1", silence());
      throw silence();
    });
    for (let i = 0; i < 10; i++) {
      await api.fetchMapForCamera("d", { cleaning: false });
    }
    expect(api.unansweredMethods.shouldSkip("d", "get_map_v1")).toBe(false);
    expect(api.unansweredMethods.describeOpen()).toEqual([]);
  });

  test("a map request shelved while docked is asked again within two minutes of a run", async () => {
    const api = createApi(async () => {
      throw silence();
    });
    api.unansweredMethods.govern("d", "get_map_v1");
    for (let i = 0; i < 6; i++) {
      api.unansweredMethods.recordFailure("d", "get_map_v1", silence());
    }
    const openedAt = api.unansweredMethods.entries.get("d:get_map_v1").openedAt;
    api.unansweredMethods.now = () => openedAt + 130_000;

    const send = jest.fn(async () => Buffer.from("not a map"));
    api.messageQueueHandler = { sendRequest: send };
    await api.fetchMapForCamera("d", { cleaning: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

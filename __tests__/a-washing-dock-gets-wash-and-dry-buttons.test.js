"use strict";

/**
 * A P20 Ultra Plus (a225) reports dock_type 33 — upstream's shell_4p_dock —
 * and its owner confirmed the dock empties, washes and dries. Before this,
 * 33 fell through every table, so the dock got no Empty Bin switch from its
 * code and no wash or dry command at all. These pin the three capabilities
 * for 33, the docks that must still not get them, and the exact requests the
 * two new buttons send.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function api(dockType) {
  const roborock = new Roborock({
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "dock-")),
  });
  roborock.getVacuumDeviceStatus = jest.fn((duid, key) =>
    key === "dock_type" ? dockType : ""
  );
  roborock.hasVacuumFeature = jest.fn(() => false);
  return roborock;
}

describe("which docks get which buttons", () => {
  test.each([
    [33, true, true, true],
    [8, true, true, true],
    [1, true, false, false],
    [2, false, true, false],
    [0, false, false, false],
  ])("dock %i: empty %s, wash %s, dry %s", (dockType, empty, wash, dry) => {
    const roborock = api(dockType);
    expect(roborock.supportsDustCollection("d")).toBe(empty);
    expect(roborock.supportsMopWash("d")).toBe(wash);
    expect(roborock.supportsMopDrying("d")).toBe(dry);
  });

  test("the robot's own feature flags count as well as the dock code", () => {
    const roborock = api(0);
    roborock.hasVacuumFeature = jest.fn(
      (duid, feature) => feature === "isSupportedDrying"
    );
    expect(roborock.supportsMopDrying("d")).toBe(true);
    expect(roborock.supportsMopWash("d")).toBe(false);
  });
});

describe("what the buttons send", () => {
  function withCommandSpy() {
    const roborock = api(33);
    const command = jest.fn(async () => "ok");
    roborock.vacuums.d = { command };
    roborock.isInited = () => true;
    roborock.bInited = true;
    roborock.initializedVacuumDuids.add("d");
    return { roborock, command };
  }

  test("Wash Mop starts the dock's wash", async () => {
    const { roborock, command } = withCommandSpy();
    await roborock.app_start_wash("d", { waitForResult: true });
    expect(command).toHaveBeenCalledWith(
      "d",
      "app_start_wash",
      null,
      expect.anything()
    );
  });

  test("Dry Mop switches the dryer on, and it can be switched off", async () => {
    const { roborock, command } = withCommandSpy();
    await roborock.app_start_drying("d", { waitForResult: true });
    await roborock.app_stop_drying("d", { waitForResult: true });
    expect(command.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["app_set_dryer_status", '{"status":1}'],
      ["app_set_dryer_status", '{"status":0}'],
    ]);
  });
});

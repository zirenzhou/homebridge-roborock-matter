"use strict";

/**
 * Optional buttons on the vacuum's own Matter node. Apple Home groups a
 * node's endpoints together, so Empty Bin, Wash Mop and Dry Mop can sit with
 * the robot instead of as accessories of their own. They are on/off
 * endpoints with the HAP switches' momentary contract: a press runs the same
 * command path and the button turns itself off again.
 */

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

function harness(buttons, { dockType = 33 } = {}) {
  const updates = [];
  const api = {
    getVacuumDeviceInfo: (_duid, property) =>
      property === "name" ? "Vicky" : "",
    getProductAttribute: () => "roborock.vacuum.a225",
    getVacuumDeviceStatus: (_duid, property) =>
      ({ state: 8, dock_type: dockType })[property] ?? "",
    getRoomMappingsForDevice: () => [],
    getMapListForDevice: () => [],
    getCurrentMapIdForDevice: () => null,
    getMatterCleanModeCapabilities: () => ({ canVacuum: true }),
    app_start: jest.fn().mockResolvedValue(undefined),
    app_stop: jest.fn().mockResolvedValue(undefined),
    app_pause: jest.fn().mockResolvedValue(undefined),
    app_charge: jest.fn().mockResolvedValue(undefined),
    app_start_collect_dust: jest.fn().mockResolvedValue(undefined),
    app_start_wash: jest.fn().mockResolvedValue(undefined),
    app_start_drying: jest.fn().mockResolvedValue(undefined),
    supportsDustCollection: () => dockType === 33,
    supportsMopWash: () => dockType === 33,
    supportsMopDrying: () => dockType === 33,
    getStatus: jest.fn().mockResolvedValue(undefined),
  };
  const platform = {
    platformConfig: {
      enableMatterServiceArea: false,
      enableMatterCleanMode: false,
      matterDockButtons: buttons,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      deviceTypes: { OnOffOutlet: "outlet-type" },
      updateAccessoryState: async (uuid, cluster, attributes, partId) => {
        updates.push({ cluster, attributes, partId });
      },
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: api,
  };
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return { vacuum, accessory, api, platform, updates };
}

afterEach(() => jest.useRealTimers());

test("no buttons unless asked for", () => {
  expect(harness(undefined).accessory.parts).toBeUndefined();
  expect(harness([]).accessory.parts).toBeUndefined();
});

test("each chosen command becomes an on/off endpoint on the vacuum", () => {
  const { accessory } = harness(["dry", "empty", "wash", "bogus"]);
  expect(accessory.parts.map((part) => [part.id, part.displayName])).toEqual([
    ["button-empty", "Empty Bin"],
    ["button-wash", "Wash Mop"],
    ["button-dry", "Dry Mop"],
  ]);
  for (const part of accessory.parts) {
    expect(part.deviceType).toBe("outlet-type");
    expect(part.clusters).toEqual({ onOff: { onOff: false } });
  }
});

test("a press runs the command and the button turns itself off", async () => {
  jest.useFakeTimers();
  const { accessory, api, updates } = harness(["wash"]);
  await accessory.parts[0].handlers.onOff.on();
  await jest.advanceTimersByTimeAsync(0);
  expect(api.app_start_wash).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1600);
  expect(updates).toContainEqual({
    cluster: "onOff",
    attributes: { onOff: false },
    partId: "button-wash",
  });
});

test("a button the dock cannot do says so and sends nothing", async () => {
  jest.useFakeTimers();
  const { accessory, api, platform } = harness(["dry"], { dockType: 1 });
  await accessory.parts[0].handlers.onOff.on();
  expect(api.app_start_drying).not.toHaveBeenCalled();
  expect(platform.log.warn).toHaveBeenCalledWith(
    expect.stringContaining("does not support it")
  );
});

describe("dust pending", () => {
  /**
   * The owner's plan: no auto-empty while the balcony door is open, so the
   * dock's own auto-empty is off and an automation empties the bin once the
   * door is shut. The sensor says whether there is anything to empty.
   */
  function withStatus() {
    const status = { state: 8, charge_status: 1, dock_type: 33 };
    const h = harness([]);
    h.api.getVacuumDeviceStatus = (_duid, property) => status[property] ?? "";
    return { ...h, status };
  }

  test("is set when a run ends and cleared when the dock empties the bin", () => {
    const { vacuum, status } = withStatus();
    const pending = () => vacuum.getHomeKitStateSensorValue("dustPending");

    vacuum.lastPublishedRunMode = 1; // on a run
    status.state = 5;
    vacuum.notifyStateListener();
    expect(pending()).toBe(false);

    vacuum.lastPublishedRunMode = 0; // back on the dock
    status.state = 8;
    vacuum.notifyStateListener();
    expect(pending()).toBe(true);

    status.state = 22; // the dock empties the bin
    vacuum.notifyStateListener();
    expect(pending()).toBe(false);
  });

  test("pressing Empty Bin clears it straight away", async () => {
    const { vacuum } = withStatus();
    vacuum.accessory.context.dustPending = true;
    await vacuum.runHomeKitAction("empty");
    expect(vacuum.getHomeKitStateSensorValue("dustPending")).toBe(false);
  });
});

describe("names Apple Home is given", () => {
  const { applyServiceName } = require("../src/naming");

  function fakeService() {
    const values = new Map();
    const optional = new Set();
    return {
      UUID: "contact",
      values,
      setCharacteristic(characteristic, value) {
        values.set(characteristic, value);
        return this;
      },
      testCharacteristic: (characteristic) => optional.has(characteristic),
      addOptionalCharacteristic: (characteristic) =>
        optional.add(characteristic),
    };
  }
  const Characteristic = { Name: "Name", ConfiguredName: "ConfiguredName" };

  test("say what the accessory shows, once, and leave a name picked in the Home app alone", () => {
    const accessory = {
      displayName: "P20 Ultra Plus Dust Pending",
      context: {},
    };
    const service = fakeService();

    applyServiceName(accessory, service, Characteristic, "Dust Pending");
    expect(accessory.displayName).toBe("Dust Pending");
    expect(service.values.get("ConfiguredName")).toBe("Dust Pending");

    // The owner renames it in the Home app; the next start must not undo that.
    service.values.set("ConfiguredName", "待集尘");
    applyServiceName(accessory, service, Characteristic, "Dust Pending");
    expect(service.values.get("ConfiguredName")).toBe("待集尘");
  });
});

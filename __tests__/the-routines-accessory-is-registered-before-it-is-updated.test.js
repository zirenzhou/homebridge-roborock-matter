"use strict";

/**
 * Turning on Routine switches on Homebridge 2.4.0 logged, in this order:
 *
 *   Failed to save cached accessories to disk: Cannot serialize accessory
 *     'P20 Ultra Plus Routines' - missing associated plugin
 *   Adding HAP routine accessory 'P20 Ultra Plus Routines' with 2 switches.
 *   Accessory 'P20 Ultra Plus Routines' has the same UUID as existing
 *     accessory … Skipping duplicate.
 *
 * and the Routines tile was not bridged until the child bridge restarted.
 * The reading that created the switches updated the accessory before the
 * count that registers it reached the platform. Homebridge 1 only re-saved on
 * an update; Homebridge 2's handler appends the accessory to its cache list,
 * where a never-registered accessory has no plugin name to serialise and
 * then shadows the real register as a duplicate. The fake API below keeps
 * Homebridge 2's book: an update of an accessory it has never registered is
 * the failure, whatever happens after it.
 */

const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

const Characteristic = {
  Name: "Name",
  ConfiguredName: "ConfiguredName",
  On: "On",
  Manufacturer: "Manufacturer",
  Model: "Model",
  SerialNumber: "SerialNumber",
};

const Service = {
  Switch: { UUID: "switch-uuid" },
  AccessoryInformation: { UUID: "info-uuid" },
};

class FakeCharacteristic {
  setValue(value) {
    this.value = value;
    return this;
  }
  onSet(handler) {
    this.setHandler = handler;
    return this;
  }
  onGet(handler) {
    this.getHandler = handler;
    return this;
  }
  removeAllListeners() {}
}

class FakeService {
  constructor(serviceType, displayName, subtype) {
    this.UUID = serviceType.UUID;
    this.subtype = subtype;
    this.displayName = displayName;
    this.characteristics = new Map();
  }
  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
    }
    return this.characteristics.get(type);
  }
  setCharacteristic(type, value) {
    this.getCharacteristic(type).setValue(value);
    return this;
  }
  addOptionalCharacteristic(type) {
    this.getCharacteristic(type);
    return this;
  }
  updateCharacteristic(type, value) {
    this.getCharacteristic(type).setValue(value);
    return this;
  }
}

class FakeAccessory {
  constructor(displayName) {
    this.displayName = displayName;
    this.context = {};
    this.services = [];
    this.UUID = `uuid:${displayName}`;
  }
  getService(serviceType) {
    return this.services.find((s) => s.UUID === serviceType.UUID);
  }
  getServiceById(serviceType, subtype) {
    return this.services.find(
      (s) => s.UUID === serviceType.UUID && s.subtype === subtype
    );
  }
  addService(serviceType, displayName, subtype) {
    const service = new FakeService(serviceType, displayName, subtype);
    this.services.push(service);
    return service;
  }
  removeService(service) {
    this.services = this.services.filter((s) => s !== service);
  }
}

/** Homebridge 2's accessory book, reduced to what this bug is about. */
function makeHomebridge() {
  const registered = new Set();
  const unownedUpdates = [];
  return {
    registered,
    unownedUpdates,
    register(accessory) {
      registered.add(accessory);
    },
    unregister(accessory) {
      registered.delete(accessory);
    },
    updatePlatformAccessories: jest.fn((accessories) => {
      for (const accessory of accessories) {
        if (!registered.has(accessory)) {
          unownedUpdates.push(accessory.displayName);
        }
      }
    }),
  };
}

const DUID = "duid-routines";

function scene(id, name) {
  return {
    id,
    name,
    param: JSON.stringify({
      triggers: [],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: "",
            entityId: DUID,
            param:
              '{"id":1,"method":"do_scenes_app_start","params":[{"source":101}]}',
            finishDpIds: [130],
          },
        ],
      },
    }),
    enabled: true,
    extra: null,
    type: "WORKFLOW",
  };
}

function makeCoordinator(scenes) {
  const homebridge = makeHomebridge();
  const cloud = {
    getServerTimers: jest.fn(async () => {
      throw new Error("Not FCC robot (code -10007)");
    }),
    getCloudScenes: jest.fn(async () => scenes.map((s) => ({ ...s }))),
    executeCloudScene: jest.fn(async () => {}),
    vacuums: { [DUID]: { command: jest.fn(async () => "ok") } },
  };
  const platform = {
    Service,
    Characteristic,
    roborockAPI: cloud,
    api: { updatePlatformAccessories: homebridge.updatePlatformAccessories },
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  const coordinator = new RoborockHapScheduleAccessory(
    platform,
    new FakeAccessory("Rocky Schedules"),
    DUID
  );
  const routineAccessory = new FakeAccessory("Rocky Routines");
  coordinator.vacuumName = "Rocky";
  // What platform.attachRoutineAccessory does with the count.
  coordinator.attachRoutineAccessory(routineAccessory, (count) => {
    if (count > 0) homebridge.register(routineAccessory);
    else homebridge.unregister(routineAccessory);
  });
  return { coordinator, routineAccessory, homebridge, cloud };
}

describe("the Routines accessory on Homebridge 2", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("is registered before the reading that gave it switches updates it", async () => {
    const { coordinator, routineAccessory, homebridge } = makeCoordinator([
      scene(1, "Kitchen"),
      scene(2, "Everywhere"),
    ]);

    await coordinator.initialize("Rocky");

    expect(homebridge.registered.has(routineAccessory)).toBe(true);
    expect(homebridge.unownedUpdates).toEqual([]);
  });

  test("an accessory that never had a switch is not updated when Routines are switched off", async () => {
    const { coordinator, homebridge } = makeCoordinator([]);

    await coordinator.initialize("Rocky");
    coordinator.removeRoutineServices();

    expect(homebridge.updatePlatformAccessories).not.toHaveBeenCalled();
    expect(homebridge.unownedUpdates).toEqual([]);
  });

  test("an accessory that loses its last Routine is unregistered, not updated afterwards", async () => {
    const scenes = [scene(1, "Kitchen")];
    const { coordinator, routineAccessory, homebridge, cloud } =
      makeCoordinator(scenes);
    await coordinator.initialize("Rocky");
    expect(homebridge.registered.has(routineAccessory)).toBe(true);

    cloud.getCloudScenes.mockResolvedValue([]);
    coordinator.syncRoutines([]);

    expect(homebridge.registered.has(routineAccessory)).toBe(false);
    expect(homebridge.unownedUpdates).toEqual([]);
  });
});

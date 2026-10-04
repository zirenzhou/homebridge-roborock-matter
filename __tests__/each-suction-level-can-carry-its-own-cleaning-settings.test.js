"use strict";

// 清洁效率, 清洁次数 and 拖地水量 pinned to each suction level for cleans
// started from Apple Home, and the Suction / Mop Water sliders that work
// while the robot runs. Codes were measured on a P20 Ultra Plus by changing
// each setting in the Roborock app and reading the status back.

const fs = require("fs");
const os = require("os");
const path = require("path");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  resolveCleaningProfile,
  MOP_MODE_CODES,
} = require("../src/cleaning_profiles");
const {
  suctionToSpeed,
  speedToSuction,
  waterToSpeed,
  speedToWater,
} = require("../src/cleaning_controls_accessory");

describe("the measured codes", () => {
  test("efficiency codes", () => {
    expect(MOP_MODE_CODES).toEqual({ standard: 300, fine: 303, fast: 304 });
  });

  test("a level's profile resolves to the robot's codes", () => {
    const profiles = {
      max: { efficiency: "fine", repeat: 2, mopWater: 30 },
      quiet: { efficiency: "fast", repeat: "1", mopWater: "1" },
    };
    expect(resolveCleaningProfile(profiles, 104)).toEqual({
      mopMode: 303,
      repeatTimes: 2,
      waterBoxMode: 250,
    });
    expect(resolveCleaningProfile(profiles, 101)).toEqual({
      mopMode: 304,
      repeatTimes: 1,
      waterBoxMode: 221,
    });
  });

  test("unset parts follow the app, and Max+ never gets mop water", () => {
    expect(resolveCleaningProfile({}, 104)).toEqual({});
    expect(resolveCleaningProfile(undefined, 104)).toEqual({});
    expect(
      resolveCleaningProfile({ strong: { efficiency: "follow" } }, 103)
    ).toEqual({});
    expect(
      resolveCleaningProfile({ maxPlus: { repeat: 2, mopWater: 20 } }, 108)
    ).toEqual({ repeatTimes: 2 });
    expect(resolveCleaningProfile({ max: { repeat: 7 } }, 104)).toEqual({});
  });
});

describe("the sliders", () => {
  test("suction runs in five steps of 20", () => {
    expect([101, 102, 103, 104, 108].map(suctionToSpeed)).toEqual([
      20, 40, 60, 80, 100,
    ]);
    expect(suctionToSpeed(105)).toBeNull();
    expect([0, 20, 21, 40, 60, 80, 100].map(speedToSuction)).toEqual([
      101, 101, 102, 102, 103, 104, 108,
    ]);
  });

  test("mop water is 0 (off) to 30 on a 0 to 100 slider", () => {
    expect(waterToSpeed(0)).toBe(0);
    expect(waterToSpeed(30)).toBe(100);
    expect(speedToWater(100)).toBe(30);
    expect(speedToWater(50)).toBe(15);
    expect(speedToWater(0)).toBe(0);
    for (let level = 0; level <= 30; level++) {
      expect(speedToWater(waterToSpeed(level))).toBe(level);
    }
  });
});

function createAccessory({ profiles, status = {} } = {}) {
  const applied = [];
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableFanPowerCleanModes: true,
      enableExtendedCleanModes: true,
      vacuumAndMopOrder: "vacuumFirst",
      cleanModeNames: "roborock",
      cleaningProfiles: profiles,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => null,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "P20 Ultra Plus" : "",
      getProductAttribute: () => "roborock.vacuum.a225",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => 0,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: true,
        canControlWater: true,
        canVacuumThenMop: true,
      }),
      applyMatterCleanModeSettings: jest.fn(async (duid, settings) => {
        applied.push(settings);
        return { unconfirmedSettings: [], cleanTypeConfirmed: true };
      }),
    },
  };
  const accessory = { UUID: "uuid-p", context: { duid: "duid-a225" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-a225" },
    false
  );
  return { instance, applied };
}

describe("the clean mode settings carry the profile", () => {
  const robot = {
    fan_power: 104,
    water_box_mode: 235,
    mop_mode: 303,
    repeat: 1,
    seq_type: 1,
    distance_off: 0,
  };

  test("only what the settings page pins is sent, and only to a start", () => {
    const { instance } = createAccessory({
      profiles: { max: { efficiency: "fast", repeat: 2, mopWater: 10 } },
      status: robot,
    });
    const mode = 11; // Vacuum & Mop at Max
    const withProfile = instance.getRoborockCleanModeSettings(mode, true);
    expect(withProfile).toMatchObject({
      fanPower: 104,
      mopMode: 304,
      repeatTimes: 2,
      waterBoxMode: 230,
    });
    const without = instance.getRoborockCleanModeSettings(mode);
    expect(without.mopMode).toBeUndefined();
    expect(without.repeatTimes).toBeUndefined();
    expect(without.waterBoxMode).toBe(235);
  });

  test("a robot that does not report the setting is not sent it", () => {
    const { instance } = createAccessory({
      profiles: { max: { efficiency: "fast", repeat: 2, mopWater: 10 } },
      status: { fan_power: 104, water_box_mode: 202 },
    });
    const settings = instance.getRoborockCleanModeSettings(11, true);
    expect(settings.mopMode).toBeUndefined();
    expect(settings.repeatTimes).toBeUndefined();
    expect(settings.waterBoxMode).not.toBe(230);
  });

  test("pure vacuum keeps the water off whatever the profile says", () => {
    const { instance } = createAccessory({
      profiles: { max: { repeat: 2, mopWater: 10 } },
      status: robot,
    });
    const settings = instance.getRoborockCleanModeSettings(0, true);
    expect(settings.waterBoxMode).toBe(200);
    expect(settings.repeatTimes).toBe(2);
  });
});

describe("the sliders reach the robot while it is running", () => {
  test("Max+ turns the mop water off, as the Roborock app does", async () => {
    const { instance, applied } = createAccessory({
      status: { fan_power: 104, water_box_mode: 235, seq_type: 1 },
    });
    await instance.setSuctionFanPower(108);
    expect(applied).toEqual([
      {
        fanPower: 108,
        waterBoxMode: 200,
        sequenceType: 0,
        carryAllSettings: true,
      },
    ]);
  });

  test("a plain suction change is just the suction", async () => {
    const { instance, applied } = createAccessory({
      status: { fan_power: 104, water_box_mode: 235 },
    });
    await instance.setSuctionFanPower(103);
    expect(applied).toEqual([{ fanPower: 103 }]);
  });

  test("a water change carries the current suction and route", async () => {
    const { instance, applied } = createAccessory({
      status: { fan_power: 104, water_box_mode: 235, seq_type: 1 },
    });
    await instance.setMopWaterLevel(30);
    expect(applied).toEqual([
      {
        waterBoxMode: 250,
        carryAllSettings: true,
        sequenceType: 1,
        fanPower: 104,
      },
    ]);
    await instance.setMopWaterLevel(0);
    expect(applied[1].waterBoxMode).toBe(200);
  });

  test("mop water on Max+ lowers the suction to Max", async () => {
    const { instance, applied } = createAccessory({
      status: { fan_power: 108, water_box_mode: 200, seq_type: 0 },
    });
    await instance.setMopWaterLevel(10);
    expect(applied[0].fanPower).toBe(104);
  });

  test("what the sliders show", () => {
    const { instance } = createAccessory({
      status: { fan_power: 108, water_box_mode: 221 },
    });
    expect(instance.getCleaningControlState()).toEqual({
      fanPower: 108,
      waterLevel: 1,
    });
    const off = createAccessory({
      status: { fan_power: 102, water_box_mode: 200 },
    });
    expect(off.instance.getCleaningControlState().waterLevel).toBe(0);
    const unknown = createAccessory({ status: { water_box_mode: 202 } });
    expect(unknown.instance.getCleaningControlState().waterLevel).toBeNull();
  });
});

describe("the robot side", () => {
  function createApi({ liveSequence = 0 } = {}) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-prof-")),
    });
    const sent = [];
    api.getVacuumDeviceInfo = jest.fn().mockReturnValue("1.0");
    api.getVacuumDeviceStatus = jest.fn((duid, property) =>
      property === "seq_type"
        ? liveSequence
        : property === "mop_mode"
          ? 303
          : ""
    );
    api.getMatterCleanModeCapabilities = jest
      .fn()
      .mockReturnValue({ canControlFanPower: true, canControlWater: true });
    api.getMatterWaterModeCommandCandidates = jest
      .fn()
      .mockReturnValue(["set_water_box_custom_mode"]);
    api.describeDevice = jest.fn().mockReturnValue("P20 Ultra Plus");
    api.runFirstMatterSettingCommand = jest.fn(
      async (duid, commands, value) => {
        sent.push({ command: commands[0], value });
      }
    );
    api.runMatterSettingCommand = jest.fn(async (duid, command, value) => {
      sent.push({ command, value });
    });
    return { api, sent };
  }

  test("the sequence command carries the pinned efficiency", async () => {
    const { api, sent } = createApi();
    await api.applyMatterCleanModeSettings("d", {
      fanPower: 104,
      waterBoxMode: 235,
      sequenceType: 1,
      mopMode: 304,
      repeatTimes: 2,
    });
    expect(sent).toEqual([
      {
        command: "app_set_clean_sequence_type",
        value: { type: 1, fan_power: 104, water_box_mode: 235, mop_mode: 304 },
      },
      { command: "set_clean_repeat_times", value: 2 },
    ]);
  });

  test("without a sequence the efficiency and passes go in their own commands", async () => {
    const { api, sent } = createApi();
    await api.applyMatterCleanModeSettings("d", {
      fanPower: 104,
      waterBoxMode: 200,
      sequenceType: 0,
      mopMode: 300,
      repeatTimes: 1,
    });
    expect(sent.map((entry) => entry.command)).toEqual([
      "set_water_box_custom_mode",
      "set_custom_mode",
      "set_mop_mode",
      "set_clean_repeat_times",
    ]);
  });

  test("a slider change is one sequence command even on a together run", async () => {
    const { api, sent } = createApi({ liveSequence: 0 });
    await api.applyMatterCleanModeSettings("d", {
      fanPower: 104,
      waterBoxMode: 250,
      sequenceType: 0,
      carryAllSettings: true,
    });
    expect(sent).toEqual([
      {
        command: "app_set_clean_sequence_type",
        value: { type: 0, fan_power: 104, water_box_mode: 250, mop_mode: 303 },
      },
    ]);
  });
});

describe("the Cleaning accessory in HAP", () => {
  const hap = require("homebridge/node_modules/hap-nodejs");
  const RoborockCleaningControlsAccessory =
    require("../src/cleaning_controls_accessory").default;

  function build(state) {
    const accessory = new hap.Accessory("Cleaning", hap.uuid.generate("t"));
    accessory.context = { duid: "d", kind: "cleaningControls" };
    const calls = [];
    const robot = {
      getCleaningControlState: () => state,
      setSuctionFanPower: jest.fn(async (value) => calls.push(["fan", value])),
      setMopWaterLevel: jest.fn(async (value) => calls.push(["water", value])),
    };
    const platform = {
      Service: hap.Service,
      Characteristic: hap.Characteristic,
      getVacuumModel: () => "a225",
      getVacuumSerialNumber: () => "SN",
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    };
    const controls = new RoborockCleaningControlsAccessory(
      platform,
      accessory,
      "d",
      () => robot
    );
    return { accessory, controls, calls, robot };
  }

  test("two named fans whose sliders follow the robot", () => {
    const { accessory, controls } = build({ fanPower: 104, waterLevel: 15 });
    controls.refresh();
    const suction = accessory.getServiceById(hap.Service.Fanv2, "suction");
    const water = accessory.getServiceById(hap.Service.Fanv2, "water");
    expect(suction.getCharacteristic(hap.Characteristic.Name).value).toBe(
      "Suction"
    );
    expect(water.getCharacteristic(hap.Characteristic.Name).value).toBe(
      "Mop Water"
    );
    expect(
      suction.getCharacteristic(hap.Characteristic.RotationSpeed).value
    ).toBe(80);
    expect(
      water.getCharacteristic(hap.Characteristic.RotationSpeed).value
    ).toBe(50);
    expect(water.getCharacteristic(hap.Characteristic.Active).value).toBe(1);
  });

  test("a slider change reaches the robot once, after it settles", async () => {
    jest.useFakeTimers();
    try {
      const { accessory, calls } = build({ fanPower: 102, waterLevel: 0 });
      const suction = accessory.getServiceById(hap.Service.Fanv2, "suction");
      const speed = suction.getCharacteristic(hap.Characteristic.RotationSpeed);
      await speed.handleSetRequest(60);
      await speed.handleSetRequest(100);
      await jest.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([["fan", 108]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("switching the water off sends level 0", async () => {
    jest.useFakeTimers();
    try {
      const { accessory, calls, controls } = build({
        fanPower: 104,
        waterLevel: 12,
      });
      controls.refresh();
      const water = accessory.getServiceById(hap.Service.Fanv2, "water");
      await water
        .getCharacteristic(hap.Characteristic.Active)
        .handleSetRequest(0);
      await jest.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual([["water", 0]]);
    } finally {
      jest.useRealTimers();
    }
  });
});

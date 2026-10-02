"use strict";

// The P20 Ultra Plus owner's mornings: the balcony vacuumed first and mopped
// after (先扫后拖), at high suction; the rest of the flat vacuumed and mopped
// together; the suction changed from the Home app whenever. Apple Home groups
// clean modes by their primary tag and offers intensities inside a group, so
// suction levels that exist only under Vacuum cannot be had while mopping.
// enableExtendedCleanModes adds the levels under Vacuum + Mop and, where the
// robot's feature bits say so, a VacuumThenMop group with the same levels.

const fs = require("fs");
const os = require("os");
const path = require("path");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  hasNewFeatureStrBit,
  supportsMaxPlusFanPower,
} = require("../roborockLib/lib/deviceFeatures");

const VACUUM = 16385;
const MOP = 16386;
const VACUUM_THEN_MOP = 16387;
const CLEANING_STATE = 5;

function createAccessory({
  enableExtendedCleanModes = true,
  canVacuumThenMop = true,
  vacuumAndMopOrder,
  cleanModeNames,
  status = {},
} = {}) {
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableFanPowerCleanModes: true,
      enableExtendedCleanModes,
      vacuumAndMopOrder,
      cleanModeNames,
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
        canVacuumThenMop,
      }),
    },
  };
  const accessory = { UUID: "uuid-vtm", context: { duid: "duid-a225" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-a225" },
    false
  );
  return { instance, status };
}

const modeIds = (instance) =>
  instance.buildCleanModeCluster().supportedModes.map((mode) => mode.mode);

describe("announced modes", () => {
  test("off by default: the list a robot was paired with does not change", () => {
    const { instance } = createAccessory({ enableExtendedCleanModes: false });
    expect(modeIds(instance)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("on: the levels under Vacuum + Mop, and Vacuum then Mop with the same levels", () => {
    const { instance } = createAccessory();
    const modes = instance.buildCleanModeCluster().supportedModes;
    expect(modes.map((mode) => mode.mode)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const tags = new Map(
      modes.map((mode) => [mode.mode, mode.modeTags.map((tag) => tag.value)])
    );
    // Same intensity tags as the vacuum levels: Quiet, Auto, Quick, Max.
    expect(tags.get(8)).toEqual([VACUUM, MOP, 2]);
    expect(tags.get(9)).toEqual([VACUUM, MOP, 0]);
    expect(tags.get(10)).toEqual([VACUUM, MOP, 1]);
    expect(tags.get(11)).toEqual([VACUUM, MOP, 7]);
    // Vacuum then Mop refines vacuum and mop: Apple Home best-fits on
    // (vacuum, mop, vacuumThenMop), and with VacuumThenMop alone the group
    // was announced but never shown.
    expect(tags.get(12)).toEqual([VACUUM, MOP, VACUUM_THEN_MOP]);
    expect(tags.get(16)).toEqual([VACUUM, MOP, VACUUM_THEN_MOP, 7]);
    const labels = modes.map((mode) => mode.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(modes.every((mode) => mode.modeTags.length <= 8)).toBe(true);
  });

  test("a robot without the feature bit gets the mopping levels only", () => {
    const { instance } = createAccessory({ canVacuumThenMop: false });
    expect(modeIds(instance)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("what a selection sends", () => {
  test("a mopping level keeps the water on, pins the suction, and runs both at once", () => {
    const { instance } = createAccessory({ status: { water_box_mode: 235 } });
    expect(instance.getRoborockCleanModeSettings(10)).toEqual({
      cleanMode: 2,
      fanPower: 103,
      waterBoxMode: 235,
      sequenceType: 0,
    });
  });

  test("a vacuum-then-mop level asks for the sequence", () => {
    const { instance } = createAccessory({ status: { water_box_mode: 235 } });
    expect(instance.getRoborockCleanModeSettings(16)).toEqual({
      cleanMode: 2,
      fanPower: 104,
      waterBoxMode: 235,
      sequenceType: 1,
    });
    // Plain Vacuum then Mop keeps the suction the robot already has.
    const { instance: plain } = createAccessory({
      status: { water_box_mode: 235, fan_power: 102 },
    });
    expect(plain.getRoborockCleanModeSettings(12).fanPower).toBe(102);
    expect(plain.getRoborockCleanModeSettings(12).sequenceType).toBe(1);
  });

  test("plain Vacuum + Mop switches the sequence back; runs that do not mop and vacuum leave it alone", () => {
    const { instance } = createAccessory({ status: { water_box_mode: 235 } });
    expect(instance.getRoborockCleanModeSettings(2).sequenceType).toBe(0);
    expect(
      instance.getRoborockCleanModeSettings(0).sequenceType
    ).toBeUndefined();
    expect(
      instance.getRoborockCleanModeSettings(6).sequenceType
    ).toBeUndefined();
    expect(
      instance.getRoborockCleanModeSettings(1).sequenceType
    ).toBeUndefined();
  });

  test("without vacuum-then-mop on offer the sequence is never touched", () => {
    const { instance } = createAccessory({
      canVacuumThenMop: false,
      status: { water_box_mode: 235 },
    });
    expect(
      instance.getRoborockCleanModeSettings(2).sequenceType
    ).toBeUndefined();
    expect(
      instance.getRoborockCleanModeSettings(9).sequenceType
    ).toBeUndefined();
  });
});

describe("the mode Apple Home shows during a run", () => {
  function running(status) {
    const { instance } = createAccessory({ status });
    instance.rememberLiveStatus("state", CLEANING_STATE);
    instance.rememberLiveStatus("water_box_mode", 235);
    return instance;
  }

  test("follows the suction and sequence the robot reports", () => {
    const together = running({ seq_type: 0 });
    together.rememberLiveStatus("fan_power", 103);
    expect(together.buildCleanModeCluster().currentMode).toBe(10);

    const sequenced = running({ seq_type: 1 });
    sequenced.rememberLiveStatus("fan_power", 104);
    expect(sequenced.buildCleanModeCluster().currentMode).toBe(16);
  });

  test("a level with no mode of its own falls back to the plain mode of its group", () => {
    const sequenced = running({ seq_type: 1 });
    sequenced.rememberLiveStatus("fan_power", 106); // custom
    expect(sequenced.buildCleanModeCluster().currentMode).toBe(12);

    const together = running({ seq_type: 0 });
    together.rememberLiveStatus("fan_power", 106);
    expect(together.buildCleanModeCluster().currentMode).toBe(2);
  });

  test("an idle selection of a mopping level is not mistaken for a vacuum level", () => {
    const { instance } = createAccessory();
    instance.selectedCleanMode = 9;
    instance.rememberLiveStatus("fan_power", 104);
    expect(instance.buildCleanModeCluster().currentMode).toBe(9);
  });
});

describe("the robot side", () => {
  function createApi({ liveSequence = "", failSequence = false } = {}) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-vtm-")),
    });
    const sent = [];
    api.getVacuumDeviceInfo = jest.fn().mockReturnValue("1.0");
    api.getVacuumDeviceStatus = jest.fn((duid, property) =>
      property === "seq_type"
        ? liveSequence
        : property === "mop_mode"
          ? 300
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
      if (failSequence && command === "app_set_clean_sequence_type") {
        throw new Error("timed out");
      }
    });
    return { api, sent };
  }

  test("vacuum then mop is one command carrying the suction, water and route", async () => {
    const { api, sent } = createApi();
    const result = await api.applyMatterCleanModeSettings("d", {
      cleanMode: 2,
      fanPower: 104,
      waterBoxMode: 235,
      sequenceType: 1,
    });
    expect(sent).toEqual([
      {
        command: "app_set_clean_sequence_type",
        value: { type: 1, fan_power: 104, water_box_mode: 235, mop_mode: 300 },
      },
    ]);
    expect(result.cleanTypeConfirmed).toBe(true);
  });

  test("switching back is sent only when the robot is on vacuum-then-mop", async () => {
    const off = createApi({ liveSequence: 0 });
    await off.api.applyMatterCleanModeSettings("d", {
      cleanMode: 2,
      fanPower: 103,
      waterBoxMode: 235,
      sequenceType: 0,
    });
    expect(off.sent.map((entry) => entry.command)).toEqual([
      "set_water_box_custom_mode",
      "set_custom_mode",
    ]);

    const on = createApi({ liveSequence: 1 });
    await on.api.applyMatterCleanModeSettings("d", {
      cleanMode: 2,
      fanPower: 103,
      waterBoxMode: 235,
      sequenceType: 0,
    });
    expect(on.sent).toEqual([
      {
        command: "app_set_clean_sequence_type",
        value: { type: 0, fan_power: 103, water_box_mode: 235, mop_mode: 300 },
      },
    ]);
  });

  test("a refused sequence still sends the water and suction, and says the type is unconfirmed", async () => {
    const { api, sent } = createApi({ failSequence: true });
    const result = await api.applyMatterCleanModeSettings("d", {
      cleanMode: 2,
      fanPower: 104,
      waterBoxMode: 235,
      sequenceType: 1,
    });
    expect(sent.map((entry) => entry.command)).toEqual([
      "app_set_clean_sequence_type",
      "set_water_box_custom_mode",
      "set_custom_mode",
    ]);
    expect(result.cleanTypeConfirmed).toBe(false);
  });
});

describe("capability", () => {
  test("bit 93 of the new-feature string, counted from its right-hand end", () => {
    // Bit 93 is hex digit 23 from the end (93 / 4), position 1 (93 % 4).
    const withBit = "2" + "0".repeat(23);
    expect(hasNewFeatureStrBit(withBit, 93)).toBe(true);
    expect(hasNewFeatureStrBit("4" + "0".repeat(23), 93)).toBe(false);
    expect(hasNewFeatureStrBit("0".repeat(10), 93)).toBe(false);
    expect(hasNewFeatureStrBit(undefined, 93)).toBe(false);
  });

  test("the P20 Ultra Plus has the fifth suction level", () => {
    expect(supportsMaxPlusFanPower("roborock.vacuum.a225")).toBe(true);
  });
});

describe("the settings probe", () => {
  test("never asks for the dock's serial number, and keeps only flags and totals", async () => {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-probe-")),
    });
    const asked = [];
    api.messageQueueHandler = {
      sendRequest: jest.fn(async (duid, method) => {
        asked.push(method);
        if (method === "app_get_init_status") {
          return [
            {
              local_info: { timezone: "Somewhere/City", location: "xx" },
              feature_info: [111],
              new_feature_info_str: "2" + "0".repeat(23),
            },
          ];
        }
        if (method === "get_clean_summary") {
          return { clean_count: 3, records: [1, 2, 3] };
        }
        return "ok";
      }),
    };
    api.describeDevice = () => "robot";
    api.getProductAttribute = () => "roborock.vacuum.a225";
    const answers = await api.probeDockSettings("d");

    expect(asked).not.toContain("get_dock_info");
    expect(asked).not.toContain("get_network_info");
    expect(asked).not.toContain("get_serial_number");
    expect(asked.every((method) => /^(get|app_get)_/.test(method))).toBe(true);
    expect(JSON.stringify(answers)).not.toContain("Somewhere/City");
    expect(answers.app_get_init_status.feature_info).toEqual([111]);
    expect(answers.get_clean_summary).toEqual({ clean_count: 3, records: 3 });
  });
});

describe("Vacuum + Mop that always vacuums first", () => {
  // Apple Home puts Vacuum then Mop in the Vacuum + Mop menu as one more entry,
  // exclusive with the suction levels. An owner who never mops and vacuums at
  // once gets the whole menu, levels included, as vacuum-then-mop.
  const vacuumFirst = (options = {}) =>
    createAccessory({ vacuumAndMopOrder: "vacuumFirst", ...options });

  test("announces no separate vacuum-then-mop modes, and names the rest for what they do", () => {
    const { instance } = vacuumFirst();
    const modes = instance.buildCleanModeCluster().supportedModes;
    expect(modes.map((mode) => mode.mode)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const byMode = new Map(modes.map((mode) => [mode.mode, mode]));
    expect(byMode.get(2).label).toBe("Vacuum then Mop");
    expect(byMode.get(11).label).toBe("Max Vacuum then Mop");
    expect(byMode.get(11).modeTags.map((tag) => tag.value)).toEqual([
      VACUUM,
      MOP,
      7,
    ]);
    const labels = modes.map((mode) => mode.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("every Vacuum + Mop level asks for the sequence; vacuum and mop alone do not", () => {
    const { instance } = vacuumFirst({ status: { water_box_mode: 235 } });
    expect(instance.getRoborockCleanModeSettings(10)).toEqual({
      cleanMode: 2,
      fanPower: 103,
      waterBoxMode: 235,
      sequenceType: 1,
    });
    expect(instance.getRoborockCleanModeSettings(2).sequenceType).toBe(1);
    expect(
      instance.getRoborockCleanModeSettings(0).sequenceType
    ).toBeUndefined();
    expect(
      instance.getRoborockCleanModeSettings(1).sequenceType
    ).toBeUndefined();
  });

  test("a vacuum-then-mop run shows the level it runs at", () => {
    const { instance } = vacuumFirst({ status: { seq_type: 1 } });
    instance.rememberLiveStatus("state", CLEANING_STATE);
    instance.rememberLiveStatus("water_box_mode", 235);
    instance.rememberLiveStatus("fan_power", 104);
    expect(instance.buildCleanModeCluster().currentMode).toBe(11);
  });

  test("a robot that cannot vacuum first keeps the ordinary behaviour", () => {
    const { instance } = vacuumFirst({
      canVacuumThenMop: false,
      status: { water_box_mode: 235 },
    });
    expect(instance.buildCleanModeCluster().supportedModes[2].label).toBe(
      "Vacuum + Mop"
    );
    expect(
      instance.getRoborockCleanModeSettings(9).sequenceType
    ).toBeUndefined();
  });

  test("works without the extended modes too: plain Vacuum + Mop vacuums first", () => {
    const { instance } = vacuumFirst({
      enableExtendedCleanModes: false,
      status: { water_box_mode: 235 },
    });
    expect(instance.getRoborockCleanModeSettings(2).sequenceType).toBe(1);
  });
});

describe("suction levels named as in the Roborock app", () => {
  // Apple Home names a level after its tag, and no standard tag means
  // "standard" or "turbo". A tag carrying a MfgCode is the manufacturer's own,
  // where a controller falls back to the label; the value stays a standard one
  // because matter.js refuses anything outside the ModeTag enum.
  const MFG = 0xfff1;
  const roborockNames = () =>
    createAccessory({
      cleanModeNames: "roborock",
      vacuumAndMopOrder: "vacuumFirst",
    });

  test("the five vacuum levels carry the app's names and manufacturer-coded tags", () => {
    const { instance } = roborockNames();
    const modes = new Map(
      instance
        .buildCleanModeCluster()
        .supportedModes.map((mode) => [mode.mode, mode])
    );
    expect([3, 4, 5, 6, 7].map((id) => modes.get(id).label)).toEqual([
      "安静",
      "标准",
      "强力",
      "Max",
      "Max+",
    ]);
    expect(modes.get(4).modeTags).toEqual([
      { value: VACUUM },
      { mfgCode: MFG, value: 0 },
    ]);
    expect(modes.get(7).modeTags).toEqual([
      { value: VACUUM },
      { mfgCode: MFG, value: 16384 },
    ]);
  });

  test("the Vacuum + Mop levels look the same and stay unique", () => {
    const { instance } = roborockNames();
    const modes = instance.buildCleanModeCluster().supportedModes;
    const byMode = new Map(modes.map((mode) => [mode.mode, mode]));
    expect(byMode.get(10).label.replace(/\u200b/g, "")).toBe("强力");
    expect(byMode.get(10).label).not.toBe(byMode.get(5).label);
    expect(byMode.get(10).modeTags).toEqual([
      { value: VACUUM },
      { value: MOP },
      { mfgCode: MFG, value: 1 },
    ]);
    const labels = modes.map((mode) => mode.label);
    expect(new Set(labels).size).toBe(labels.length);
    // Primary tags stay standard, so Apple Home still finds its three menus.
    expect(byMode.get(0).modeTags).toEqual([{ value: VACUUM }]);
    expect(byMode.get(2).modeTags).toEqual([{ value: VACUUM }, { value: MOP }]);
  });

  test("off by default: standard tags, English labels", () => {
    const { instance } = createAccessory();
    const mode = instance
      .buildCleanModeCluster()
      .supportedModes.find((entry) => entry.mode === 4);
    expect(mode.label).toBe("Balanced Vacuum");
    expect(mode.modeTags).toEqual([{ value: VACUUM }, { value: 0 }]);
  });
});

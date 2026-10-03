"use strict";

// Switching a choice in the Roborock app (清洁效率, 吸力, 水量, 先扫后拖,
// 清洁次数) and reading the log is how the code behind each choice is learnt,
// so every change to those fields lands in the log at info.

const VacuumClass = require("../roborockLib/lib/vacuum");

function createVacuum() {
  const lines = [];
  const adapter = {
    log: { info: (line) => lines.push(line), debug() {}, warn() {} },
    describeDevice: () => "P20 Ultra Plus",
  };
  const Vacuum = VacuumClass.vacuum || VacuumClass;
  const vacuum = Object.create(Vacuum.prototype);
  vacuum.adapter = adapter;
  return { vacuum, lines };
}

test("a baseline once, then each change from → to", () => {
  const { vacuum, lines } = createVacuum();
  vacuum.logCleanSettingChanges("d", {
    state: 8,
    fan_power: 104,
    water_box_mode: 235,
    mop_mode: 300,
    seq_type: 0,
    repeat: 1,
  });
  expect(lines).toEqual([
    "Cleaning settings of P20 Ultra Plus: fan_power=104, water_box_mode=235, mop_mode=300, seq_type=0, repeat=1.",
  ]);

  vacuum.logCleanSettingChanges("d", {
    state: 8,
    fan_power: 104,
    water_box_mode: 235,
    mop_mode: 300,
    seq_type: 0,
    repeat: 1,
  });
  expect(lines).toHaveLength(1);

  vacuum.logCleanSettingChanges("d", {
    state: 8,
    fan_power: 104,
    water_box_mode: 235,
    mop_mode: 301,
    seq_type: 0,
    repeat: 2,
  });
  expect(lines[1]).toBe(
    "Cleaning settings of P20 Ultra Plus changed: mop_mode 300 → 301, repeat 1 → 2."
  );
});

"use strict";

// The mode probe exists to learn, in one pairing, how Apple Home names and
// orders every clean-mode tag. It is only useful if it announces every
// combination legally and never reaches a robot.

const {
  buildProbeModes,
  buildModeProbeAccessory,
  isModeProbeAccessory,
} = require("../src/mode_probe_accessory");

test("every primary with every intensity, legal and unique", () => {
  const modes = buildProbeModes();
  expect(modes).toHaveLength(60);
  expect(new Set(modes.map((mode) => mode.mode)).size).toBe(60);
  expect(new Set(modes.map((mode) => mode.label)).size).toBe(60);
  for (const mode of modes) {
    expect(mode.label.length).toBeLessThanOrEqual(64);
    expect(mode.modeTags.length).toBeLessThanOrEqual(8);
  }
  expect(modes.find((mode) => mode.mode === 27).modeTags).toEqual([
    { value: 16385 },
    { value: 16386 },
    { value: 2 },
  ]);
});

test("a tap is logged with what was chosen and reflected back", async () => {
  const lines = [];
  const updates = [];
  const probe = buildModeProbeAccessory({
    uuid: "u",
    deviceType: "rvc",
    log: { info: (line) => lines.push(line) },
    update: (cluster, attributes) => updates.push([cluster, attributes]),
  });
  expect(isModeProbeAccessory(probe)).toBe(true);
  await probe.handlers.rvcCleanMode.changeToMode({ newMode: 27 });
  expect(lines[0]).toContain('27 = "C3 Vac+Mop Quiet" (tags 16385/16386/2)');
  expect(updates[0]).toEqual(["rvcCleanMode", { currentMode: 27 }]);
});

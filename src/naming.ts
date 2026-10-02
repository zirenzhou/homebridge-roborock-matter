import type { PlatformAccessory, Service } from "homebridge";

/**
 * Name a service of an accessory that belongs to a robot: what it shows, with
 * the robot's name left out. "P20 Ultra Plus Dust Pending" is cut off after
 * the model in both Homebridge's and Apple Home's tiles, before the only part
 * that says anything.
 *
 * Apple Home keeps the name it saw when the accessory was added and follows
 * ConfiguredName after that, so a new name is written there too — once, when
 * it changes, so a name picked in the Home app is not overwritten at every
 * restart. The name last written is remembered in the accessory's context.
 */
export function applyServiceName(
  accessory: PlatformAccessory,
  service: Service | undefined,
  Characteristic: any,
  name: string
): void {
  accessory.displayName = name;
  if (!service) {
    return;
  }
  service.setCharacteristic(Characteristic.Name, name);
  const context = accessory.context as {
    serviceNames?: Record<string, string>;
  };
  const key = service.subtype
    ? `${service.UUID}:${service.subtype}`
    : service.UUID;
  const ConfiguredName = Characteristic.ConfiguredName;
  if (!ConfiguredName || context.serviceNames?.[key] === name) {
    return;
  }
  if (
    typeof service.testCharacteristic === "function" &&
    !service.testCharacteristic(ConfiguredName)
  ) {
    service.addOptionalCharacteristic(ConfiguredName);
  }
  service.setCharacteristic(ConfiguredName, name);
  context.serviceNames = { ...(context.serviceNames ?? {}), [key]: name };
}

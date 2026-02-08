import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { SystemImpl, System } from "../src/System";
import type { World } from "../src/Types";
import {
  createWorld,
  addEntity,
  addComponent,
  stepWorld,
  stepWorldTiming,
  clearWorldTiming,
  getSystem,
} from "../src/World";

@Component()
class TimingComp extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(TimingComp)
class TimingSystem extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(TimingComp, eid).val += 1;
  };
}

@Component()
class TimingComp2 extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(TimingComp2)
class TimingSystem2 extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(TimingComp2, eid).val += 1;
  };
}

@Component()
class ManualTimingComp extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(ManualTimingComp)
class ManualTimingSystem extends SystemImpl {
  static depth = -1;
  run = (world: World, eid: number) => {
    world(ManualTimingComp, eid).val += 1;
  };
}

@Component()
class CustomRunAllComp extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(CustomRunAllComp)
class CustomRunAllSystem extends SystemImpl {
  static depth = 0;

  // Custom runAll that doesn't use this.run
  runAll(world: World): void {
    const ents = this.query(world);
    for (let i = 0; i < ents.length; i++) {
      world(CustomRunAllComp, ents[i]).val += 10;
    }
  }
}

describe("stepWorldTiming", () => {
  test("stepWorldTiming runs systems and populates world.timing", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    stepWorldTiming(world);

    expect(world.timing).not.toBeNull();
    expect(world.timing!.systems.length).toBeGreaterThanOrEqual(1);
    expect(world.timing!.totalTime).toBeGreaterThanOrEqual(0);

    // System should have actually run
    expect(world(TimingComp, eid).val).toBe(1);
  });

  test("system timing has correct structure", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    stepWorldTiming(world);

    const systemTiming = world.timing!.systems.find((s) => s.name === "TimingSystem");
    expect(systemTiming).toBeDefined();
    expect(systemTiming!.name).toBe("TimingSystem");
    expect(systemTiming!.totalCalls).toBe(1);
    expect(systemTiming!.totalTime).toBeGreaterThanOrEqual(0);
    expect(systemTiming!.averageTime).toBeGreaterThanOrEqual(0);
  });

  test("timing tracks multiple entities", () => {
    const world = createWorld();
    const eid1 = addEntity(world);
    const eid2 = addEntity(world);
    const eid3 = addEntity(world);
    addComponent(world, TimingComp, eid1);
    addComponent(world, TimingComp, eid2);
    addComponent(world, TimingComp, eid3);

    stepWorldTiming(world);

    const systemTiming = world.timing!.systems.find((s) => s.name === "TimingSystem");
    expect(systemTiming).toBeDefined();
    expect(systemTiming!.totalCalls).toBe(3);
  });

  test("timing tracks multiple systems", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);
    addComponent(world, TimingComp2, eid);

    stepWorldTiming(world);

    expect(world.timing!.systems.length).toBeGreaterThanOrEqual(2);
    const sys1 = world.timing!.systems.find((s) => s.name === "TimingSystem");
    const sys2 = world.timing!.systems.find((s) => s.name === "TimingSystem2");
    expect(sys1).toBeDefined();
    expect(sys2).toBeDefined();
  });

  test("timing clears at the beginning of each stepWorldTiming call", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    stepWorldTiming(world);
    const firstTiming = world.timing!.systems.find((s) => s.name === "TimingSystem");
    expect(firstTiming).toBeDefined();
    const firstCalls = firstTiming!.totalCalls;

    stepWorldTiming(world);
    const secondTiming = world.timing!.systems.find((s) => s.name === "TimingSystem");
    expect(secondTiming).toBeDefined();
    // Should be fresh, not accumulated from previous step
    expect(secondTiming!.totalCalls).toBe(firstCalls);
  });

  test("stepWorld does not affect timing (zero overhead)", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    // Normal stepWorld should not populate timing
    stepWorld(world);
    expect(world.timing).toBeNull();

    // System timing should be null
    const system = getSystem(world, TimingSystem);
    expect(system.timing).toBeNull();
  });

  test("clearWorldTiming disables timing", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    stepWorldTiming(world);
    expect(world.timing).not.toBeNull();

    clearWorldTiming(world);
    expect(world.timing).toBeNull();
    expect(getSystem(world, TimingSystem).timing).toBeNull();
  });

  test("manual system tracks timing when called after stepWorldTiming", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, ManualTimingComp, eid);

    stepWorldTiming(world);

    // Manual system was not run by stepWorldTiming, but timing is enabled
    const manualSystem = getSystem(world, ManualTimingSystem);
    expect(manualSystem.timing).not.toBeNull();

    // Run manually
    manualSystem.runAll(world);
    expect(world(ManualTimingComp, eid).val).toBe(1);

    // Timing should have been recorded on the system
    expect(manualSystem.timing!.totalCalls).toBe(1);
    expect(manualSystem.timing!.totalTime).toBeGreaterThanOrEqual(0);

    // And on world.timing
    const worldSystemTiming = world.timing!.systems.find((s) => s.name === "ManualTimingSystem");
    expect(worldSystemTiming).toBeDefined();
  });

  test("frame increments with stepWorldTiming", () => {
    const world = createWorld();
    expect(world.frame).toBe(0);
    stepWorldTiming(world);
    expect(world.frame).toBe(1);
    stepWorldTiming(world);
    expect(world.frame).toBe(2);
  });

  test("world.timing.systems only includes systems that ran", () => {
    const world = createWorld();
    // Don't add any entities/components - no systems should run
    stepWorldTiming(world);

    expect(world.timing).not.toBeNull();
    expect(world.timing!.systems.length).toBe(0);
  });

  test("timing works for systems that override runAll", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, CustomRunAllComp, eid);

    stepWorldTiming(world);

    // System should have run its custom runAll
    expect(world(CustomRunAllComp, eid).val).toBe(10);

    // Timing should be tracked
    const systemTiming = world.timing!.systems.find((s) => s.name === "CustomRunAllSystem");
    expect(systemTiming).toBeDefined();
    expect(systemTiming!.name).toBe("CustomRunAllSystem");
    expect(systemTiming!.totalCalls).toBe(1);
    expect(systemTiming!.totalTime).toBeGreaterThanOrEqual(0);
  });
});
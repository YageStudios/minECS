import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { SystemImpl, DrawSystemImpl, System } from "../src/System";
import type { ReadOnlyWorld, World } from "../src/Types";
import {
  createWorld,
  addEntity,
  addComponent,
  stepWorld,
  stepWorldDraw,
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

// Components and systems for frameMod testing
@Component()
class FrameModComp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(FrameModComp)
class EveryFrameSystem extends SystemImpl {
  static depth = 0;
  static frameMod = 1;
  static frameModOffset = 0;
  run = (world: World, eid: number) => {
    world(FrameModComp, eid).runCount += 1;
  };
}

@Component()
class FrameMod2Comp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(FrameMod2Comp)
class EveryOtherFrameSystem extends SystemImpl {
  static depth = 0;
  static frameMod = 2;
  static frameModOffset = 0;
  run = (world: World, eid: number) => {
    world(FrameMod2Comp, eid).runCount += 1;
  };
}

@Component()
class FrameMod3Comp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(FrameMod3Comp)
class Every3rdFrameSystem extends SystemImpl {
  static depth = 0;
  static frameMod = 3;
  static frameModOffset = 0;
  run = (world: World, eid: number) => {
    world(FrameMod3Comp, eid).runCount += 1;
  };
}

@Component()
class FrameModOffsetComp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(FrameModOffsetComp)
class OffsetSystem extends SystemImpl {
  static depth = 0;
  static frameMod = 2;
  static frameModOffset = 1;
  run = (world: World, eid: number) => {
    world(FrameModOffsetComp, eid).runCount += 1;
  };
}

@Component()
class DrawFrameModOffsetComp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(DrawFrameModOffsetComp)
class DrawOffsetSystem extends DrawSystemImpl {
  static depth = 0;
  static frameMod = 2;
  static frameModOffset = 1;
  run = (world: ReadOnlyWorld, eid: number) => {
    (world as World)(DrawFrameModOffsetComp, eid).runCount += 1;
  };
}

@Component()
class FrameMod60Comp extends Schema {
  @type("number")
  @defaultValue(0)
  runCount: number;
}

@System(FrameMod60Comp)
class Every60thFrameSystem extends SystemImpl {
  static depth = 0;
  static frameMod = 60;
  static frameModOffset = 0;
  run = (world: World, eid: number) => {
    world(FrameMod60Comp, eid).runCount += 1;
  };
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
    expect(world(TimingComp, eid).val).toBe(1);
    const firstTiming = world.timing!.systems.find((s) => s.name === "TimingSystem");
    expect(firstTiming).toBeDefined();
    const firstCalls = firstTiming!.totalCalls;

    stepWorldTiming(world);
    expect(world(TimingComp, eid).val).toBe(2);
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

  test("wrapped runAll falls back to original when world timing is missing", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TimingComp, eid);

    // First call enables timing and installs the runAll wrapper.
    stepWorldTiming(world);
    const system = getSystem(world, TimingSystem);
    const callsBefore = system.timing!.totalCalls;
    expect(world(TimingComp, eid).val).toBe(1);

    // Keep wrapper installed, but remove world timing to force wrapper fallback path.
    world.timing = null;
    system.runAll(world);

    // Fallback should still execute original runAll.
    expect(world(TimingComp, eid).val).toBe(2);
    // No timing should be recorded while world.timing is null.
    expect(system.timing!.totalCalls).toBe(callsBefore);
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

describe("frameMod and frameModOffset", () => {
  test("system with frameMod=1 runs every frame", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameModComp, eid);

    for (let i = 0; i < 10; i++) {
      stepWorld(world);
    }

    expect(world(FrameModComp, eid).runCount).toBe(10);
  });

  test("system with frameMod=2 runs every other frame", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameMod2Comp, eid);

    for (let i = 0; i < 10; i++) {
      stepWorld(world);
    }

    // Runs on frames 1, 3, 5, 7, 9 = 5 times
    expect(world(FrameMod2Comp, eid).runCount).toBe(5);
  });

  test("system with frameMod=3 runs every 3rd frame", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameMod3Comp, eid);

    for (let i = 0; i < 9; i++) {
      stepWorld(world);
    }

    // Runs on frames 1, 4, 7 = 3 times
    expect(world(FrameMod3Comp, eid).runCount).toBe(3);
  });

  test("system with frameModOffset=1 starts on frame 2", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameModOffsetComp, eid);

    // After 1 step (frame 1), offset system should not have run
    stepWorld(world);
    expect(world(FrameModOffsetComp, eid).runCount).toBe(0);

    // After 2 steps (frame 2), offset system should have run once
    stepWorld(world);
    expect(world(FrameModOffsetComp, eid).runCount).toBe(1);

    // After 10 steps total, runs on frames 2, 4, 6, 8, 10 = 5 times
    for (let i = 0; i < 8; i++) {
      stepWorld(world);
    }
    expect(world(FrameModOffsetComp, eid).runCount).toBe(5);
  });

  test("draw system with frameModOffset=1 starts on draw frame 2", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, DrawFrameModOffsetComp, eid);
    world.frame = 1;

    // Draw frame 1: should not run
    stepWorldDraw(world);
    expect(world(DrawFrameModOffsetComp, eid).runCount).toBe(0);

    world.frame += 1; // Manually increment frame to simulate the passage of time between draw calls
    // Draw frame 2: first run
    stepWorldDraw(world);
    expect(world(DrawFrameModOffsetComp, eid).runCount).toBe(1);

    // Draw frames 3-10: additional runs on 4, 6, 8, 10
    for (let i = 0; i < 8; i++) {
      world.frame += 1; // Increment frame for each draw step
      stepWorldDraw(world);
    }
    expect(world(DrawFrameModOffsetComp, eid).runCount).toBe(5);
  });

  test("system with frameMod=60 runs once every 60 frames", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameMod60Comp, eid);

    // After 59 frames, should have run once (on frame 1)
    for (let i = 0; i < 59; i++) {
      stepWorld(world);
    }
    expect(world(FrameMod60Comp, eid).runCount).toBe(1);

    // After 60 frames, should still be 1
    stepWorld(world);
    expect(world(FrameMod60Comp, eid).runCount).toBe(1);

    // After 61 frames, should be 2 (ran on frame 61)
    stepWorld(world);
    expect(world(FrameMod60Comp, eid).runCount).toBe(2);
  });

  test("frameMod works with stepWorldTiming", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameMod2Comp, eid);

    for (let i = 0; i < 10; i++) {
      stepWorldTiming(world);
    }

    // Runs on frames 1, 3, 5, 7, 9 = 5 times
    expect(world(FrameMod2Comp, eid).runCount).toBe(5);
  });

  test("multiple systems can have different frameMod values to spread load", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, FrameModComp, eid);
    addComponent(world, FrameMod2Comp, eid);
    addComponent(world, FrameModOffsetComp, eid);

    for (let i = 0; i < 10; i++) {
      stepWorld(world);
    }

    // EveryFrameSystem: 10 times
    expect(world(FrameModComp, eid).runCount).toBe(10);
    // EveryOtherFrameSystem (offset 0): frames 1,3,5,7,9 = 5 times
    expect(world(FrameMod2Comp, eid).runCount).toBe(5);
    // OffsetSystem (frameMod=2, offset=1): frames 2,4,6,8,10 = 5 times
    expect(world(FrameModOffsetComp, eid).runCount).toBe(5);
  });
});

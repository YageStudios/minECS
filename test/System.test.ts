import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { SystemImpl, DrawSystemImpl, System } from "../src/System";
import type { World, ReadOnlyWorld } from "../src/Types";
import {
  createWorld,
  addEntity,
  addComponent,
  stepWorld,
  stepWorldDraw,
  getSystem,
} from "../src/World";

// Test System with category number
@Component()
class SysCatComp extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(5, SysCatComp)
class CategorizedSystem extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(SysCatComp, eid).val += 10;
  };
}

describe("System with category", () => {
  test("system with numeric category argument runs correctly", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SysCatComp, eid);

    expect(CategorizedSystem.category).toBe(5);

    stepWorld(world);
    expect(world(SysCatComp, eid).val).toBe(10);
  });
});

// Test multiple systems on same component set
@Component()
class SharedComp extends Schema {
  @type("number")
  @defaultValue(0)
  count: number;
}

@System(SharedComp)
class SharedSystemA extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(SharedComp, eid).count += 1;
  };
}

@System(SharedComp)
class SharedSystemB extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(SharedComp, eid).count += 100;
  };
}

describe("multiple systems on same components", () => {
  test("both systems registered and run", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SharedComp, eid);

    stepWorld(world);
    // Both systems should have run: +1 and +100
    expect(world(SharedComp, eid).count).toBe(101);
  });

  test("both systems retrievable via getSystem", () => {
    const world = createWorld();
    expect(getSystem(world, SharedSystemA)).toBeInstanceOf(SharedSystemA);
    expect(getSystem(world, SharedSystemB)).toBeInstanceOf(SharedSystemB);
  });
});

// Test system without run method
@Component()
class NoRunComp extends Schema {}

@System(NoRunComp)
class NoRunSystem extends SystemImpl {
  static depth = 0;
  initCalled = false;
  init = (world: World, eid: number) => {
    this.initCalled = true;
  };
}

describe("system without run method", () => {
  test("runAll is no-op when no run defined", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, NoRunComp, eid);

    // stepWorld calls runAll which checks if this.run exists
    stepWorld(world);

    // Should not throw, just skip
    expect(getSystem(world, NoRunSystem).initCalled).toBe(true);
  });
});

// Multiple draw systems on same component (covers World.ts lines 365-366)
@Component()
class DrawShared extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(DrawShared)
class DrawSystemA extends DrawSystemImpl {
  static depth = 0;
  run = (world: ReadOnlyWorld, eid: number) => {
    (world as World)(DrawShared, eid).val += 1;
  };
}

@System(DrawShared)
class DrawSystemB extends DrawSystemImpl {
  static depth = 0;
  run = (world: ReadOnlyWorld, eid: number) => {
    (world as World)(DrawShared, eid).val += 10;
  };
}

describe("multiple draw systems on same components", () => {
  test("both draw systems run on stepWorldDraw", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, DrawShared, eid);

    stepWorldDraw(world);
    expect(world(DrawShared, eid).val).toBe(11);
  });
});

// Multiple manual systems on same component (covers World.ts lines 326-327)
@Component()
class ManualShared extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@System(ManualShared)
class ManualSystemA extends SystemImpl {
  static depth = -1;
  run = (world: World, eid: number) => {
    world(ManualShared, eid).val += 1;
  };
}

@System(ManualShared)
class ManualSystemB extends SystemImpl {
  static depth = -1;
  run = (world: World, eid: number) => {
    world(ManualShared, eid).val += 100;
  };
}

describe("multiple manual systems on same components", () => {
  test("both manual systems registered and runnable", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, ManualShared, eid);

    // Manual systems don't run on stepWorld
    stepWorld(world);
    expect(world(ManualShared, eid).val).toBe(0);

    // Run them manually
    getSystem(world, ManualSystemA).runAll(world);
    expect(world(ManualShared, eid).val).toBe(1);

    getSystem(world, ManualSystemB).runAll(world);
    expect(world(ManualShared, eid).val).toBe(101);
  });
});

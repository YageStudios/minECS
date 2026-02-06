import { describe, expect, test } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import { Schema } from "../src/Schema";
import {
  createWorld,
  addEntity,
  addComponent,
  hasComponent,
  incrementBitflag,
} from "../src/World";

describe("incrementBitflag overflow", () => {
  test("bitflag wraps and adds new entity mask after 31 doublings", () => {
    const world = createWorld();
    const initialMaskCount = world.entityMasks.length;

    // bitflag starts at current value, double it until overflow
    // After registering components, bitflag is already > 1
    // Force it to near overflow
    world.bitflag = 2 ** 30;
    incrementBitflag(world);

    // 2^30 * 2 = 2^31, which triggers overflow
    expect(world.bitflag).toBe(1);
    expect(world.entityMasks.length).toBe(initialMaskCount + 1);
  });

  test("bitflag below threshold does not overflow", () => {
    const world = createWorld();
    const initialMaskCount = world.entityMasks.length;

    world.bitflag = 4;
    incrementBitflag(world);

    expect(world.bitflag).toBe(8);
    expect(world.entityMasks.length).toBe(initialMaskCount);
  });
});

@Component()
class ValComp extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

describe("validateComponent error path", () => {
  test("invalid override type throws with schema details", () => {
    const world = createWorld();
    const eid = addEntity(world);
    try {
      // @ts-ignore
      addComponent(world, ValComp, eid, { val: "not_a_number" });
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.error).toBeInstanceOf(Error);
      expect(e.error.message).toContain("ValComp");
      expect(e.errors).toBeDefined();
      expect(e.schema).toBeDefined();
    }
  });
});

describe("hasComponent on unregistered component", () => {
  test("returns false for component not in componentMap", () => {
    // Create a fake schema that was never registered
    class FakeSchema extends Schema {}
    // @ts-ignore
    FakeSchema.type = "FakeSchema";

    const world = createWorld();
    const eid = addEntity(world);

    expect(hasComponent(world, FakeSchema, eid)).toBe(false);
  });
});

describe("addComponent reset parameter", () => {
  test("reset=false skips store reset", () => {
    const world = createWorld();
    const eid = addEntity(world);

    // Manually set a value in the store before adding the component
    const comp = world(ValComp);
    comp.store.val[eid] = 999;

    // With reset=false, the pre-existing store value should persist
    // (though overrides still apply)
    addComponent(world, ValComp, eid, { val: 42 }, false);
    expect(world(ValComp, eid).val).toBe(42);
  });
});

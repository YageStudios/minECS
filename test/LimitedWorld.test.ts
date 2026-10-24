import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { DrawSystemImpl, System, SystemImpl } from "../src/System";
import type { World } from "../src/Types";
import {
  addComponent,
  addEntity,
  createWorld,
  getSystem,
  hasComponent,
  isComponentRegistered,
  stepWorld,
  stepWorldDraw,
} from "../src/World";
import { defineQuery } from "../src/Query";
import { serializeWorld } from "../src/Serialize";
import { SerialMode } from "../src/Types";
import { deserializeWorld } from "../src/Deserialize";

@Component()
class LwA extends Schema {
  @type("number") @defaultValue(0) a: number;
}
@Component()
class LwB extends Schema {
  @type("number") @defaultValue(0) b: number;
}
@Component()
class LwC extends Schema {
  @type("number") @defaultValue(0) c: number;
}

const ran: string[] = [];
@System(LwA)
class LwASystem extends SystemImpl {
  run = (world: World, eid: number) => {
    ran.push("A");
    world(LwA, eid).a++;
  };
}
@System(LwB)
class LwBSystem extends SystemImpl {
  run = () => {
    ran.push("B");
  };
}
@System(LwA, LwC)
class LwACSystem extends SystemImpl {
  run = () => {
    ran.push("AC");
  };
}
@System(LwC)
class LwEmptySystem extends SystemImpl {
  static runEmpty = true;
  runAll = () => {
    ran.push("empty");
  };
}
@System(LwC)
class LwDrawEmpty extends DrawSystemImpl {
  static runEmpty = true;
  runAll = () => {
    ran.push("draw-empty");
  };
}

describe("createWorld with a component/system subset", () => {
  test("registers only the listed components and creates only the listed systems", () => {
    const world = createWorld(8, { components: [LwB, LwA], systems: [LwASystem] });
    expect(isComponentRegistered(world, LwA)).toBe(true);
    expect(isComponentRegistered(world, LwB)).toBe(true);
    expect(isComponentRegistered(world, LwC)).toBe(false);
    expect(world.componentMap.size).toBe(2);
    expect(world.systems.map((s) => s.constructor)).toEqual([LwASystem]);
    expect(getSystem(world, LwBSystem)).toBeUndefined();

    const eid = addEntity(world);
    addComponent(world, LwA, eid, { a: 1 });
    addComponent(world, LwB, eid);
    ran.length = 0;
    stepWorld(world);
    expect(ran).toEqual(["A"]);
    expect(world(LwA, eid).a).toBe(2);
    expect(hasComponent(world, LwC, eid)).toBe(false);
  });

  test("an unregistered schema gives a clear error from world(), queries and createWorld", () => {
    const world = createWorld(8, { components: [LwA], systems: [] });
    expect(() => world(LwB, 0)).toThrow(/component LwB is not registered in this world \(registered: LwA\)/);
    expect(() => world(LwB)).toThrow(/LwB is not registered/);
    expect(() => defineQuery([LwA, LwB])(world)).toThrow(/query LwA\|LwB uses component LwB, which is not registered/);
    expect(() => createWorld(8, { components: [LwA], systems: [LwACSystem] })).toThrow(
      /system LwACSystem queries LwC, which is not in this world's components/,
    );
    class NotDecorated extends SystemImpl {}
    expect(() => createWorld(8, { components: [LwA], systems: [NotDecorated] })).toThrow(/not a defined system/);
    class NotAComponent extends Schema {}
    expect(() => createWorld(8, { components: [NotAComponent] })).toThrow(/not a defined component/);
  });

  test("a component subset alone keeps the systems whose components are all present", () => {
    const world = createWorld(8, { components: [LwA, LwB] });
    const kinds = world.systems.map((s) => s.constructor);
    expect(kinds).toContain(LwASystem);
    expect(kinds).toContain(LwBSystem);
    expect(kinds).not.toContain(LwACSystem);
    expect(world.drawSystems).toEqual([]);
  });

  test("column order and world(schema) do not depend on the listed order", () => {
    const one = createWorld(4, { components: [LwA, LwC], systems: [] });
    const two = createWorld(4, { components: [LwC, LwA], systems: [] });
    expect(Array.from(one.componentMap.keys())).toEqual(Array.from(two.componentMap.keys()));
    expect(one(LwC).schema).toBe(LwC);
    expect(one.componentList[LwA.index].schema).toBe(LwA);
  });

  test("runEmpty systems run with an empty query, in step and draw", () => {
    const world = createWorld(4, { components: [LwC], systems: [LwEmptySystem, LwDrawEmpty] });
    ran.length = 0;
    stepWorld(world);
    stepWorldDraw(world);
    expect(ran).toEqual(["empty", "draw-empty"]);
  });

  test("deserializeWorld restores into a new subset world from options", () => {
    const options = { components: [LwA], systems: [LwASystem] };
    const source = createWorld(8, options);
    const eid = addEntity(source);
    addComponent(source, LwA, eid, { a: 7 });
    for (const mode of [SerialMode.BINARY, SerialMode.JSON, SerialMode.BASE64] as const) {
      const restored = deserializeWorld(serializeWorld(mode as any, source) as any, options);
      expect(restored.componentMap.size).toBe(1);
      expect(restored.systems.map((s) => s.constructor)).toEqual([LwASystem]);
      expect(restored(LwA, eid).a).toBe(7);
    }
    const into = createWorld(8, options);
    expect(deserializeWorld(serializeWorld(SerialMode.BINARY, source), into)).toBe(into);
  });
});

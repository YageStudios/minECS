import { describe, expect, test } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import {
  createWorld,
  addEntity,
  entityExists,
  addComponent,
  hasComponent,
  removeComponent,
  removeEntity,
  disableComponent,
  deleteWorld,
  stepWorld,
  stepWorldDraw,
  getSystem,
  getSystemsByType,
  snapshot,
} from "../src/World";
import { Schema } from "../src/Schema";
import { SystemImpl, DrawSystemImpl, System } from "../src/System";
import type { World, ReadOnlyWorld } from "../src/Types";
import { createDeltaSerializer } from "../src/Serialize";
import { applyDelta } from "../src/Deserialize";

@Component()
class WPos extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(0)
  y: number;
}

@Component()
class WTag extends Schema {}

@Component()
class WDisable extends Schema {
  @type("number")
  @defaultValue(42)
  value: number;
}

@Component()
class WDraw extends Schema {
  @type("number")
  @defaultValue(0)
  frame: number;
}

@System(WDraw)
class WDrawSystem extends DrawSystemImpl {
  static depth = 0;
  run = (world: ReadOnlyWorld, eid: number) => {
    (world as World)(WDraw, eid).frame += 1;
  };
}

@Component()
class WLookup extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;
}

@System(WLookup)
class WLookupSystem extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(WLookup, eid).n += 1;
  };
}

describe("disableComponent", () => {
  test("clears bitmask but preserves store data", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid, { value: 99 });
    expect(hasComponent(world, WDisable, eid)).toBe(true);

    disableComponent(world, WDisable, eid);
    expect(hasComponent(world, WDisable, eid)).toBe(false);
  });

  test("throws on non-existent entity", () => {
    const world = createWorld();
    expect(() => disableComponent(world, WDisable, 999)).toThrow();
  });

  test("no-op if entity lacks the component", () => {
    const world = createWorld();
    const eid = addEntity(world);
    disableComponent(world, WDisable, eid);
    expect(hasComponent(world, WDisable, eid)).toBe(false);
  });

  test("throws on undefined eid", () => {
    const world = createWorld();
    // @ts-ignore
    expect(() => disableComponent(world, WDisable, undefined)).toThrow("entity is undefined");
  });
});

describe("deleteWorld", () => {
  test("frees component stores without error", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WPos, eid, { x: 1, y: 2 });
    deleteWorld(world);
  });
});

describe("Entity error paths", () => {
  test("addComponent with undefined eid throws", () => {
    const world = createWorld();
    // @ts-ignore
    expect(() => addComponent(world, WTag, undefined)).toThrow("entity is undefined");
  });

  test("addComponent on non-existent entity throws", () => {
    const world = createWorld();
    expect(() => addComponent(world, WTag, 999)).toThrow("does not exist");
  });

  test("removeComponent with undefined eid throws", () => {
    const world = createWorld();
    // @ts-ignore
    expect(() => removeComponent(world, WTag, undefined)).toThrow("entity is undefined");
  });

  test("removeComponent on non-existent entity throws", () => {
    const world = createWorld();
    expect(() => removeComponent(world, WTag, 999)).toThrow("does not exist");
  });

  test("removeComponent on entity without component is no-op", () => {
    const world = createWorld();
    const eid = addEntity(world);
    removeComponent(world, WTag, eid);
    expect(hasComponent(world, WTag, eid)).toBe(false);
  });

  test("removeEntity on already-removed entity is no-op", () => {
    const world = createWorld();
    const eid = addEntity(world);
    removeEntity(world, eid);
    removeEntity(world, eid);
    expect(entityExists(world, eid)).toBe(false);
  });

  test("addComponent twice is idempotent", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid, { value: 10 });
    addComponent(world, WDisable, eid, { value: 99 });
    expect(world(WDisable, eid).value).toBe(10);
  });

  test("hasComponent returns false for entity without component", () => {
    const world = createWorld();
    const eid = addEntity(world);
    expect(hasComponent(world, WDisable, eid)).toBe(false);
  });
});

describe("Proxy behavior", () => {
  test("spread enumerates all keys including type", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid, { value: 42 });
    const spread = { ...world(WDisable, eid) };
    expect(spread).toHaveProperty("type", "WDisable");
    expect(spread).toHaveProperty("value", 42);
    expect(Object.keys(world(WDisable, eid))).toEqual(Object.keys(spread));
  });

  test("snapshot matches spread", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid, { value: 42 });
    expect(snapshot(world, WDisable, eid)).toEqual({ ...world(WDisable, eid) });
    expect(JSON.parse(JSON.stringify(world(WDisable, eid)))).toEqual({ ...world(WDisable, eid) });
  });

  test("get returns undefined for unknown key", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid);
    // @ts-ignore
    expect(world(WDisable, eid).nonexistent).toBeUndefined();
  });

  test("set on unknown key throws in strict mode", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDisable, eid);
    expect(() => {
      // @ts-ignore
      world(WDisable, eid).nonexistent = 5;
    }).toThrow();
  });

  test("world(Component) without eid returns WorldComponent", () => {
    const world = createWorld();
    const comp = world(WDisable);
    expect(comp).toBeDefined();
    expect(comp.type).toBe("WDisable");
  });
});

describe("stepWorldDraw", () => {
  test("draw systems run on stepWorldDraw", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDraw, eid);

    stepWorldDraw(world);
    expect(world(WDraw, eid).frame).toBe(1);
    stepWorldDraw(world);
    expect(world(WDraw, eid).frame).toBe(2);
  });

  test("stepWorld does NOT run draw systems", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WDraw, eid);

    stepWorld(world);
    expect(world(WDraw, eid).frame).toBe(0);
  });
});

describe("getSystemsByType", () => {
  test("returns systems matching a component type", () => {
    const world = createWorld();
    const systems = getSystemsByType(world, "WLookup");
    expect(systems.length).toBeGreaterThan(0);
  });

  test("returns empty for unknown type", () => {
    const world = createWorld();
    expect(getSystemsByType(world, "FakeType")).toEqual([]);
  });
});

describe("Entity recycling", () => {
  test("pop-based recycling reuses IDs", () => {
    const world = createWorld(100);
    const eids: number[] = [];
    for (let i = 0; i < 10; i++) eids.push(addEntity(world));
    for (const eid of eids) removeEntity(world, eid);

    const recycled = addEntity(world);
    expect(eids).toContain(recycled);
  });

  test("recycled entity does not retain old components", () => {
    const world = createWorld(100);
    const eids: number[] = [];
    for (let i = 0; i < 10; i++) eids.push(addEntity(world));
    addComponent(world, WDisable, eids[0], { value: 999 });
    for (const eid of eids) removeEntity(world, eid);

    const recycled = addEntity(world);
    expect(hasComponent(world, WDisable, recycled)).toBe(false);
  });
});

describe("World frame counter", () => {
  test("frame increments each stepWorld", () => {
    const world = createWorld();
    expect(world.frame).toBe(0);
    stepWorld(world);
    expect(world.frame).toBe(1);
    stepWorld(world);
    expect(world.frame).toBe(2);
  });
});

describe("validateComponent toJSON path", () => {
  test("override value with toJSON is serialized before validation", () => {
    const world = createWorld();
    const eid = addEntity(world);

    // Create a value object whose toJSON returns a plain number
    const customX = {
      toJSON() {
        return 42;
      },
    };

    // The toJSON branch in validateComponent converts the value
    // before schema validation, so the override { x: customX }
    // becomes { x: 42 } which passes AJV validation
    addComponent(world, WPos, eid, { x: customX as any, y: 10 });
    expect(world(WPos, eid).x).toBe(42);
    expect(world(WPos, eid).y).toBe(10);
  });
});

@Component()
class WMixed extends Schema {
  @type("number")
  @defaultValue(1)
  n: number;

  @type("boolean")
  @defaultValue(true)
  flag: boolean;

  @type("string")
  @defaultValue("hi")
  label: string;

  @type(["number"])
  @defaultValue([1, 2])
  list: number[];
}

describe("accessor cache", () => {
  test("snapshot matches spread across field kinds", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WMixed, eid, { n: 7, flag: false, label: "x", list: [3, 4] });
    const snap = snapshot(world, WMixed, eid);
    const spread = { ...world(WMixed, eid) };
    expect(snap).toEqual(spread);
    expect(Object.keys(snap)).toEqual(Object.keys(spread));
    expect(snap.type).toBe("WMixed");
  });

  test("accessor is reused after remove/re-add and stays correct", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WMixed, eid, { n: 5 });
    const first = world(WMixed, eid);
    removeComponent(world, WMixed, eid);
    addComponent(world, WMixed, eid, { n: 9 });
    const second = world(WMixed, eid);
    expect(second).toBe(first);
    expect(second.n).toBe(9);
    second.n = 11;
    expect(world(WMixed, eid).n).toBe(11);
  });

  test("first access at a high eid works and lower eids still resolve", () => {
    const world = createWorld(5000);
    const eids: number[] = [];
    for (let i = 0; i < 4000; i++) eids.push(addEntity(world));
    const high = eids[3999];
    addComponent(world, WMixed, high, { n: 42 });
    expect(world(WMixed, high).n).toBe(42);
    addComponent(world, WMixed, eids[0], { n: 1 });
    expect(world(WMixed, eids[0]).n).toBe(1);
    expect(world(WMixed, high).n).toBe(42);
  });
});

describe("accessors across many worlds", () => {
  test("shared-class worlds (beyond the dedicated ones) keep values, spread and delta tracking", () => {
    const worlds = Array.from({ length: 6 }, () => createWorld(100));
    const eids = worlds.map((w, i) => {
      const eid = addEntity(w);
      addComponent(w, WMixed, eid, { n: i, flag: i % 2 === 0, label: `w${i}`, list: [i, i] });
      return eid;
    });
    worlds.forEach((w, i) => {
      const acc = world6(w, eids[i]);
      expect({ ...acc }).toEqual({ n: i, flag: i % 2 === 0, label: `w${i}`, list: [i, i], type: "WMixed" });
      expect(snapshot(w, WMixed, eids[i])).toEqual({ ...acc });
      expect(() => {
        // @ts-ignore
        acc.nope = 1;
      }).toThrow();
    });

    // Delta tracking through the last (shared-class) world's setters.
    const src = worlds[5];
    const dst = createWorld(100);
    const dstEid = addEntity(dst);
    addComponent(dst, WMixed, dstEid);
    const delta = createDeltaSerializer(src);
    delta.serialize();
    src(WMixed, eids[5]).n = 99;
    src(WMixed, eids[5]).list[0] = 7;
    applyDelta(delta.serialize(), dst);
    expect(dst(WMixed, dstEid).n).toBe(99);
    expect(Array.from(dst(WMixed, dstEid).list)).toEqual([7, 5]);
    // Other worlds untouched.
    expect(worlds[4](WMixed, eids[4]).n).toBe(4);
  });
});

const world6 = (w: World, eid: number) => w(WMixed, eid);

describe("snapshot overloads", () => {
  test("snapshot(world, eid) and snapshot(world) cover every component of every entity", () => {
    const world = createWorld();
    const a = addEntity(world);
    const b = addEntity(world);
    const empty = addEntity(world);
    addComponent(world, WMixed, a, { n: 3, label: "a" });
    addComponent(world, WTag, a);
    addComponent(world, WMixed, b, { n: 4, flag: false });

    expect(snapshot(world, a)).toEqual({
      WMixed: { ...world(WMixed, a) },
      WTag: { type: "WTag" },
    });
    expect(snapshot(world, b)).toEqual({ WMixed: snapshot(world, WMixed, b) });
    expect(snapshot(world, empty)).toEqual({});

    const all = snapshot(world);
    expect(Object.keys(all).map(Number).sort()).toEqual([a, b, empty].sort());
    expect(all[a]).toEqual(snapshot(world, a));
    expect(all[b]).toEqual(snapshot(world, b));
    expect(all[empty]).toEqual({});

    // Plain copies: later writes don't leak into them.
    world(WMixed, a).n = 100;
    expect(all[a].WMixed.n).toBe(3);
  });

  test("snapshot of a removed component or missing entity", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WMixed, eid);
    removeComponent(world, WMixed, eid);
    expect(snapshot(world, eid)).toEqual({});
    expect(() => snapshot(world, 999)).toThrow();
  });
});

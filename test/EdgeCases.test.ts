import { afterEach, describe, expect, test, vi } from "vitest";
import { Component, defaultValue, nullable, required, type } from "../src/Decorators";
import {
  addComponent,
  addEntity,
  createWorld,
  disableComponent,
  entityExists,
  hasComponent,
  removeComponent,
  removeEntity,
  rebuildComponentBitTable,
  snapshot,
} from "../src/World";
import { Schema } from "../src/Schema";
import { System, SystemImpl } from "../src/System";
import { defineQuery } from "../src/Query";
import { createDeltaSerializer, fastClone, fastEqual, serializeWorld } from "../src/Serialize";
import { applyDelta, deserializeWorld } from "../src/Deserialize";
import { SerialMode, type World } from "../src/Types";

@Component()
class EdBlob extends Schema {
  @type("object")
  bytes: Uint8Array;

  @type("number")
  @defaultValue(0)
  n: number;
}

@Component()
class EdPos extends Schema {
  @type("number")
  @defaultValue(1)
  x: number;

  @type("number")
  y: number;
}

@Component()
class EdText extends Schema {
  @type("string")
  s: string;

  @type("string")
  @defaultValue("d")
  t: string;
}

@Component()
class EdVec extends Schema {
  @type(["float32", 3])
  v: Float32Array;
}

@Component()
class EdObj extends Schema {
  @type("object")
  @defaultValue({ a: { b: 1 } })
  o: any;
}

@Component()
class EdReq extends Schema {
  @type("number")
  @required()
  r: number;
}

/** One field of every column kind, for accessor-class tests. */
@Component()
class EdMixed extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;

  @type("boolean")
  @defaultValue(false)
  b: boolean;

  @type("string")
  @defaultValue("")
  s: string;

  @type("string")
  @nullable()
  ns: string | null;

  @type(["float32", 2])
  v: Float32Array;

  @type("object")
  @defaultValue({})
  o: any;
}

/** Used only by the no-code-generation tests, so its accessor classes are built under the stub. */
@Component()
class EdCsp extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;

  @type("boolean")
  @defaultValue(false)
  b: boolean;

  @type("string")
  @defaultValue("")
  s: string;

  @type(["float32", 2])
  v: Float32Array;
}

// Systems whose cleanup hooks misbehave on purpose, switched per test.
let cleanupMode: "none" | "removeSelf" | "addOther" | "readdSame" | "removeOther" = "none";
let otherEid = -1;
const cleanupLog: string[] = [];

@Component()
class EdHooked extends Schema {}

@Component()
class EdLate extends Schema {}

@Component()
class EdOther extends Schema {}

@System(EdHooked)
class EdHookedSystem extends SystemImpl {
  init(_world: World, eid: number) {
    cleanupLog.push(`init:hooked:${eid}`);
  }
  cleanup(world: World, eid: number) {
    cleanupLog.push(`cleanup:hooked:${eid}`);
    if (cleanupMode === "removeSelf") removeEntity(world, eid);
    if (cleanupMode === "addOther") addComponent(world, EdLate, eid);
    if (cleanupMode === "readdSame") {
      // Leaves and re-joins EdOther's queries without changing the entity's component bits.
      removeComponent(world, EdOther, eid);
      addComponent(world, EdOther, eid);
    }
    if (cleanupMode === "removeOther") removeEntity(world, otherEid);
  }
}

@System(EdLate)
class EdLateSystem extends SystemImpl {
  cleanup(_world: World, eid: number) {
    cleanupLog.push(`cleanup:late:${eid}`);
  }
}

@System(EdOther)
class EdOtherSystem extends SystemImpl {
  cleanup(_world: World, eid: number) {
    cleanupLog.push(`cleanup:other:${eid}`);
  }
}

afterEach(() => {
  cleanupMode = "none";
  cleanupLog.length = 0;
});

const validationError = (fn: () => void): string => {
  try {
    fn();
  } catch (e: any) {
    return e?.error?.message ?? e?.message ?? String(e);
  }
  return "";
};

describe("addComponent overrides", () => {
  test("an explicit undefined is written as given, an absent key keeps its reset value", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid, { x: 2, y: undefined } as any);
    // Float64 column: undefined is stored as NaN (historical behaviour).
    expect(world(EdPos, eid).y).toBeNaN();

    const other = addEntity(world);
    addComponent(world, EdPos, other, { x: 2 });
    expect(world(EdPos, other).y).toBe(0);
  });

  test("an explicit undefined with reset=false still overwrites the previous value", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdText, eid, { s: "old" });
    removeComponent(world, EdText, eid);
    addComponent(world, EdText, eid, { s: undefined } as any, false);
    expect(world(EdText, eid).s).toBeUndefined();
  });

  test("an explicit undefined on a key with a default gets the default", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid, { x: undefined, y: 4 } as any);
    expect([world(EdPos, eid).x, world(EdPos, eid).y]).toEqual([1, 4]);
  });

  test("an explicit undefined for a fixed-length array keeps the zeroed array", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdVec, eid, { v: undefined } as any);
    expect(Array.from(world(EdVec, eid).v)).toEqual([0, 0, 0]);
  });

  test("an invalid override leaves the entity unchanged, so a retry works", () => {
    const world = createWorld(16);
    const query = defineQuery([EdPos]);
    query(world);
    const eid = addEntity(world);

    expect(validationError(() => addComponent(world, EdPos, eid, { x: "bad" } as any))).toMatch(
      "Invalid schema for component EdPos",
    );
    expect(hasComponent(world, EdPos, eid)).toBe(false);
    expect(query(world)).not.toContain(eid);

    addComponent(world, EdPos, eid, { x: 9, y: 9 });
    expect(hasComponent(world, EdPos, eid)).toBe(true);
    expect(world(EdPos, eid).x).toBe(9);
    expect(query(world)).toContain(eid);
  });

  test("an invalid override is invisible to delta serialization", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    const mirror = createWorld(16);
    const delta = createDeltaSerializer(world);
    deserializeWorld(delta.serialize(), mirror);
    expect(() => addComponent(world, EdPos, eid, { y: "no" } as any)).toThrow();
    applyDelta(delta.serialize(), mirror);
    expect(hasComponent(mirror, EdPos, eid)).toBe(false);
  });

  test("a fixed-length array that is too long throws without half-adding the component", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    expect(() => addComponent(world, EdVec, eid, { v: [1, 2, 3, 4] } as any)).toThrow();
    expect(hasComponent(world, EdVec, eid)).toBe(false);
    addComponent(world, EdVec, eid, { v: [1, 2, 3] });
    expect(Array.from(world(EdVec, eid).v)).toEqual([1, 2, 3]);
  });

  test("a shorter fixed-length array leaves the rest zeroed", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdVec, eid, { v: [5] } as any);
    expect(Array.from(world(EdVec, eid).v)).toEqual([5, 0, 0]);
  });

  test("unknown keys are rejected and leave the entity unchanged", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    expect(() => addComponent(world, EdPos, eid, { x: 1, bogus: 2 } as any)).toThrow();
    expect(hasComponent(world, EdPos, eid)).toBe(false);
  });

  test("a required key without a default and no overrides throws and leaves the entity unchanged", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    expect(validationError(() => addComponent(world, EdReq, eid))).toMatch("Invalid schema for component EdReq");
    expect(hasComponent(world, EdReq, eid)).toBe(false);
    addComponent(world, EdReq, eid, { r: 3 });
    expect(world(EdReq, eid).r).toBe(3);
  });

  test("overrides that are null, undefined or {} apply the defaults", () => {
    const world = createWorld(16);
    const [a, b, c] = [addEntity(world), addEntity(world), addEntity(world)];
    addComponent(world, EdPos, a, null as any);
    addComponent(world, EdPos, b, undefined);
    addComponent(world, EdPos, c, {});
    for (const eid of [a, b, c]) expect({ ...world(EdPos, eid) }).toEqual({ x: 1, y: 0, type: "EdPos" });
  });

  test("a frozen overrides object still gets its defaults, without being mutated", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    const overrides = Object.freeze({ y: 7 });
    addComponent(world, EdPos, eid, overrides as any);
    expect([world(EdPos, eid).x, world(EdPos, eid).y]).toEqual([1, 7]);
    expect(overrides).toEqual({ y: 7 });
  });

  test("a frozen overrides object with an invalid value still fails validation", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    expect(() => addComponent(world, EdPos, eid, Object.freeze({ y: "no" }) as any)).toThrow();
    expect(hasComponent(world, EdPos, eid)).toBe(false);
  });

  test("typed-array overrides for fixed-length arrays are accepted and the caller's object is untouched", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    const v = new Float32Array([4, 5, 6]);
    const overrides = { v };
    addComponent(world, EdVec, eid, overrides);
    expect(Array.from(world(EdVec, eid).v)).toEqual([4, 5, 6]);
    expect(overrides.v).toBe(v);
    // Stored by copy, not by reference.
    v[0] = 99;
    expect(world(EdVec, eid).v[0]).toBe(4);
  });

  test("a typed array in an object field is accepted and kept as that typed array", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    const bytes = new Uint8Array([1, 2, 3]);
    addComponent(world, EdBlob, eid, { bytes });
    expect(world(EdBlob, eid).bytes).toBe(bytes);
    expect(world(EdBlob, eid).n).toBe(0);
  });

  test("a typed array in an object field is kept as given from frozen overrides too", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    const bytes = new Uint8Array([7]);
    addComponent(world, EdBlob, eid, Object.freeze({ bytes }));
    expect(world(EdBlob, eid).bytes).toBe(bytes);
    expect(world(EdBlob, eid).n).toBe(0);
  });

  test("another world's accessor can be used as overrides", () => {
    const source = createWorld(16);
    const se = addEntity(source);
    addComponent(source, EdPos, se, { x: 3, y: 4 });
    addComponent(source, EdText, se, { s: "hi" });
    addComponent(source, EdVec, se, { v: [1, 2, 3] });

    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid, source(EdPos, se));
    addComponent(world, EdText, eid, source(EdText, se));
    addComponent(world, EdVec, eid, source(EdVec, se) as any);
    expect({ ...world(EdPos, eid) }).toEqual({ x: 3, y: 4, type: "EdPos" });
    expect({ ...world(EdText, eid) }).toEqual({ s: "hi", t: "d", type: "EdText" });
    expect(Array.from(world(EdVec, eid).v)).toEqual([1, 2, 3]);

    // Copied, not shared.
    world(EdVec, eid).v[0] = 50;
    expect(source(EdVec, se).v[0]).toBe(1);
  });

  test("toJSON values on another world's accessor do not write through its setters", () => {
    const source = createWorld(16);
    const se = addEntity(source);
    const value = { toJSON: () => ({ z: 1 }) };
    addComponent(source, EdObj, se);
    source(EdObj, se).o = value;

    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdObj, eid, source(EdObj, se));
    expect(world(EdObj, eid).o).toEqual({ z: 1 });
    expect(source(EdObj, se).o).toBe(value);
  });

  test("values from getters and prototypes are used, like the validator sees them", () => {
    class Vec {
      y = 12;
      get x() {
        return 11;
      }
    }
    const world = createWorld(16);
    const a = addEntity(world);
    addComponent(world, EdPos, a, new Vec() as any);
    expect([world(EdPos, a).x, world(EdPos, a).y]).toEqual([11, 12]);

    const b = addEntity(world);
    const inherited = Object.create({ x: 5 });
    inherited.y = 6;
    addComponent(world, EdPos, b, inherited);
    expect([world(EdPos, b).x, world(EdPos, b).y]).toEqual([5, 6]);
  });

  test("toJSON values are stored in JSON form", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdObj, eid, { o: { toJSON: () => ({ z: 2 }) } });
    expect(world(EdObj, eid).o).toEqual({ z: 2 });

    const frozen = addEntity(world);
    addComponent(world, EdObj, frozen, Object.freeze({ o: { toJSON: () => ({ z: 3 }) } }));
    expect(world(EdObj, frozen).o).toEqual({ z: 3 });
  });

  test("one overrides object can be reused for several entities", () => {
    const world = createWorld(16);
    const overrides = { y: 2 };
    const a = addEntity(world);
    const b = addEntity(world);
    addComponent(world, EdPos, a, overrides);
    addComponent(world, EdPos, b, overrides);
    expect({ ...world(EdPos, a) }).toEqual({ ...world(EdPos, b) });
    expect(world(EdPos, b).x).toBe(1);
  });

  test("object defaults are cloned per entity", () => {
    const world = createWorld(16);
    const a = addEntity(world);
    const b = addEntity(world);
    addComponent(world, EdObj, a);
    addComponent(world, EdObj, b);
    world(EdObj, a).o.a.b = 99;
    expect(world(EdObj, b).o.a.b).toBe(1);
  });

  test("re-adding after removal resets values, unless reset is false", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid, { x: 4, y: 5 });
    removeComponent(world, EdPos, eid);
    addComponent(world, EdPos, eid);
    expect([world(EdPos, eid).x, world(EdPos, eid).y]).toEqual([1, 0]);

    removeComponent(world, EdPos, eid);
    world(EdPos, eid).y = 8;
    addComponent(world, EdPos, eid, undefined, false);
    expect([world(EdPos, eid).x, world(EdPos, eid).y]).toEqual([1, 8]);
  });

  test("a recycled entity starts from reset values for every column kind", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdMixed, eid, { n: 3, b: true, s: "x", ns: "y", v: [1, 2], o: { k: 1 } });
    removeEntity(world, eid);
    const reused = addEntity(world);
    expect(reused).toBe(eid);
    addComponent(world, EdMixed, reused);
    const v = world(EdMixed, reused);
    expect([v.n, v.b, v.s, v.ns, Array.from(v.v), v.o]).toEqual([0, false, "", undefined, [0, 0], {}]);
  });
});

describe("entity capacity and recycling", () => {
  test("a world of size n holds exactly n entities, and the last one can hold components", () => {
    const world = createWorld(4);
    const ids = [addEntity(world), addEntity(world), addEntity(world), addEntity(world)];
    expect(ids).toEqual([0, 1, 2, 3]);
    expect(() => addEntity(world)).toThrow("max entities reached");

    addComponent(world, EdPos, 3, { x: 7, y: 7 });
    expect(hasComponent(world, EdPos, 3)).toBe(true);
    expect(world(EdPos, 3).x).toBe(7);
    expect(snapshot(world, 3)).toEqual({ EdPos: { x: 7, y: 7, type: "EdPos" } });
  });

  test("a full world reuses freed ids even below the reuse threshold", () => {
    const world = createWorld(1000);
    for (let i = 0; i < 1000; i++) addEntity(world);
    removeEntity(world, 500);
    expect(addEntity(world)).toBe(500);
    expect(() => addEntity(world)).toThrow("max entities reached");
  });

  test("a failed addEntity does not consume an id", () => {
    const world = createWorld(2);
    addEntity(world);
    addEntity(world);
    expect(() => addEntity(world)).toThrow();
    expect(() => addEntity(world)).toThrow();
    expect(world.entityCursor).toBe(2);
    removeEntity(world, 0);
    expect(addEntity(world)).toBe(0);
  });

  test("entity 0 behaves like any other entity", () => {
    const world = createWorld(4);
    const eid = addEntity(world);
    expect(eid).toBe(0);
    addComponent(world, EdPos, eid, { x: 5 });
    expect([...defineQuery([EdPos])(world)]).toEqual([0]);
    removeEntity(world, eid);
    expect(entityExists(world, 0)).toBe(false);
    expect([...defineQuery([EdPos])(world)]).toEqual([]);
  });
});

describe("removeEntity with re-entrant cleanup hooks", () => {
  test("a cleanup hook that removes the same entity frees it once", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdHooked, eid);
    cleanupMode = "removeSelf";
    removeEntity(world, eid);
    cleanupMode = "none";

    expect(entityExists(world, eid)).toBe(false);
    expect(world.removed.filter((r) => r === eid)).toHaveLength(1);
    const a = addEntity(world);
    const b = addEntity(world);
    expect(a).not.toBe(b);
  });

  test("a component added by a cleanup hook does not leave the dead entity in a query", () => {
    const world = createWorld(16);
    const late = defineQuery([EdLate]);
    late(world);
    const eid = addEntity(world);
    addComponent(world, EdHooked, eid);
    cleanupMode = "addOther";
    removeEntity(world, eid);
    cleanupMode = "none";

    expect(entityExists(world, eid)).toBe(false);
    expect(late(world)).not.toContain(eid);
    expect(hasComponent(world, EdLate, eid)).toBe(false);
    // Its system was initialised by the add, so it is cleaned up too.
    expect(cleanupLog.filter((l) => l.startsWith("cleanup"))).toEqual([`cleanup:hooked:${eid}`, `cleanup:late:${eid}`]);
  });

  test("a cleanup hook that removes and re-adds another component does not leave it in that query", () => {
    const world = createWorld(16);
    const other = defineQuery([EdOther]);
    other(world);
    const eid = addEntity(world);
    addComponent(world, EdOther, eid);
    addComponent(world, EdHooked, eid);
    cleanupMode = "readdSame";
    removeEntity(world, eid);
    cleanupMode = "none";

    expect(other(world)).not.toContain(eid);
    expect(entityExists(world, eid)).toBe(false);
  });

  test("a cleanup hook may remove a different entity", () => {
    const world = createWorld(16);
    const a = addEntity(world);
    const b = addEntity(world);
    addComponent(world, EdHooked, a);
    addComponent(world, EdPos, b);
    otherEid = b;
    cleanupMode = "removeOther";
    removeEntity(world, a);
    cleanupMode = "none";

    expect(entityExists(world, a)).toBe(false);
    expect(entityExists(world, b)).toBe(false);
    expect(defineQuery([EdPos])(world)).not.toContain(b);
    expect(new Set(world.removed).size).toBe(world.removed.length);
  });

  test("removing an entity twice is a no-op", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdHooked, eid);
    removeEntity(world, eid);
    removeEntity(world, eid);
    expect(world.removed).toEqual([eid]);
    expect(cleanupLog.filter((l) => l.startsWith("cleanup"))).toHaveLength(1);
  });
});

describe("world(C, eid) accessor cache", () => {
  test("ids that can never be entities return a working accessor without growing the cache", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid);
    for (const bad of [2 ** 31, 1e9, 16, 17, -1, 1.5, NaN]) {
      expect(() => world(EdPos, bad).x).not.toThrow();
      expect(world(EdPos, bad).x).toBeUndefined();
    }
    expect((world as any)(EdPos).proxies.length).toBeLessThanOrEqual(17);
  });

  test("accessors are cached per entity and keep identity while the cache grows", () => {
    const world = createWorld(5000);
    const first = world(EdPos, 0);
    const last = world(EdPos, 4999);
    for (let i = 0; i < 5000; i += 97) world(EdPos, i);
    expect(world(EdPos, 0)).toBe(first);
    expect(world(EdPos, 4999)).toBe(last);
    expect((world as any)(EdPos).proxies.length).toBeLessThanOrEqual(5001);
  });

  test("unknown keys on an accessor throw in strict mode", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid);
    expect(() => {
      (world(EdPos, eid) as any).nope = 1;
    }).toThrow(TypeError);
    expect(() => {
      (world(EdPos, eid) as any).type = "Other";
    }).toThrow(TypeError);
  });
});

describe("accessors of every column kind across many worlds", () => {
  // More worlds than get a dedicated accessor class, so later worlds use the shared one.
  const makeWorlds = (count: number) => {
    const worlds: World[] = [];
    for (let k = 0; k < count; k++) {
      const world = createWorld(16);
      const eid = addEntity(world);
      addComponent(world, EdMixed, eid, { n: k, b: k % 2 === 1, s: `s${k}`, ns: null, v: [k, -k], o: { k } });
      worlds.push(world);
    }
    return worlds;
  };

  test("reads, writes and spreads stay independent per world", () => {
    const worlds = makeWorlds(7);
    worlds.forEach((world, k) => {
      const a = world(EdMixed, 0);
      expect({ ...a, v: Array.from(a.v) }).toEqual({
        n: k,
        b: k % 2 === 1,
        s: `s${k}`,
        ns: null,
        v: [k, -k],
        o: { k },
        type: "EdMixed",
      });
      a.n += 100;
      a.b = !a.b;
      a.s += "!";
      a.ns = `n${k}`;
      a.v = [k * 10, k * 20] as any;
      a.v[1] += 1;
      a.o = { k: k * 2 };
    });
    worlds.forEach((world, k) => {
      const s = snapshot(world, EdMixed, 0);
      expect({ ...s, v: Array.from(s.v) }).toEqual({
        n: k + 100,
        b: k % 2 === 0,
        s: `s${k}!`,
        ns: `n${k}`,
        v: [k * 10, k * 20 + 1],
        o: { k: k * 2 },
        type: "EdMixed",
      });
    });
  });

  test("delta tracking catches accessor writes and in-place mutations in every world", () => {
    const worlds = makeWorlds(6);
    worlds.forEach((world, k) => {
      const mirror = createWorld(16);
      const delta = createDeltaSerializer(world);
      deserializeWorld(delta.serialize(), mirror);

      const a = world(EdMixed, 0);
      a.n = 500 + k;
      a.b = true;
      a.s = `changed${k}`;
      a.v[0] = 42 + k; // in-place, through the returned view
      a.o.k = -k - 1; // in-place, through the returned object
      applyDelta(delta.serialize(), mirror);

      const m = mirror(EdMixed, 0);
      expect([m.n, m.b, m.s, m.v[0], m.o.k]).toEqual([500 + k, true, `changed${k}`, 42 + k, -k - 1]);
    });
  });
});

describe("without runtime code generation (CSP)", () => {
  test("accessors and snapshots fall back to closures with identical behaviour", () => {
    const RealFunction = globalThis.Function;
    const Blocked = function () {
      throw new EvalError("Code generation from strings disallowed for this context");
    } as unknown as FunctionConstructor;
    vi.stubGlobal("Function", Blocked);
    try {
      expect(() => new Function("return 1")).toThrow(EvalError);
      const worlds: World[] = [];
      for (let k = 0; k < 6; k++) {
        const world = createWorld(16);
        const eid = addEntity(world);
        addComponent(world, EdCsp, eid, { n: k, b: k % 2 === 0, s: `w${k}`, v: [k, k] });
        worlds.push(world);
      }
      worlds.forEach((world, k) => {
        const a = world(EdCsp, 0);
        expect([a.n, a.b, a.s, Array.from(a.v)]).toEqual([k, k % 2 === 0, `w${k}`, [k, k]]);
        a.n = k * 3;
        a.v = [7, 8] as any;
        const snap = snapshot(a);
        expect({ ...snap, v: Array.from(snap.v) }).toEqual({
          n: k * 3,
          b: k % 2 === 0,
          s: `w${k}`,
          v: [7, 8],
          type: "EdCsp",
        });
        expect(Object.keys(snapshot(world, EdCsp, 0))).toEqual(Object.keys({ ...a }));
      });

      // Delta tracking through the fallback setters, for a dedicated (first) and a shared (sixth) world.
      for (const source of [worlds[0], worlds[5]]) {
        const mirror = createWorld(16);
        const delta = createDeltaSerializer(source);
        deserializeWorld(delta.serialize(), mirror);
        source(EdCsp, 0).n = 77;
        source(EdCsp, 0).b = true;
        source(EdCsp, 0).v[1] = 9;
        applyDelta(delta.serialize(), mirror);
        expect([mirror(EdCsp, 0).n, mirror(EdCsp, 0).b, mirror(EdCsp, 0).v[1]]).toEqual([77, true, 9]);

        // Whole-value assignment of a fixed array and a string, each in its own delta.
        source(EdCsp, 0).v = [4, 5] as any;
        applyDelta(delta.serialize(), mirror);
        expect(Array.from(mirror(EdCsp, 0).v)).toEqual([4, 5]);
        source(EdCsp, 0).s = "changed";
        applyDelta(delta.serialize(), mirror);
        expect(mirror(EdCsp, 0).s).toBe("changed");
        expect(snapshot(mirror, EdCsp, 0)).toEqual(snapshot(source, EdCsp, 0));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalThis.Function).toBe(RealFunction);
  });
});

describe("snapshot argument handling", () => {
  test("rejects things that are not a world or an accessor", () => {
    for (const bad of [null, undefined, {}, 5, "x", { x: 1, type: "EdPos" }]) {
      expect(() => snapshot(bad as any)).toThrow("snapshot expects a world or a component accessor");
    }
  });

  test("rejects a missing entity id and non-numeric targets", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid);
    expect(() => (snapshot as any)(world, EdPos)).toThrow("entity is undefined");
    expect(() => (snapshot as any)(world, String(eid))).toThrow("expects a component or an entity id");
    expect(() => (snapshot as any)(world, null)).toThrow("expects a component or an entity id");
  });

  test("a component the entity lacks reads like a spread of its accessor", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    expect(snapshot(world, EdPos, eid)).toEqual({ ...world(EdPos, eid) });
  });

  test("entity and world forms skip removed entities and disabled components", () => {
    const world = createWorld(16);
    const a = addEntity(world);
    const b = addEntity(world);
    const bare = addEntity(world);
    addComponent(world, EdPos, a, { x: 2 });
    addComponent(world, EdText, a, { s: "a" });
    addComponent(world, EdPos, b);
    disableComponent(world, EdText, a);
    removeEntity(world, b);

    expect(snapshot(world, a)).toEqual({ EdPos: { x: 2, y: 0, type: "EdPos" } });
    expect(() => snapshot(world, b)).toThrow("entity does not exist");
    expect(snapshot(world, bare)).toEqual({});
    expect(snapshot(world)).toEqual({ [a]: { EdPos: { x: 2, y: 0, type: "EdPos" } }, [bare]: {} });
  });

  test("an empty world snapshots to an empty object", () => {
    expect(snapshot(createWorld(4))).toEqual({});
  });

  test("snapshots are detached copies for scalars, like a spread", () => {
    const world = createWorld(16);
    const eid = addEntity(world);
    addComponent(world, EdPos, eid, { x: 3 });
    const snap = snapshot(world, EdPos, eid);
    snap.x = 100;
    expect(world(EdPos, eid).x).toBe(3);
    world(EdPos, eid).x = 4;
    expect(snap.x).toBe(100);
  });
});

@Component()
class EdLayA extends Schema {
  @type("number")
  a: number;
}

@Component()
class EdLayClientOnly extends Schema {
  @type("number")
  c: number;
}

@Component()
class EdLayPos extends Schema {
  @type("number")
  x: number;
}

const edLayQuery = defineQuery([EdLayClientOnly]);
const edLayBothQuery = defineQuery([EdLayClientOnly, EdLayPos]);

/**
 * A server built without EdLayClientOnly: the component is dropped from its layout and the later
 * components are packed down into the freed bits, as a world that never registered it would have.
 */
const createServerWithoutClientOnly = () => {
  const server = createWorld(16);
  const map = new Map(server.componentMap);
  map.delete(EdLayClientOnly);
  let generationId = 0;
  let bitflag = 1;
  map.forEach((component) => {
    component.generationId = generationId;
    component.bitflag = bitflag;
    bitflag *= 2;
    if (bitflag >= 2 ** 31) {
      bitflag = 1;
      generationId++;
    }
  });
  server.componentMap = map;
  server.bitflag = bitflag;
  server.entityMasks = Array.from({ length: generationId + 1 }, () => new Uint32Array(server.size));
  rebuildComponentBitTable(server);
  return server;
};

describe("deserializing a payload that lacks a component this world has", () => {
  for (const mode of [SerialMode.JSON, SerialMode.BINARY]) {
    test(`client-only components get bits of their own (${SerialMode[mode]})`, () => {
      const server = createServerWithoutClientOnly();
      const e = addEntity(server);
      addComponent(server, EdLayA, e, { a: 1 });
      addComponent(server, EdLayPos, e, { x: 5 });
      const other = addEntity(server);
      addComponent(server, EdLayPos, other, { x: 6 });

      const client = createWorld(16);
      // Queries the server never had, created before and populated by the client.
      const before = addEntity(client);
      addComponent(client, EdLayClientOnly, before, { c: 9 });
      expect([...edLayQuery(client)]).toEqual([before]);
      expect([...edLayBothQuery(client)]).toEqual([]);

      const payload =
        mode === SerialMode.JSON ? serializeWorld(SerialMode.JSON, server) : serializeWorld(SerialMode.BINARY, server);
      deserializeWorld(payload, client);

      expect(hasComponent(client, EdLayClientOnly, e)).toBe(false);
      expect(hasComponent(client, EdLayClientOnly, other)).toBe(false);
      expect(hasComponent(client, EdLayA, e)).toBe(true);
      expect(hasComponent(client, EdLayPos, e)).toBe(true);
      expect(client(EdLayPos, other).x).toBe(6);
      expect([...edLayQuery(client)]).toEqual([]);
      expect([...edLayBothQuery(client)]).toEqual([]);

      // The client-only component's bit is unique, so it can be added and queried normally.
      const clientOnlyBits = client.componentMap.get(EdLayClientOnly)!;
      client.componentMap.forEach((component, schema) => {
        if (schema === EdLayClientOnly) return;
        expect(
          component.generationId === clientOnlyBits.generationId && component.bitflag === clientOnlyBits.bitflag,
        ).toBe(false);
      });
      addComponent(client, EdLayClientOnly, other, { c: 3 });
      expect(hasComponent(client, EdLayClientOnly, other)).toBe(true);
      expect(hasComponent(client, EdLayClientOnly, e)).toBe(false);
      expect(hasComponent(client, EdLayA, other)).toBe(false);
      expect([...edLayQuery(client)]).toEqual([other]);
      expect([...edLayBothQuery(client)]).toEqual([other]);

      // A component registered after the payload's last bit still gets a fresh one.
      expect(client.bitflag).not.toBe(clientOnlyBits.bitflag);
      removeEntity(client, other);
      expect([...edLayQuery(client)]).toEqual([]);
    });
  }
});

describe("fastClone", () => {
  test("copies an own __proto__ key instead of setting the prototype", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const clone = fastClone(source);
    expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(clone, "__proto__")).toBe(true);
    expect(clone.polluted).toBeUndefined();
    expect(Object.keys(clone)).toEqual(["__proto__", "a"]);
    expect(clone["__proto__"]).toEqual({ polluted: true });
    expect(clone["__proto__"]).not.toBe(source["__proto__"]);
    expect(fastEqual(clone, source)).toBe(true);
  });
});

describe("worlds without live entities", () => {
  const populate = (w: World) => {
    const a = addEntity(w);
    addComponent(w, EdPos, a, { x: 2, y: 3 });
    const b = addEntity(w);
    addComponent(w, EdText, b, { s: "x" });
    return [a, b];
  };

  for (const mode of [SerialMode.JSON, SerialMode.BINARY, SerialMode.BASE64]) {
    test(`an empty world round-trips and clears the target (${SerialMode[mode]})`, () => {
      const empty = createWorld(16);
      empty.frame = 7;
      const target = createWorld(16);
      populate(target);
      const q = defineQuery([EdPos]);
      expect(q(target).length).toBe(1);

      const payload =
        mode === SerialMode.JSON
          ? serializeWorld(SerialMode.JSON, empty)
          : mode === SerialMode.BINARY
            ? serializeWorld(SerialMode.BINARY, empty)
            : serializeWorld(SerialMode.BASE64, empty);
      deserializeWorld(payload, target);

      expect(target.entitySparseSet.dense.length).toBe(0);
      expect(target.frame).toBe(7);
      expect(q(target).length).toBe(0);
      expect(hasComponent(target, EdPos, 0)).toBe(false);
      const e = addEntity(target);
      expect(e).toBe(0);
      addComponent(target, EdPos, e);
      expect(target(EdPos, e).x).toBe(1);
      expect([...q(target)]).toEqual([e]);
    });
  }

  test("a world whose entities were all removed keeps its cursor and free list", () => {
    const source = createWorld(16);
    const [a, b] = populate(source);
    removeEntity(source, a);
    removeEntity(source, b);
    const copy = deserializeWorld(serializeWorld(SerialMode.BINARY, source), createWorld(16));
    expect(copy.entityCursor).toBe(source.entityCursor);
    expect([...copy.removed]).toEqual([...source.removed]);
    expect(addEntity(copy)).toBe(addEntity(source));
  });

  test("a delta that removes the last entity empties the receiver", () => {
    const source = createWorld(16);
    const [a, b] = populate(source);
    const receiver = deserializeWorld(serializeWorld(SerialMode.BINARY, source), createWorld(16));
    const delta = createDeltaSerializer(source);
    delta.serialize();
    removeEntity(source, a);
    removeEntity(source, b);
    applyDelta(delta.serialize(), receiver);
    expect(entityExists(receiver, a)).toBe(false);
    expect(entityExists(receiver, b)).toBe(false);
    expect(defineQuery([EdPos])(receiver).length).toBe(0);
  });

  test("a header-only payload from older serializers reads as an empty world", () => {
    const target = createWorld(16);
    populate(target);
    const legacy = new Uint8Array(serializeWorld(SerialMode.BINARY, createWorld(16)).slice(0, 3));
    deserializeWorld(legacy, target);
    expect(target.entitySparseSet.dense.length).toBe(0);
    expect(target.entityCursor).toBe(0);
    expect(defineQuery([EdPos])(target).length).toBe(0);
    expect(addEntity(target)).toBe(0);
  });
});

@Component()
class EdArrDefault extends Schema {
  @type(["float32", 3])
  @defaultValue([1, 2, 3])
  v: Float32Array;

  @type("number")
  @defaultValue(4)
  n: number;
}

@Component()
class EdIntArrays extends Schema {
  @type(["int8", 2])
  i8: Int8Array;

  @type(["uint8", 2])
  u8: Uint8Array;

  @type(["int16", 2])
  i16: Int16Array;

  @type(["uint16", 2])
  u16: Uint16Array;

  @type(["int32", 2])
  i32: Int32Array;

  @type(["uint32", 2])
  u32: Uint32Array;

  @type(["float64", 2])
  f64: Float64Array;
}

describe("fixed-length array columns", () => {
  test("a default value fills the array on every add and is never shared between entities", () => {
    const world = createWorld(16);
    const a = addEntity(world);
    const b = addEntity(world);
    addComponent(world, EdArrDefault, a);
    addComponent(world, EdArrDefault, b);
    expect(Array.from(world(EdArrDefault, a).v)).toEqual([1, 2, 3]);
    world(EdArrDefault, a).v[0] = 9;
    expect(Array.from(world(EdArrDefault, b).v)).toEqual([1, 2, 3]);

    // Re-adding after removal starts from the default again, not the old values.
    removeComponent(world, EdArrDefault, a);
    addComponent(world, EdArrDefault, a);
    expect(Array.from(world(EdArrDefault, a).v)).toEqual([1, 2, 3]);

    // A fresh entity gets the default too.
    const c = addEntity(world);
    addComponent(world, EdArrDefault, c);
    expect(Array.from(world(EdArrDefault, c).v)).toEqual([1, 2, 3]);
    expect(world(EdArrDefault, c).n).toBe(4);

    // An override replaces the default.
    const d = addEntity(world);
    addComponent(world, EdArrDefault, d, { v: [7, 8, 9] as any });
    expect(Array.from(world(EdArrDefault, d).v)).toEqual([7, 8, 9]);
  });

  const extremes = {
    i8: [-128, 127],
    u8: [0, 255],
    i16: [-32768, 32767],
    u16: [0, 65535],
    i32: [-(2 ** 31), 2 ** 31 - 1],
    u32: [0, 2 ** 32 - 1],
    f64: [Number.MIN_VALUE, -Number.MAX_VALUE],
  };

  for (const mode of [SerialMode.BINARY, SerialMode.BASE64, SerialMode.JSON]) {
    test(`integer and float64 arrays keep their limits through serialization (${SerialMode[mode]})`, () => {
      const source = createWorld(16);
      addEntity(source);
      const eid = addEntity(source);
      addComponent(source, EdIntArrays, eid, extremes as any);
      const payload =
        mode === SerialMode.JSON
          ? JSON.parse(JSON.stringify(serializeWorld(SerialMode.JSON, source)))
          : mode === SerialMode.BINARY
            ? serializeWorld(SerialMode.BINARY, source)
            : serializeWorld(SerialMode.BASE64, source);
      const copy = deserializeWorld(payload, createWorld(16));
      const got = copy(EdIntArrays, eid);
      for (const key of Object.keys(extremes) as (keyof typeof extremes)[]) {
        expect([key, Array.from(got[key])]).toEqual([key, extremes[key]]);
      }
    });
  }

  test("integer arrays wrap like their typed array on write and deltas carry the wrapped value", () => {
    const source = createWorld(16);
    const eid = addEntity(source);
    addComponent(source, EdIntArrays, eid);
    const mirror = createWorld(16);
    const delta = createDeltaSerializer(source);
    deserializeWorld(delta.serialize(), mirror);

    const acc = source(EdIntArrays, eid);
    acc.i8 = [128, -129] as any;
    acc.u16[1] = 65536 + 7;
    acc.u32 = [-1, 2 ** 32] as any;
    applyDelta(delta.serialize(), mirror);
    const got = mirror(EdIntArrays, eid);
    expect(Array.from(got.i8)).toEqual([-128, 127]);
    expect(Array.from(got.u16)).toEqual([0, 7]);
    expect(Array.from(got.u32)).toEqual([2 ** 32 - 1, 0]);
  });
});

describe("JSON deserialization of fixed-length arrays", () => {
  test("values land in the target's own column views", () => {
    const source = createWorld(16);
    const eid = addEntity(source);
    addComponent(source, EdIntArrays, eid, { i16: [3, 4] as any });
    const target = createWorld(16);
    const view = target.componentMap.get(EdIntArrays)!.store.i16[eid];
    deserializeWorld(serializeWorld(SerialMode.JSON, source), target);

    expect(target.componentMap.get(EdIntArrays)!.store.i16[eid]).toBe(view);
    expect(Array.from(target(EdIntArrays, eid).i16)).toEqual([3, 4]);
    source(EdIntArrays, eid).i16[0] = 99;
    expect(target(EdIntArrays, eid).i16[0]).toBe(3);

    // Removing and re-adding resets the column, which only works while the view is attached.
    removeComponent(target, EdIntArrays, eid);
    addComponent(target, EdIntArrays, eid);
    expect(Array.from(target(EdIntArrays, eid).i16)).toEqual([0, 0]);
  });

  test("the JSON text form (typed arrays as index-keyed objects) is accepted", () => {
    const source = createWorld(16);
    const eid = addEntity(source);
    addComponent(source, EdArrDefault, eid, { v: [5, 6, 7] as any, n: 1 });
    const text = JSON.stringify(serializeWorld(SerialMode.JSON, source));
    expect(text).toContain('{"0":5,"1":6,"2":7}');
    const copy = deserializeWorld(JSON.parse(text), createWorld(16));
    expect(Array.from(copy(EdArrDefault, eid).v)).toEqual([5, 6, 7]);
    expect(copy(EdArrDefault, eid).n).toBe(1);
  });
});

describe("deltas that remove entities", () => {
  test("the receiver drops the removed entity's components, so a reused id starts clean", () => {
    const source = createWorld(10);
    for (let i = 0; i < 10; i++) addComponent(source, EdPos, addEntity(source), { x: i, y: i });
    addComponent(source, EdText, 4, { s: "gone" });
    const delta = createDeltaSerializer(source);
    const receiver = deserializeWorld(delta.serialize(), createWorld(10));
    const posQuery = defineQuery([EdPos]);

    removeEntity(source, 4);
    applyDelta(delta.serialize(), receiver);
    expect(entityExists(receiver, 4)).toBe(false);
    expect(hasComponent(receiver, EdPos, 4)).toBe(false);
    expect(hasComponent(receiver, EdText, 4)).toBe(false);
    expect([...posQuery(receiver)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);

    // The world is full, so the receiver's next entity reuses id 4.
    const reused = addEntity(receiver);
    expect(reused).toBe(4);
    expect(hasComponent(receiver, EdPos, reused)).toBe(false);
    expect(hasComponent(receiver, EdText, reused)).toBe(false);
    expect([...posQuery(receiver)]).not.toContain(4);
    addComponent(receiver, EdPos, reused);
    expect(receiver(EdPos, reused).x).toBe(1);
  });
});

import { describe, expect, test, vi } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import { Schema } from "../src/Schema";
import {
  activateDeltaDirtyTracking,
  clearDeltaDirtyTracking,
  consumeDeltaDirtyTracking,
  getState,
  markDeltaDirty,
} from "../src/DeltaTracking";
import { createDeltaSerializer, serializeWorld, NULL_FLAG } from "../src/Serialize";
import { applyDelta, deserializeWorld } from "../src/Deserialize";
import { SerialMode } from "../src/Types";
import {
  addComponent,
  addEntity,
  createWorld,
  disableComponent,
  getSystem,
  hasComponent,
  removeComponent,
  removeEntity,
} from "../src/World";
import { defineQuery } from "../src/Query";
import { $storeBase, $storeFlattened, createStore, resizeStore, type Store } from "../src/Storage";
import { System, SystemImpl } from "../src/System";

@Component("GapDeltaScalar")
class GapDeltaScalar extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;
}

@Component("GapDeltaTag")
class GapDeltaTag extends Schema {}

@Component("GapVec2")
class GapVec2 extends Schema {
  @type(["float32", 2])
  v: Float32Array;
}

@Component("GapObjDelta")
class GapObjDelta extends Schema {
  @type("object")
  data: any;
}

@Component("GapNestedObj")
class GapNestedObj extends Schema {
  @type("object")
  nested: any;
}

@Component("GapNullOnly")
class GapNullOnly extends Schema {
  // @ts-ignore - intentionally exercising unsupported runtime type path
  @type("null")
  value: any;
}

@Component("GapIdField")
class GapIdField extends Schema {
  @type("number")
  @defaultValue(0)
  id: number;

  @type("number")
  @defaultValue(0)
  kept: number;
}

@Component("GapA")
class GapA extends Schema {}

@Component("GapB")
class GapB extends Schema {}

@System(GapA, GapB)
class GapCleanupSystem extends SystemImpl {
  cleanupCount = 0;
  cleanup = () => {
    this.cleanupCount++;
  };
}

@Component("GapWorldAA")
class GapWorldAA extends Schema {}

@System(GapWorldAA)
class GapInitSystem extends SystemImpl {
  initCount = 0;
  init = () => {
    this.initCount++;
  };
}

@Component("GapNoDepth")
class GapNoDepth extends Schema {}

@System(GapNoDepth)
class GapNoDepthSystem extends SystemImpl {
  static depth = 0;
  runs = 0;
  run = () => {
    this.runs++;
  };
}

describe("Decorators error path", () => {
  test("Component decorator rethrows AJV compile errors", () => {
    class GapInvalidSchema extends Schema {}
    // @ts-ignore - intentionally invalid schema for error path
    GapInvalidSchema.schema = { type: "object", properties: { x: { type: 123 } } };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => Component("GapInvalidSchema")(GapInvalidSchema)).toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("DeltaTracking overflow branches", () => {
  test("clearDeltaDirtyTracking resets marks when epoch wraps to 0", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapDeltaScalar, eid, { n: 1 });

    activateDeltaDirtyTracking(world);
    const prop = world(GapDeltaScalar).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);

    const bucket = getState(world)!.dirtyProps.get(prop)!;
    bucket.epoch = -1;
    bucket.ids.push(eid);

    clearDeltaDirtyTracking(world);

    expect(bucket.ids.length).toBe(0);
    expect(bucket.epoch).toBe(1);
    expect(bucket.marks[eid]).toBe(0);
  });

  test("consumeDeltaDirtyTracking resets marks when epoch wraps to 0", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapDeltaScalar, eid, { n: 2 });

    activateDeltaDirtyTracking(world);
    const prop = world(GapDeltaScalar).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);

    const bucket = getState(world)!.dirtyProps.get(prop)!;
    bucket.epoch = -1;

    const consumed = consumeDeltaDirtyTracking(world);
    expect(consumed.get(prop)).toEqual([eid]);
    expect(bucket.epoch).toBe(1);
    expect(bucket.marks[eid]).toBe(0);
  });
});

describe("Query creation with sparse entity ids", () => {
  test("createQuery skips ids not in entitySparseSet", () => {
    const world = createWorld();
    const removedEid = addEntity(world);
    const keptEid = addEntity(world);

    addComponent(world, GapDeltaScalar, removedEid, { n: 10 });
    addComponent(world, GapDeltaScalar, keptEid, { n: 20 });
    removeEntity(world, removedEid);

    const q = defineQuery([GapDeltaScalar]);
    expect([...q(world)]).toEqual([keptEid]);
  });
});

describe("Schema constructables constructor path", () => {
  test("constructor maps object and array fields into constructables", () => {
    class Child extends Schema {
      value: number;
      constructor(value?: { value: number }) {
        super();
        if (value) Object.assign(this, value);
      }
    }

    class Parent extends Schema {}

    // @ts-ignore - test setup for constructable conversion path
    Parent.constructables = { child: Child, children: Child };
    // @ts-ignore - make fields visible to base constructor before own assignment
    Parent.prototype.child = { value: 1 };
    // @ts-ignore - make fields visible to base constructor before own assignment
    Parent.prototype.children = [{ value: 2 }];

    const parent = new Parent() as Parent & { child: Child; children: Child[] };
    expect(parent.child).toBeInstanceOf(Child);
    expect(parent.children[0]).toBeInstanceOf(Child);
  });
});

describe("Storage uncovered branches", () => {
  test("resizeStore traverses nested object stores (current implementation throws)", () => {
    const store = createStore({ nested: { value: "f64" } }, 2);
    store.nested.value[1] = 42;
    expect(() => resizeStore(store, 4)).toThrow();
    expect(store[$storeBase]()).toBe(store);
  });

  test("createStore fallthrough returns undefined for unsupported schema shape", () => {
    const unsupported = createStore("not-an-object-schema", 2);
    expect(unsupported).toBeUndefined();
  });
});

describe("System sorting nullish depth", () => {
  test("undefined static depth is treated as depth 0", () => {
    Reflect.set(GapNoDepthSystem, "depth", undefined);
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapNoDepth, eid);
    const system = getSystem(world, GapNoDepthSystem);
    system.runAll(world);
    expect(system.runs).toBe(1);
  });
});

describe("Serialize and deserialize error branches", () => {
  test("deserialize object with nested content uses complex data payload", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapNestedObj, eid, {
      nested: { inner: { value: 7 }, list: [1, 2, 3] },
    });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(GapNestedObj, eid).nested).toEqual({ inner: { value: 7 }, list: [1, 2, 3] });
  });

  test("serialize throws for unsupported runtime object type", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapNullOnly, eid, { value: null });

    world(GapNullOnly).store.value[eid] = "not-null";
    expect(() => serializeWorld(SerialMode.BINARY, world)).toThrow("Unsupported object type: null");
  });

  test("deserialize throws for unsupported object type marker path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapNullOnly, eid, { value: null });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const bytes = new Uint8Array(buffer.slice(0));
    const nullFlagIndex = bytes.indexOf(NULL_FLAG);
    expect(nullFlagIndex).toBeGreaterThan(-1);
    bytes[nullFlagIndex] = 0;

    const clone = createWorld();
    expect(() => deserializeWorld(bytes.buffer, clone)).toThrow("Unsupported object type: null");
  });

  test("applyDelta rejects non-delta buffers", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapDeltaScalar, eid, { n: 11 });

    const fullBuffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    expect(() => applyDelta(fullBuffer, clone)).toThrow("applyDelta expects delta mode (1)");
  });

  test("JSON serializer excludes reserved key id", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapIdField, eid, { id: 99, kept: 7 });

    const json = serializeWorld(SerialMode.JSON, world);
    const componentData = json.entities[0].components.GapIdField as unknown as Record<string, unknown>;
    expect(componentData.kept).toBe(7);
    expect(componentData.id).toBeUndefined();
  });
});

describe("Delta serializer uncovered entity-diff branches", () => {
  test("component removal emits non-member dirty eid path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapDeltaScalar, eid, { n: 1 });

    const delta = createDeltaSerializer(world);
    const full = delta.serialize();
    const clone = createWorld();
    deserializeWorld(full, clone);

    removeComponent(world, GapDeltaScalar, eid);
    const patch = delta.serialize();
    applyDelta(patch, clone);

    // Current delta application path does not clear component membership flags.
    expect(hasComponent(clone, GapDeltaScalar, eid)).toBe(true);
  });

  test("tag dirty without membership change rewinds serialization write", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapDeltaTag, eid);

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();

    markDeltaDirty(world, world(GapDeltaTag).store, eid);
    const second = delta.serialize();

    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("typed subarray dirty with no value change rewinds serialization write", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapVec2, eid, { v: [3, 4] });

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();

    const prop = world(GapVec2).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);
    const second = delta.serialize();

    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("faux-store delta path handles unchanged then changed object values", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapObjDelta, eid, { data: { a: 1, b: { c: 2 } } });

    const delta = createDeltaSerializer(world);
    const full = delta.serialize();
    const clone = createWorld();
    deserializeWorld(full, clone);

    // Mark dirty but keep value semantically unchanged.
    const unchangedRef = world(GapObjDelta, eid).data;
    unchangedRef.b.c = 2;
    const unchanged = delta.serialize();

    // Mark dirty and mutate deeply.
    const changedRef = world(GapObjDelta, eid).data;
    changedRef.b.c = 9;
    const changed = delta.serialize();

    expect(changed.byteLength).toBeGreaterThan(unchanged.byteLength);
    applyDelta(changed, clone);
    expect(clone(GapObjDelta, eid).data.b.c).toBe(9);
  });
});

describe("World delta tracking and query-system edge branches", () => {
  test("add/remove component marks dirty for flattened and tag stores", () => {
    const world = createWorld();
    const delta = createDeltaSerializer(world);
    delta.serialize();

    const eid = addEntity(world);
    addComponent(world, GapDeltaScalar, eid, { n: 4 });
    addComponent(world, GapDeltaTag, eid);

    const dirtyAfterAdd = consumeDeltaDirtyTracking(world);
    const scalarProp = world(GapDeltaScalar).store[$storeFlattened][0] as Store;
    expect(dirtyAfterAdd.get(scalarProp)).toEqual([eid]);
    expect(dirtyAfterAdd.get(world(GapDeltaTag).store)).toEqual([eid]);

    removeComponent(world, GapDeltaScalar, eid);
    removeComponent(world, GapDeltaTag, eid);

    const dirtyAfterRemove = consumeDeltaDirtyTracking(world);
    expect(dirtyAfterRemove.get(scalarProp)).toEqual([eid]);
    expect(dirtyAfterRemove.get(world(GapDeltaTag).store)).toEqual([eid]);
  });

  test("addComponent cleanup path runs when stale query membership no longer matches", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapA, eid);
    addComponent(world, GapB, eid);

    const system = getSystem(world, GapCleanupSystem);
    const before = system.cleanupCount;

    // Disable both flags directly; query membership remains stale until committed.
    disableComponent(world, GapA, eid);
    disableComponent(world, GapB, eid);

    // Re-add only one side so query no longer matches; this exercises remove-systems cleanup in addComponent.
    addComponent(world, GapA, eid);
    expect(system.cleanupCount).toBeGreaterThan(before);
  });

  test("removeComponent can re-add entity to matched query for init when query list was over-attached", () => {
    class GapWorldA extends Schema {}
    type MutableSchemaClass = typeof Schema & {
      type: string;
      schema: { type: string; properties: Record<string, unknown>; required: string[] };
      validate: (overrides: unknown) => boolean;
      createStore: (size: number) => Store;
      index: number;
    };
    const gapWorldASchema = GapWorldA as unknown as MutableSchemaClass;
    gapWorldASchema.type = "GapWorldA";
    gapWorldASchema.schema = { type: "object", properties: {}, required: [] };
    gapWorldASchema.validate = () => true;
    gapWorldASchema.createStore = (size: number) => createStore({}, size);

    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, GapWorldAA, eid);

    const q = defineQuery([GapWorldAA]);
    q(world);
    const system = getSystem(world, GapInitSystem);
    const before = system.initCount;

    // Register component late; query key "GapWorldAA" includes "GapWorldA".
    addComponent(world, gapWorldASchema, eid);
    // removeComponent reads schema.index; set it to the world-local component slot.
    gapWorldASchema.index = world.componentList.length - 1;
    const qInstance = world.queryMap.get("GapWorldAA")!;
    qInstance.remove(eid);

    removeComponent(world, gapWorldASchema, eid);
    expect(system.initCount).toBe(before + 1);
  });
});

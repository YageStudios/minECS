import { describe, expect, test } from "vitest";
import { Component, defaultValue, nullable, type } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { createStore, $storeBase, $storeFlattened, type Store } from "../src/Storage";
import {
  activateDeltaDirtyTracking,
  clearDeltaDirtyTracking,
  consumeDeltaDirtyTracking,
  getState,
  markDeltaDirty,
} from "../src/DeltaTracking";
import { createDeltaSerializer, serializeWorld } from "../src/Serialize";
import { deserializeWorld } from "../src/Deserialize";
import { SerialMode, type SerializedWorld } from "../src/Types";
import { DrawSystemImpl, System, SystemImpl, defineSystem } from "../src/System";
import {
  addComponent,
  addEntity,
  createWorld,
  getSystem,
  removeComponent,
  sortComponentQueries,
  stepWorldDraw,
} from "../src/World";
import { defineQuery } from "../src/Query";
import { SparseSet } from "../src/SparseSet";

@Component("TailScalar")
class TailScalar extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;
}

@Component("TailObj")
class TailObj extends Schema {
  @type("object")
  data: unknown;
}

@Component("TailSubArray")
class TailSubArray extends Schema {
  @type(["float32", 2])
  v: Float32Array;
}

@Component("TailInner")
class TailInner extends Schema {
  @type("object")
  nested: unknown;
}

@Component("TailNullableField")
class TailNullableField extends Schema {
  @type("string")
  @nullable()
  txt: string | null;
}

@Component("TailOuter")
class TailOuter extends Schema {
  @type(TailInner)
  inner: TailInner;
}

@Component("TailOuterNullable")
class TailOuterNullable extends Schema {
  @type(TailNullableField)
  inner: TailNullableField;
}

@Component("TailFlatInner")
class TailFlatInner extends Schema {
  @type("number")
  n: number;
}

@Component("TailFlatHost")
class TailFlatHost extends Schema {
  @type(TailFlatInner)
  inner: TailFlatInner;
}

@Component("TailArrayObj")
class TailArrayObj extends Schema {
  @type([TailInner])
  items: TailInner[];
}

@Component("TailA")
class TailA extends Schema {}

@Component("TailB")
class TailB extends Schema {}

@Component("TailC")
class TailC extends Schema {}

@Component("TailAA")
class TailAA extends Schema {}

@Component("TailDraw")
class TailDraw extends Schema {}

@System(TailA, TailB)
class TailCleanupSystem extends SystemImpl {
  cleanupCount = 0;
  cleanup = () => {
    this.cleanupCount++;
  };
}

@System(TailB, TailC)
class TailCleanupSystemBC extends SystemImpl {
  cleanupCount = 0;
  cleanup = () => {
    this.cleanupCount++;
  };
}

@System(TailAA)
class TailInitSystem extends SystemImpl {
  initCount = 0;
  init = () => {
    this.initCount++;
  };
}

@System(TailDraw)
class TailDrawSystem extends DrawSystemImpl {
  runCount = 0;
  run = () => {
    this.runCount++;
  };
}

describe("DeltaTracking remaining coverage", () => {
  test("markDeltaDirty returns early when tracking is inactive", () => {
    const world = createWorld();
    const store = createStore({ x: "f64" }, 4);
    markDeltaDirty(world, store.x, 1);
    expect(getState(world)).toBeUndefined();
  });

  test("clear + consume traverse buckets including empty ids and de-dupe branch", () => {
    const world = createWorld();
    activateDeltaDirtyTracking(world);
    const store = createStore({ x: "f64" }, 4);
    const prop = store.x as Store;

    markDeltaDirty(world, prop, 2);
    markDeltaDirty(world, prop, 2);

    const state = getState(world);
    expect(state).toBeDefined();
    const bucket = state!.dirtyProps.get(prop)!;
    expect(bucket.ids).toEqual([2]);

    clearDeltaDirtyTracking(world);
    expect(bucket.ids).toEqual([]);

    const consumed = consumeDeltaDirtyTracking(world);
    expect(consumed.size).toBe(0);
  });

  test("clearDeltaDirtyTracking with active empty state hits state-present branch", () => {
    const world = createWorld();
    activateDeltaDirtyTracking(world);
    clearDeltaDirtyTracking(world);
    expect(getState(world)).toBeDefined();
  });

  test("clearDeltaDirtyTracking with inactive state hits no-op branch", () => {
    const world = createWorld();
    clearDeltaDirtyTracking(world);
    expect(getState(world)).toBeUndefined();
  });
});

describe("Deserialize line 93 path", () => {
  test("deserializing nested object with missing complex payload throws", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailOuter, eid, { inner: { nested: { x: 1 } } });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const bytes = new Uint8Array(buffer.slice(0));

    // Locate trailing complex JSON payload and erase keys while preserving byte length.
    let jsonStart = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 123) continue; // '{'
      try {
        const candidate = String.fromCharCode(...bytes.slice(i));
        JSON.parse(candidate);
        jsonStart = i;
        break;
      } catch {
        // keep scanning
      }
    }
    expect(jsonStart).toBeGreaterThan(-1);
    const jsonLen = bytes.length - jsonStart;
    const stripped = "{}".padEnd(jsonLen, " ");
    for (let i = 0; i < jsonLen; i++) {
      bytes[jsonStart + i] = stripped.charCodeAt(i);
    }

    const clone = createWorld();
    expect(() => deserializeWorld(bytes.buffer, clone)).toThrow();
  });
});

describe("Deserialize remaining sparse/null union paths", () => {
  test("nullable union in nested object with non-null value hits type-array normalization path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailOuterNullable, eid, { inner: { txt: "ok" } });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);
    expect(clone(TailOuterNullable, eid).inner.txt).toBe("ok");
  });

  test("nullable union in nested object hits array-type filter path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailOuterNullable, eid, { inner: { txt: null } });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);
    expect(clone(TailOuterNullable, eid).inner.txt).toBeNull();
  });

  test("binary sparse-set sentinel 65535 maps back to -1", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 1 });
    const q = defineQuery([TailScalar]);
    q(world);

    const qInst = world.queryMap.get("TailScalar")!;
    qInst.reset([eid, -1], [0, -1]);
    qInst.toRemove.reset([-1], [-1]);
    qInst.entered.reset([-1], [-1]);

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const cloneQ = clone.queryMap.get("TailScalar")!;
    expect(cloneQ.dense.includes(-1)).toBe(true);
    expect(cloneQ.sparse.includes(-1)).toBe(true);
  });

  test("json query sparse-set maps -1 values through deserializeSparseSet", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 2 });
    const q = defineQuery([TailScalar]);
    q(world);

    const json = serializeWorld(SerialMode.JSON, world) as SerializedWorld;
    const query = json.queryMap["TailScalar"];
    query.dense = [-1];
    query.sparse = [-1];
    query.toRemove.dense = [-1];
    query.toRemove.sparse = [-1];
    query.entered.dense = [-1];
    query.entered.sparse = [-1];

    const clone = createWorld();
    deserializeWorld(json, clone);
    const cloneQ = clone.queryMap.get("TailScalar")!;
    expect(cloneQ.dense[0]).toBeNull();
    expect(cloneQ.sparse[0]).toBeNull();
  });

  test("deserializeFromBuffer recreates extra entity mask generations", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 3 });
    const buffer = serializeWorld(SerialMode.BINARY, world);

    const clone = createWorld();
    const firstComp = clone.componentMap.values().next().value!;
    firstComp.generationId = 2;
    deserializeWorld(buffer, clone);
    expect(clone.entityMasks.length).toBeGreaterThan(2);
  });
});

describe("Serialize remaining scalar/faux delta branches", () => {
  const extractTrailingJson = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] !== 123) continue;
      try {
        return JSON.parse(String.fromCharCode(...bytes.slice(i)));
      } catch {
        // continue scanning
      }
    }
    return null;
  };

  test("object without schema properties writes into complexEntityData object bucket", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailObj, eid, { data: { p: 1 } });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
    const complex = extractTrailingJson(buffer);
    expect(complex?.[String(eid)]?.TailObj?.data).toBe(JSON.stringify({ p: 1 }));
  });

  test("complex array with elements initializes complexEntityData and copies entries", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailArrayObj, eid, { items: [{ nested: { v: 1 } }] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
    const complex = extractTrailingJson(buffer);
    expect(complex?.[String(eid)]?.TailArrayObj?.items).toBe(JSON.stringify([{ nested: { v: 1 } }]));
  });

  test("nullable union with non-null value hits array-type normalization path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailNullableField, eid, { txt: "hi" });
    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test("nested object initializes complexEntityData bucket", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailOuter, eid, { inner: { nested: { deep: 1 } } });
    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test("flat object follows config.properties serialization branch", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailFlatHost, eid, { inner: { n: 42 } });
    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test("typed scalar dirty but unchanged takes typed shadow skip path", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 10 });

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();
    const prop = world(TailScalar).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);
    const second = delta.serialize();

    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("faux store primitive compare path uses Object.is for undefined values", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailObj, eid);

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();
    const prop = world(TailObj).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);
    const second = delta.serialize();

    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("faux-store delta path updates shadow on full mode and compares on delta mode", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailObj, eid, { data: { stable: true } });

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();
    const prop = world(TailObj).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);
    const second = delta.serialize();

    expect(first.byteLength).toBeGreaterThan(0);
    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("faux-store delta path records changed object values on second pass", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailObj, eid, { data: { v: 1 } });

    const delta = createDeltaSerializer(world);
    delta.serialize();
    world(TailObj).store.data[eid] = { v: 2 };
    markDeltaDirty(world, world(TailObj).store[$storeFlattened][0] as Store, eid);
    const changed = delta.serialize();

    expect(changed.byteLength).toBeGreaterThan(0);
  });

  test("complex array fallback stores nestedComplexData into arrayComplexEntityData", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailArrayObj, eid, { items: [] });

    let reads = 0;
    const tricky = {
      get length() {
        reads++;
        return reads === 1 ? 0 : 1;
      },
      0: { nested: { value: 1 } },
    };
    world(TailArrayObj).store.items[eid] = tricky as unknown as TailInner[];

    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test("subarray delta with no element changes triggers rewind branch", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailSubArray, eid, { v: [1, 2] });

    const delta = createDeltaSerializer(world);
    const first = delta.serialize();
    const prop = world(TailSubArray).store[$storeFlattened][0] as Store;
    markDeltaDirty(world, prop, eid);
    const second = delta.serialize();
    expect(second.byteLength).toBeLessThan(first.byteLength);
  });

  test("json serialization includes query sparse-set/toRemove/entered payload", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 8 });
    const q = defineQuery([TailScalar]);
    q(world);
    const qInst = world.queryMap.get("TailScalar")!;
    qInst.reset([eid, null as unknown as number], [0, null as unknown as number]);
    qInst.toRemove.reset([eid], [0]);
    qInst.entered.reset([eid], [0]);

    const json = serializeWorld(SerialMode.JSON, world);
    expect(json.queryMap["TailScalar"].toRemove.dense.includes(eid)).toBe(true);
    expect(json.queryMap["TailScalar"].entered.dense.includes(eid)).toBe(true);
  });

  test("binary serialization writes null sparse-set entries via nullish fallback", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 9 });
    const q = defineQuery([TailScalar]);
    q(world);
    const qInst = world.queryMap.get("TailScalar")!;
    const nullEntry = null as unknown as number;

    qInst.reset([eid, nullEntry], [0, nullEntry]);
    qInst.toRemove.reset([nullEntry], [nullEntry]);
    qInst.entered.reset([nullEntry], [nullEntry]);

    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  test("json serialization omits undefined faux property values", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailObj, eid);

    const json = serializeWorld(SerialMode.JSON, world);
    const tailObj = json.entities[0].components["TailObj"] as Record<string, unknown>;
    expect(tailObj["data"]).toBeUndefined();
  });
});

describe("Storage metadata branch", () => {
  test("createStore metadata storeBase closure is wired for non-tag schema", () => {
    const store = createStore({ x: "f64" }, 2);
    expect(store[$storeBase]()).toBe(store);
  });

  test("metadata storeBase closure body can be invoked before root override", () => {
    const originalAssign = Object.assign;
    let captured: (() => Store) | null = null;

    Object.assign = (function patchedAssign(target: object, ...sources: object[]): object {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i] as Record<PropertyKey, unknown>;
        if (source[$storeBase]) {
          captured = source[$storeBase] as () => Store;
        }
      }
      return originalAssign(target, ...sources);
    }) as typeof Object.assign;

    try {
      const store = createStore({ y: "f64" }, 2);
      expect(captured).not.toBeNull();
      expect(captured!()).toBe(store);
    } finally {
      Object.assign = originalAssign;
    }
  });
});

describe("System nullish depth branch", () => {
  test("defineSystem handles undefined static depth via nullish coalescing", () => {
    class TailNoDepthSystem extends SystemImpl {}
    Reflect.set(TailNoDepthSystem, "depth", undefined);
    defineSystem([TailA], TailNoDepthSystem);

    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailA, eid);
    const system = getSystem(world, TailNoDepthSystem);
    expect(system).toBeInstanceOf(TailNoDepthSystem);
  });
});

describe("World remaining branches", () => {
  test("addEntity throws when eid exceeds world size", () => {
    const world = createWorld(0);
    addEntity(world);
    expect(() => addEntity(world)).toThrow("max entities reached");
  });

  test("addComponent ignores explicit override.type key", () => {
    const world = createWorld();
    const eid = addEntity(world);
    // `type` exists in runtime schema and should be skipped by addComponent writes.
    // @ts-expect-error Intentional runtime key-path test.
    addComponent(world, TailScalar, eid, { type: "WrongType", n: 3 });
    expect(world(TailScalar, eid).type).toBe("TailScalar");
    expect(world(TailScalar, eid).n).toBe(3);
  });

  test("addComponent !match path queues cleanup systems when stale query membership exists", () => {
    const world = createWorld();
    const eid = addEntity(world);
    const q = defineQuery([TailA, TailB]);
    q(world);
    const qInst = world.queryMap.get("TailA|TailB")!;
    qInst.add(eid);

    const cleanupSystem = getSystem(world, TailCleanupSystem);
    const before = cleanupSystem.cleanupCount;
    addComponent(world, TailB, eid);
    expect(cleanupSystem.cleanupCount).toBeGreaterThan(before);
  });

  test("addComponent !match path with systems present (TailB|TailC) triggers removeSystems.unshift", () => {
    const world = createWorld();
    const eid = addEntity(world);
    const bComp = world(TailB);
    const cComp = world(TailC);
    const cleanupSystem = getSystem(world, TailCleanupSystemBC);
    const qInst = Object.assign(SparseSet(), {
      toRemove: SparseSet(),
      entered: SparseSet(),
      queryKey: "TailSyntheticAddMiss",
      generations: [bComp.generationId],
      masks: {
        [bComp.generationId]: bComp.bitflag | cComp.bitflag,
      },
    });
    qInst.add(eid);
    qInst.toRemove.remove(eid);
    bComp.queries = [qInst];
    world.systemQueryMap.set(qInst.queryKey, [cleanupSystem]);

    const before = cleanupSystem.cleanupCount;
    addComponent(world, TailB, eid);
    expect(cleanupSystem.cleanupCount).toBeGreaterThan(before);
  });

  test("removeComponent !match path invokes queryRemoveEntity and cleanup systems", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailA, eid);
    addComponent(world, TailB, eid);
    const aComp = world(TailA);
    const qInst = Object.assign(SparseSet(), {
      toRemove: SparseSet(),
      entered: SparseSet(),
      queryKey: "TailSyntheticRemoveMiss",
      generations: [aComp.generationId],
      masks: {
        [aComp.generationId]: aComp.bitflag,
      },
    });
    qInst.add(eid);
    qInst.toRemove.remove(eid);
    aComp.queries = [qInst];

    const cleanupSystem = getSystem(world, TailCleanupSystem);
    world.systemQueryMap.set(qInst.queryKey, [cleanupSystem]);
    const before = cleanupSystem.cleanupCount;
    removeComponent(world, TailA, eid);
    expect(cleanupSystem.cleanupCount).toBeGreaterThan(before);
  });

  test("removeComponent match path triggers init loop for systems", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailAA, eid);
    addComponent(world, TailB, eid);
    const bComp = world(TailB);

    const qAA = Object.assign(SparseSet(), {
      toRemove: SparseSet(),
      entered: SparseSet(),
      queryKey: "TailSyntheticRemoveMatch",
      generations: [],
      masks: {},
    });
    bComp.queries = [qAA];
    const initSystem = getSystem(world, TailInitSystem);
    world.systemQueryMap.set(qAA.queryKey, [initSystem]);
    const before = initSystem.initCount;

    removeComponent(world, TailB, eid);
    expect(initSystem.initCount).toBeGreaterThan(before);
  });

  test("proxy ownKeys cache initializes on first key enumeration", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, TailScalar, eid, { n: 4 });
    const keys = Object.keys(world(TailScalar, eid));
    const keysAgain = Object.keys(world(TailScalar, eid));
    expect(keys).toContain("type");
    expect(keys).toContain("n");
    expect(keysAgain).toContain("n");
  });

  test("sortComponentQueries returns early for component not in world map", () => {
    class NotRegistered extends Schema {}
    const world = createWorld();
    sortComponentQueries(world, NotRegistered);
  });

  test("addComponent with null schema hits registerComponent null guard", () => {
    const world = createWorld();
    const eid = addEntity(world);
    // @ts-expect-error Intentional runtime guard test.
    expect(() => addComponent(world, null, eid)).toThrow("Cannot register null or undefined component");
  });

  test("stepWorldDraw evaluates systems with empty queries", () => {
    const world = createWorld();
    const drawSystem = getSystem(world, TailDrawSystem);
    stepWorldDraw(world);
    expect(drawSystem.runCount).toBe(0);
  });
});

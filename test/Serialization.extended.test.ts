import { describe, expect, test } from "vitest";
import { Component, defaultValue, type, nullable } from "../src/Decorators";
import { Schema } from "../src/Schema";
import {
  createWorld,
  addEntity,
  addComponent,
  entityExists,
  removeEntity,
  removeComponent,
  hasComponent,
} from "../src/World";
import { serializeWorld } from "../src/Serialize";
import { deserializeWorld } from "../src/Deserialize";
import { SerialMode } from "../src/Types";
import { defineQuery } from "../src/Query";

@Component()
class SPos extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(0)
  y: number;
}

@Component()
class SStr extends Schema {
  @type("string")
  @defaultValue("")
  label: string;
}

@Component()
class SFlag extends Schema {
  @type("boolean")
  @defaultValue(false)
  enabled: boolean;
}

@Component()
class SNullable extends Schema {
  @type("string")
  @nullable()
  @defaultValue(null)
  name: string | null;

  @type("number")
  @defaultValue(0)
  id: number;
}

@Component()
class STag extends Schema {}

describe("Binary serialization of empty world", () => {
  test("produces a valid buffer", () => {
    const world = createWorld();
    const buffer = serializeWorld(SerialMode.BINARY, world);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

describe("JSON round-trip preserves query state", () => {
  test("query results survive serialization", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 5, y: 10 });

    const q = defineQuery([SPos]);
    q(world);

    const json = serializeWorld(SerialMode.JSON, world);
    const clone = createWorld();
    deserializeWorld(json, clone);

    expect(q(clone)).toContain(eid);
    expect(clone(SPos, eid).x).toBe(5);
  });
});

describe("Base64 round-trip", () => {
  test("string and boolean components survive base64", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SStr, eid, { label: "hello" });
    addComponent(world, SFlag, eid, { enabled: true });

    const b64 = serializeWorld(SerialMode.BASE64, world);
    expect(typeof b64).toBe("string");

    const clone = deserializeWorld(b64);
    expect(clone(SStr, eid).label).toBe("hello");
    expect(clone(SFlag, eid).enabled).toBe(true);
  });
});

describe("Nullable values in serialization", () => {
  test("binary round-trip preserves null", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SNullable, eid, { name: null, id: 5 });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(SNullable, eid).name).toBe(null);
    expect(clone(SNullable, eid).id).toBe(5);
  });
});

describe("Serialization after entity removal", () => {
  test("removed entities excluded from serialized state", () => {
    const world = createWorld();
    const e1 = addEntity(world);
    const e2 = addEntity(world);
    addComponent(world, SPos, e1, { x: 1, y: 1 });
    addComponent(world, SPos, e2, { x: 2, y: 2 });
    removeEntity(world, e1);

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(entityExists(clone, e1)).toBe(false);
    expect(entityExists(clone, e2)).toBe(true);
    expect(clone(SPos, e2).x).toBe(2);
  });
});

describe("Tag component serialization", () => {
  test("tag components survive binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, STag, eid);
    addComponent(world, SPos, eid, { x: 7, y: 8 });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(SPos, eid).x).toBe(7);
  });
});

describe("Multiple entities serialization", () => {
  test("many entities with mixed components round-trip", () => {
    const world = createWorld(500);
    for (let i = 0; i < 100; i++) {
      const eid = addEntity(world);
      addComponent(world, SPos, eid, { x: i, y: i * 2 });
      if (i % 2 === 0) {
        addComponent(world, SStr, eid, { label: `ent_${i}` });
      }
      if (i % 3 === 0) {
        addComponent(world, SFlag, eid, { enabled: true });
      }
    }

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld(500);
    deserializeWorld(buffer, clone);

    expect(clone(SPos, 0).x).toBe(0);
    expect(clone(SPos, 50).x).toBe(50);
    expect(clone(SStr, 0).label).toBe("ent_0");
    expect(clone(SFlag, 0).enabled).toBe(true);
  });
});

// Component with object that can hold Map/Set values
@Component()
class SComplex extends Schema {
  @type("object")
  data: any;
}

describe("Map values in binary serialization", () => {
  test("Map survives binary round-trip via replacer/reviver", () => {
    const world = createWorld();
    const eid = addEntity(world);
    const mapData = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    addComponent(world, SComplex, eid, { data: mapData });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const restored = clone(SComplex, eid).data;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get("a")).toBe(1);
    expect(restored.get("b")).toBe(2);
  });
});

describe("Set values in binary serialization", () => {
  test("Set survives binary round-trip via replacer/reviver", () => {
    const world = createWorld();
    const eid = addEntity(world);
    const setData = new Set([10, 20, 30]);
    addComponent(world, SComplex, eid, { data: setData });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const restored = clone(SComplex, eid).data;
    expect(restored).toBeInstanceOf(Set);
    expect(restored.has(10)).toBe(true);
    expect(restored.has(20)).toBe(true);
    expect(restored.has(30)).toBe(true);
  });
});

describe("Dirty queries in serialization", () => {
  test("binary round-trip preserves dirty queries", () => {
    const world = createWorld();
    const q = defineQuery([SPos]);

    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 1, y: 2 });

    // Initialize query
    q(world);
    expect(q(world)).toContain(eid);

    // Remove component to make query dirty (entity queued in toRemove)
    removeComponent(world, SPos, eid);
    // Don't call q(world) - keeps dirtyQueries populated

    // Serialize with dirty queries present
    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    // Entity should still exist but without the component
    expect(entityExists(clone, eid)).toBe(true);
    expect(hasComponent(clone, SPos, eid)).toBe(false);
  });

  test("JSON round-trip preserves dirty queries", () => {
    const world = createWorld();
    const q = defineQuery([SPos]);

    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 5, y: 10 });

    q(world);
    removeComponent(world, SPos, eid);

    const json = serializeWorld(SerialMode.JSON, world);
    expect(json.dirtyQueries.length).toBeGreaterThan(0);

    const clone = createWorld();
    deserializeWorld(json, clone);

    expect(entityExists(clone, eid)).toBe(true);
    expect(hasComponent(clone, SPos, eid)).toBe(false);
  });
});

describe("Version mismatch", () => {
  test("throws on mismatched serializer version", () => {
    // Create a buffer with wrong version number
    const buffer = new ArrayBuffer(10);
    const view = new DataView(buffer);
    view.setUint16(0, 999); // invalid version

    const world = createWorld();
    expect(() => deserializeWorld(buffer, world)).toThrow("Mismatched serializer version");
  });
});

describe("Multiple entity mask generations", () => {
  test("binary round-trip with overflowed bitflag", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 42, y: 99 });

    // Force bitflag overflow to create multiple generations
    world.bitflag = 2 ** 31;
    world.entityMasks.push(new Uint32Array(world.size));

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(SPos, eid).x).toBe(42);
  });

  test("JSON round-trip with overflowed bitflag", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 7, y: 8 });

    world.bitflag = 2 ** 31;
    world.entityMasks.push(new Uint32Array(world.size));

    // Adjust a component's generationId to use the second mask
    const posComp = world.componentMap.values().next().value!;
    posComp.generationId = 1;

    const json = serializeWorld(SerialMode.JSON, world);
    const clone = createWorld();
    deserializeWorld(json, clone);

    // Verify the clone has multiple entity masks
    expect(clone.entityMasks.length).toBeGreaterThan(1);
  });
});

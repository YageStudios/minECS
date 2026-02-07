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
import { serializeWorld, createDeltaSerializer } from "../src/Serialize";
import { deserializeWorld, applyDelta } from "../src/Deserialize";
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

// Sub-object with ONLY simple properties (no nested objects/arrays)
// This forces serializeValue to iterate properties individually,
// hitting the "boolean" case (lines 149-151 of Serialize.ts)
@Component()
class FlatSettings extends Schema {
  @type("number")
  @defaultValue(0)
  speed: number;

  @type("boolean")
  @defaultValue(false)
  active: boolean;

  @type("string")
  @defaultValue("")
  label: string;
}

@Component()
class HasFlatSettings extends Schema {
  @type(FlatSettings)
  settings: FlatSettings;
}

@Component()
class BoolArrayComp extends Schema {
  @type(["boolean"])
  flags: boolean[];
}

@Component()
class NumberArrayComp extends Schema {
  @type(["number"])
  values: number[];
}

describe("Boolean in sub-object binary serialization", () => {
  test("boolean field in flat sub-object survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, HasFlatSettings, eid, {
      settings: { speed: 3.14, active: true, label: "on" },
    });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(HasFlatSettings, eid).settings.speed).toBe(3.14);
    expect(clone(HasFlatSettings, eid).settings.active).toBe(true);
    expect(clone(HasFlatSettings, eid).settings.label).toBe("on");
  });

  test("false boolean survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, HasFlatSettings, eid, {
      settings: { speed: 0, active: false, label: "" },
    });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(HasFlatSettings, eid).settings.active).toBe(false);
    expect(clone(HasFlatSettings, eid).settings.speed).toBe(0);
  });

  test("flat sub-object survives JSON round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, HasFlatSettings, eid, {
      settings: { speed: 99, active: true, label: "test" },
    });

    const json = serializeWorld(SerialMode.JSON, world);
    const clone = createWorld();
    deserializeWorld(json, clone);

    expect(clone(HasFlatSettings, eid).settings.speed).toBe(99);
    expect(clone(HasFlatSettings, eid).settings.active).toBe(true);
    expect(clone(HasFlatSettings, eid).settings.label).toBe("test");
  });
});

describe("Boolean array binary serialization", () => {
  test("array of booleans survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, BoolArrayComp, eid, { flags: [true, false, true, false] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(BoolArrayComp, eid).flags).toEqual([true, false, true, false]);
  });

  test("empty boolean array survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, BoolArrayComp, eid, { flags: [] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(BoolArrayComp, eid).flags).toEqual([]);
  });
});

describe("Number array binary serialization", () => {
  test("array of numbers survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, NumberArrayComp, eid, { values: [1.5, -3.7, 0, 100] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(NumberArrayComp, eid).values).toEqual([1.5, -3.7, 0, 100]);
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

// Fixed-length typed subarrays: @type(["float32", N]) creates a
// contiguous TypedArray backing with per-entity subviews.
// This exercises Serialize.ts lines 270-324 (ArrayBuffer.isView path).
@Component()
class Velocity extends Schema {
  @type(["float32", 3])
  xyz: Float32Array;
}

@Component()
class Color extends Schema {
  @type(["uint8", 4])
  rgba: Uint8Array;
}

describe("Typed subarray binary serialization", () => {
  test("float32 subarray survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [1.5, -2.25, 3.0] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const vel = clone(Velocity, eid).xyz;
    expect(vel[0]).toBeCloseTo(1.5);
    expect(vel[1]).toBeCloseTo(-2.25);
    expect(vel[2]).toBeCloseTo(3.0);
  });

  test("uint8 subarray survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Color, eid, { rgba: [255, 128, 0, 200] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const col = clone(Color, eid).rgba;
    expect(col[0]).toBe(255);
    expect(col[1]).toBe(128);
    expect(col[2]).toBe(0);
    expect(col[3]).toBe(200);
  });

  test("multiple entities with typed subarrays", () => {
    const world = createWorld();
    const e1 = addEntity(world);
    const e2 = addEntity(world);
    addComponent(world, Velocity, e1, { xyz: [10, 20, 30] });
    addComponent(world, Velocity, e2, { xyz: [40, 50, 60] });

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    expect(clone(Velocity, e1).xyz[0]).toBeCloseTo(10);
    expect(clone(Velocity, e2).xyz[2]).toBeCloseTo(60);
  });

  test("zeroed subarray survives binary round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid);

    const buffer = serializeWorld(SerialMode.BINARY, world);
    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const vel = clone(Velocity, eid).xyz;
    expect(vel[0]).toBe(0);
    expect(vel[1]).toBe(0);
    expect(vel[2]).toBe(0);
  });

  test("typed subarray survives base64 round-trip", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [7.5, 8.5, 9.5] });

    const b64 = serializeWorld(SerialMode.BASE64, world);
    const clone = deserializeWorld(b64);

    expect(clone(Velocity, eid).xyz[0]).toBeCloseTo(7.5);
    expect(clone(Velocity, eid).xyz[1]).toBeCloseTo(8.5);
    expect(clone(Velocity, eid).xyz[2]).toBeCloseTo(9.5);
  });

  test("proxy set works with typed subarrays", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid);

    world(Velocity, eid).xyz = [1, 2, 3] as any;
    expect(world(Velocity, eid).xyz[0]).toBeCloseTo(1);
    expect(world(Velocity, eid).xyz[1]).toBeCloseTo(2);
    expect(world(Velocity, eid).xyz[2]).toBeCloseTo(3);
  });
});

describe("Delta serialization", () => {
  test("first call produces full data that round-trips correctly", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [1.5, -2.25, 3.0] });

    const delta = createDeltaSerializer(world);
    const buffer = delta.serialize();

    const clone = createWorld();
    deserializeWorld(buffer, clone);

    const vel = clone(Velocity, eid).xyz;
    expect(vel[0]).toBe(1.5);
    expect(vel[1]).toBe(-2.25);
    expect(vel[2]).toBe(3);
  });

  test("no-change produces smaller buffer than initial", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [1.0, 2.0, 3.0] });

    const delta = createDeltaSerializer(world);
    const firstBuffer = delta.serialize();
    const secondBuffer = delta.serialize();

    expect(secondBuffer.byteLength).toBeLessThan(firstBuffer.byteLength);
  });

  test("no-change tag component produces smaller buffer than initial", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, STag, eid);

    const delta = createDeltaSerializer(world);
    const firstBuffer = delta.serialize();
    const secondBuffer = delta.serialize();

    expect(secondBuffer.byteLength).toBeLessThan(firstBuffer.byteLength);
  });

  test("scalar typed property delta only sends changed fields", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, SPos, eid, { x: 10, y: 20 });

    const delta = createDeltaSerializer(world);
    const fullBuffer = delta.serialize();

    const clone = createWorld();
    deserializeWorld(fullBuffer, clone);

    world(SPos, eid).x = 55;
    const deltaBuffer = delta.serialize();
    expect(deltaBuffer.byteLength).toBeLessThan(fullBuffer.byteLength);

    applyDelta(deltaBuffer, clone);
    expect(clone(SPos, eid).x).toBe(55);
    expect(clone(SPos, eid).y).toBe(20);
  });

  test("single element mutation only serializes that element", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [1.0, 2.0, 3.0] });

    const delta = createDeltaSerializer(world);
    const fullBuffer = delta.serialize();

    // set up clone from the full initial state
    const clone = createWorld();
    deserializeWorld(fullBuffer, clone);

    // mutate only one element
    world(Velocity, eid).xyz[1] = 99.0;
    const deltaBuffer = delta.serialize();

    applyDelta(deltaBuffer, clone);

    const vel = clone(Velocity, eid).xyz;
    expect(vel[0]).toBe(1);
    expect(vel[1]).toBe(99);
    expect(vel[2]).toBe(3);
  });

  test("multiple entities where only one changes", () => {
    const world = createWorld();
    const e1 = addEntity(world);
    const e2 = addEntity(world);
    addComponent(world, Velocity, e1, { xyz: [10, 20, 30] });
    addComponent(world, Velocity, e2, { xyz: [40, 50, 60] });

    const delta = createDeltaSerializer(world);
    const fullBuffer = delta.serialize();

    // set up clone from the full initial state
    const clone = createWorld();
    deserializeWorld(fullBuffer, clone);

    // only change e2
    world(Velocity, e2).xyz[0] = 999;
    const deltaBuffer = delta.serialize();

    // delta should be smaller since e1 is unchanged
    expect(deltaBuffer.byteLength).toBeLessThan(fullBuffer.byteLength);

    applyDelta(deltaBuffer, clone);

    expect(clone(Velocity, e1).xyz[0]).toBe(10);
    expect(clone(Velocity, e1).xyz[1]).toBe(20);
    expect(clone(Velocity, e2).xyz[0]).toBe(999);
    expect(clone(Velocity, e2).xyz[1]).toBe(50);
  });

  test("reset() re-initializes shadows", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, Velocity, eid, { xyz: [1.0, 2.0, 3.0] });

    const delta = createDeltaSerializer(world);
    delta.serialize(); // initial

    // no changes, so delta should be small
    const smallBuffer = delta.serialize();

    // reset and serialize again - should be full-sized
    delta.reset();
    const resetBuffer = delta.serialize();

    expect(resetBuffer.byteLength).toBeGreaterThan(smallBuffer.byteLength);

    // should still round-trip correctly
    const clone = createWorld();
    deserializeWorld(resetBuffer, clone);
    expect(clone(Velocity, eid).xyz[0]).toBe(1);
    expect(clone(Velocity, eid).xyz[2]).toBe(3);
  });
});

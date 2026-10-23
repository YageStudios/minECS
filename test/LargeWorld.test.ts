import { describe, expect, test } from "vitest";
import { Component, type } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { addComponent, addEntity, createWorld, entityExists, hasComponent, removeEntity } from "../src/World";
import { createDeltaSerializer, serializeWorld, serializeWorldView, SERIALIZER_VERSION } from "../src/Serialize";
import { applyDelta, deserializeWorld } from "../src/Deserialize";
import { defineQuery } from "../src/Query";
import { SerialMode, type World } from "../src/Types";

@Component()
class LwPos extends Schema {
  @type("number")
  x: number;
}

@Component()
class LwData extends Schema {
  @type("string")
  s: string;

  @type(["uint8", 3])
  v: Uint8Array;

  @type("object")
  o: { deep: number[] };

  @type(["number"])
  list: number[];
}

const lwQuery = defineQuery([LwPos]);
const lwDataQuery = defineQuery([LwPos, LwData]);

/** Fills ids 0..count-1 and returns the world. */
const fill = (size: number, count: number) => {
  const world = createWorld(size);
  for (let i = 0; i < count; i++) {
    const eid = addEntity(world);
    addComponent(world, LwPos, eid, { x: eid });
  }
  return world;
};

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

const widthByte = (payload: ArrayBuffer) => new Uint8Array(payload)[3];

const expectSameWorld = (a: World, b: World) => {
  expect(b.size).toBe(a.size);
  expect(b.entityCursor).toBe(a.entityCursor);
  expect([...b.entitySparseSet.dense]).toEqual([...a.entitySparseSet.dense]);
  expect([...b.removed]).toEqual([...a.removed]);
  expect([...lwQuery(b)]).toEqual([...lwQuery(a)]);
  expect([...lwDataQuery(b)]).toEqual([...lwDataQuery(a)]);
};

describe("worlds beyond 65535 entities", () => {
  test("ids on both sides of the 16-bit boundary round-trip, including the old missing-slot marker 65535", () => {
    const world = fill(70000, 70000);
    // Free 65535 (the uint16 missing-slot marker) and neighbours, so they appear in the free list.
    for (const eid of [65534, 65535, 65536, 69999]) removeEntity(world, eid);
    addComponent(world, LwData, 65537, { s: "big", v: [1, 2, 3] as any, o: { deep: [4] }, list: [5, 6] });

    for (const mode of [SerialMode.BINARY, SerialMode.BASE64, SerialMode.JSON]) {
      const payload =
        mode === SerialMode.BINARY
          ? serializeWorld(SerialMode.BINARY, world)
          : mode === SerialMode.BASE64
            ? serializeWorld(SerialMode.BASE64, world)
            : serializeWorld(SerialMode.JSON, world);
      const copy = deserializeWorld(payload);
      expectSameWorld(world, copy);
      expect(entityExists(copy, 65535)).toBe(false);
      expect(entityExists(copy, 65533)).toBe(true);
      expect(copy(LwPos, 65537).x).toBe(65537);
      expect(copy(LwData, 65537).s).toBe("big");
      expect(Array.from(copy(LwData, 65537).v)).toEqual([1, 2, 3]);
      expect(copy(LwData, 65537).o).toEqual({ deep: [4] });
      expect(copy(LwData, 65537).list).toEqual([5, 6]);
      // The free list carried over, so the next id is a recycled one, as in the source.
      expect(addEntity(copy)).toBe(addEntity(createWorldLike(world)));
    }
  });

  test("the payload uses 16-bit ids up to size 65535 and 32-bit ids above", () => {
    expect(SERIALIZER_VERSION).toBe(5);
    const narrow = fill(65535, 65535);
    const narrowPayload = serializeWorld(SerialMode.BINARY, narrow);
    expect(widthByte(narrowPayload)).toBe(2);
    const narrowCopy = deserializeWorld(narrowPayload);
    expectSameWorld(narrow, narrowCopy);
    expect(narrowCopy(LwPos, 65534).x).toBe(65534);

    const wide = fill(65536, 65536);
    const widePayload = serializeWorld(SerialMode.BINARY, wide);
    expect(widthByte(widePayload)).toBe(4);
    const wideCopy = deserializeWorld(widePayload);
    expectSameWorld(wide, wideCopy);
    expect(wideCopy(LwPos, 65535).x).toBe(65535);
    expect(() => addEntity(wideCopy)).toThrow("max entities reached");
  });

  test("deltas carry entity changes past 65535", () => {
    const source = fill(100000, 80000);
    const receiver = deserializeWorld(serializeWorld(SerialMode.BINARY, source));
    const delta = createDeltaSerializer(source);
    // The first frame is a full snapshot.
    deserializeWorld(delta.serialize(), receiver);

    removeEntity(source, 70000);
    removeEntity(source, 65535);
    const added = [addEntity(source), addEntity(source), addEntity(source)];
    for (const eid of added) addComponent(source, LwPos, eid, { x: -eid });
    source(LwPos, 79999).x = 123;
    addComponent(source, LwData, 79998, { s: "late" });

    const frame = delta.serialize();
    expect(widthByte(frame)).toBe(4);
    applyDelta(frame, receiver);
    expectSameWorld(source, receiver);
    for (const eid of added) expect(receiver(LwPos, eid).x).toBe(-eid);
    expect(receiver(LwPos, 79999).x).toBe(123);
    expect(receiver(LwData, 79998).s).toBe("late");
    expect(hasComponent(receiver, LwPos, 70000)).toBe(false);
  });
});

/** A world in the same state as `world`, rebuilt through JSON, to compare the next recycled id. */
const createWorldLike = (world: World) => deserializeWorld(serializeWorld(SerialMode.JSON, world));

describe("payload compatibility", () => {
  test("version 4 payloads (16-bit ids, no width byte) are still read", () => {
    const world = fill(1000, 300);
    removeEntity(world, 7);
    addComponent(world, LwData, 3, { s: "v4", v: [9, 8, 7] as any, o: { deep: [] }, list: [] });
    const v5 = new Uint8Array(serializeWorld(SerialMode.BINARY, world));
    expect(v5[3]).toBe(2);
    // v4 is v5 without the width byte.
    const v4 = new Uint8Array(v5.length - 1);
    v4.set(v5.subarray(0, 3));
    v4.set(v5.subarray(4), 3);
    new DataView(v4.buffer).setUint16(0, 4);
    const copy = deserializeWorld(v4.buffer);
    expectSameWorld(world, copy);
    expect(copy(LwData, 3).s).toBe("v4");
    expect(Array.from(copy(LwData, 3).v)).toEqual([9, 8, 7]);
  });

  test("unknown versions and invalid width bytes are rejected", () => {
    const payload = new Uint8Array(serializeWorld(SerialMode.BINARY, fill(10, 3)));
    const future = payload.slice();
    new DataView(future.buffer).setUint16(0, SERIALIZER_VERSION + 1);
    expect(() => deserializeWorld(future.buffer)).toThrow("Mismatched serializer version");
    const old = payload.slice();
    new DataView(old.buffer).setUint16(0, 3);
    expect(() => deserializeWorld(old.buffer)).toThrow("Mismatched serializer version");
    const badWidth = payload.slice();
    badWidth[3] = 3;
    expect(() => deserializeWorld(badWidth.buffer)).toThrow("invalid index width 3");
  });
});

describe("target world size", () => {
  test("deserializeWorld without a world creates one sized for the payload", () => {
    const world = fill(5000, 4000);
    for (const payload of [
      serializeWorld(SerialMode.BINARY, world),
      serializeWorld(SerialMode.BASE64, world),
      serializeWorld(SerialMode.JSON, world),
    ]) {
      const copy = deserializeWorld(payload);
      expect(copy.size).toBe(5000);
      expect(copy(LwPos, 3999).x).toBe(3999);
    }
  });

  test("a payload larger than the target world throws before changing it", () => {
    const big = fill(3000, 2500);
    const small = fill(2000, 10);
    small(LwPos, 4).x = 44;
    for (const payload of [serializeWorld(SerialMode.BINARY, big), serializeWorld(SerialMode.JSON, big)]) {
      expect(() => deserializeWorld(payload as any, small)).toThrow(
        "the payload is for a world of size 3000 but this world was created with size 2000",
      );
      expect(small.size).toBe(2000);
      expect(small.entitySparseSet.dense.length).toBe(10);
      expect(small(LwPos, 4).x).toBe(44);
      expect([...lwQuery(small)].length).toBe(10);
    }
  });

  test("a smaller payload fits, and a later larger one up to the created size still fits", () => {
    const target = createWorld(3000);
    deserializeWorld(serializeWorld(SerialMode.BINARY, fill(1000, 900)), target);
    expect(target.size).toBe(1000);
    deserializeWorld(serializeWorld(SerialMode.BINARY, fill(3000, 2999)), target);
    expect(target.size).toBe(3000);
    expect(target(LwPos, 2998).x).toBe(2998);
  });
});

describe("serialization buffer growth", () => {
  test("a tiny starting buffer grows to fit any payload, for full and delta frames", () => {
    const world = fill(2000, 1500);
    for (let eid = 0; eid < 1500; eid += 3) {
      addComponent(world, LwData, eid, {
        s: "x".repeat(200),
        v: [eid & 255, 1, 2] as any,
        o: { deep: [eid, eid] },
        list: Array.from({ length: 20 }, (_, i) => i * eid),
      });
    }
    const expected = new Uint8Array(serializeWorld(SerialMode.BINARY, world));

    // Each call shares one module-level scratch buffer; grow from a 16-byte request upwards.
    const fromTiny = new Uint8Array(createDeltaSerializer(world).serialize(16));
    expect(fromTiny.length).toBe(expected.length);
    expect(sameBytes(fromTiny, expected)).toBe(true);
    expect(sameBytes(serializeWorldView(world, 16), expected)).toBe(true);

    const receiver = deserializeWorld(expected.buffer);
    const delta = createDeltaSerializer(world);
    deserializeWorld(delta.serialize(1), receiver);
    for (let eid = 0; eid < 1500; eid += 3) world(LwData, eid).list = Array.from({ length: 50 }, () => eid);
    applyDelta(delta.serialize(1), receiver);
    expect(receiver(LwData, 1497).list).toEqual(Array.from({ length: 50 }, () => 1497));
    expect(receiver(LwData, 1497).s).toBe("x".repeat(200));
  });
});

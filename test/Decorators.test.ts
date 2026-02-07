import { describe, expect, test } from "vitest";
import { Component, defaultValue, type, required, nullable } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { createWorld, addEntity, addComponent } from "../src/World";

// Named component override
@Component("RenamedWidget")
class Widget extends Schema {
  @type("number")
  @defaultValue(0)
  size: number;
}

// Category via number argument
@Component(7)
class Categorized extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

// Enum-style record type
enum Dir {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
}

@Component()
class WithEnum extends Schema {
  @type(Dir)
  dir: Dir;
}

// Entity reference
@Component()
class WithEntityRef extends Schema {
  @type("Entity")
  target: number;

  @type("EntityArray")
  targets: number[];

  @type(["Entity"])
  moreTargets: number[];
}

// Typed numbers
@Component()
class WithTypedNums extends Schema {
  @type("float32")
  @defaultValue(0)
  f: number;

  @type("int32")
  @defaultValue(0)
  i: number;

  @type("uint8")
  @defaultValue(0)
  u: number;
}

// Map type
@Component()
class WithMap extends Schema {
  @type({ set: "number" })
  data: Record<string, number>;
}

// Nullable + required
@Component()
class WithNullable extends Schema {
  @type("string")
  @nullable()
  @defaultValue(null)
  name: string | null;

  @type("number")
  @required()
  @defaultValue(0)
  id: number;
}

// Array of primitives
@Component()
class WithArray extends Schema {
  @type(["number"])
  @defaultValue([])
  items: number[];
}

// Nested schema type
@Component()
class Inner extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;
}

@Component()
class WithNested extends Schema {
  @type(Inner)
  inner: Inner;
}

// Duplicate component name: second class reuses first's schema
@Component("DupComp")
class DupFirst extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

@Component("DupComp")
class DupSecond extends Schema {
  @type("number")
  @defaultValue(0)
  val: number;
}

// Underscore-prefixed property keys
@Component()
class WithUnderscore extends Schema {
  @type("number")
  @defaultValue(0)
  _hidden: number;
}

describe("@Component name override", () => {
  test("custom string name sets type", () => {
    expect(Widget.type).toBe("RenamedWidget");
  });
});

describe("@Component category", () => {
  test("numeric argument sets category", () => {
    expect(Categorized.category).toBe(7);
  });
});

describe("@type with enum (record)", () => {
  test("enum values stored correctly", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithEnum, eid, { dir: Dir.Left });
    expect(world(WithEnum, eid).dir).toBe(Dir.Left);
  });
});

describe("@type Entity references", () => {
  test("Entity and EntityArray types", () => {
    const world = createWorld();
    const a = addEntity(world);
    const b = addEntity(world);
    addComponent(world, WithEntityRef, a, {
      target: b,
      targets: [b],
      moreTargets: [b],
    });
    expect(world(WithEntityRef, a).target).toBe(b);
  });
});

describe("@type typed numbers", () => {
  test("float32, int32, uint8 store and retrieve", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithTypedNums, eid, { f: 3.14, i: -100, u: 200 });
    expect(world(WithTypedNums, eid).f).toBeCloseTo(3.14, 1);
    expect(world(WithTypedNums, eid).i).toBe(-100);
    expect(world(WithTypedNums, eid).u).toBe(200);
  });
});

describe("@type map", () => {
  test("map-typed property stores key-value data", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithMap, eid, { data: { a: 1, b: 2 } });
    expect(world(WithMap, eid).data).toEqual({ a: 1, b: 2 });
  });
});

describe("@nullable and @required", () => {
  test("nullable accepts null, required field has value", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithNullable, eid, { name: null, id: 42 });
    expect(world(WithNullable, eid).name).toBe(null);
    expect(world(WithNullable, eid).id).toBe(42);
  });
});

describe("@type array", () => {
  test("array of primitives stores and retrieves", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithArray, eid, { items: [10, 20, 30] });
    expect(world(WithArray, eid).items).toEqual([10, 20, 30]);
  });
});

describe("@type nested schema", () => {
  test("nested object component stores sub-schema", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, WithNested, eid, { inner: { x: 99 } });
    expect(world(WithNested, eid).inner).toEqual({ x: 99 });
  });
});

describe("@Component duplicate name", () => {
  test("second class with same name inherits first's schema", () => {
    expect(DupSecond.type).toBe("DupComp");
    expect(DupSecond.schema).toBe(DupFirst.schema);
    expect(DupSecond.validate).toBe(DupFirst.validate);
  });
});

describe("underscore-prefixed property keys", () => {
  test("underscore is stripped from property key in schema", () => {
    const world = createWorld();
    const eid = addEntity(world);

    // @ts-ignore
    addComponent(world, WithUnderscore, eid, { hidden: 42 });
    // @ts-ignore
    expect(world(WithUnderscore, eid).hidden).toBe(42);
  });
});

describe("decorator branch edge cases", () => {
  test("typed tuple metadata only set when type key exists", () => {
    class TupleTarget extends Schema {}

    const targetKnown = { constructor: TupleTarget };
    type(["float32", 3])(targetKnown, "known");

    const targetUnknown = { constructor: TupleTarget };
    type(["string", 3])(targetUnknown, "unknown");

    const tupleMeta = (TupleTarget as typeof Schema & { __minECS?: Record<string, unknown> }).__minECS ?? {};
    expect(tupleMeta.known).toEqual(["f32", 3]);
    expect(tupleMeta.unknown).toBeUndefined();
  });

  test("defaultValue with non-string key does not mark required", () => {
    class SymbolKeyTarget extends Schema {}
    const target = { constructor: SymbolKeyTarget };
    const sym = Symbol("symDefault");
    defaultValue(123)(target, sym as unknown as string);

    expect(SymbolKeyTarget.schema.required).toEqual([]);
  });
});

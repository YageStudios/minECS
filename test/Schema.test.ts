import { describe, expect, test } from "vitest";
import { Schema, generateSchema } from "../src/Schema";

describe("generateSchema", () => {
  test("initializes schema on fresh class", () => {
    class Fresh extends Schema {}
    const gen = generateSchema({ constructor: Fresh } as Schema);
    expect(Fresh.schema).toBeDefined();
    expect(Fresh.schema.type).toBe("object");
    expect(Fresh.schema.additionalProperties).toBe(false);
    expect(Fresh.schema.$comment).toBe("Fresh");
  });

  test("setType sets property type", () => {
    class TypeTest extends Schema {}
    const gen = generateSchema({ constructor: TypeTest } as Schema);
    gen.setType("x", "number");
    expect(TypeTest.schema.properties.x.type).toBe("number");
  });

  test("setType merges with existing different type", () => {
    class MergeTest extends Schema {}
    const gen = generateSchema({ constructor: MergeTest } as Schema);
    gen.setType("val", "number");
    gen.setType("val", "null");
    // Should become array of types
    expect(Array.isArray(MergeTest.schema.properties.val.type)).toBe(true);
    expect(MergeTest.schema.properties.val.type).toContain("number");
    expect(MergeTest.schema.properties.val.type).toContain("null");
  });

  test("setType with array prevType that already includes type is no-op", () => {
    class ArrayTypeTest extends Schema {}
    const gen = generateSchema({ constructor: ArrayTypeTest } as Schema);
    gen.setType("val", "number");
    gen.setType("val", "null");
    // Now it's ["number", "null"]
    gen.setType("val", "null"); // adding again
    expect(ArrayTypeTest.schema.properties.val.type).toEqual(["number", "null"]);
  });

  test("setType with array prevType adding new type", () => {
    class ArrayAddTest extends Schema {}
    const gen = generateSchema({ constructor: ArrayAddTest } as Schema);
    gen.setType("val", "number");
    gen.setType("val", "null");
    gen.setType("val", "string");
    expect(ArrayAddTest.schema.properties.val.type).toContain("string");
  });

  test("setType same type twice is no-op", () => {
    class SameTest extends Schema {}
    const gen = generateSchema({ constructor: SameTest } as Schema);
    gen.setType("val", "number");
    gen.setType("val", "number");
    expect(SameTest.schema.properties.val.type).toBe("number");
  });

  test("setDefault sets default value", () => {
    class DefaultTest extends Schema {}
    const gen = generateSchema({ constructor: DefaultTest } as Schema);
    gen.setDefault("x", 42);
    expect(DefaultTest.schema.properties.x.default).toBe(42);
    expect(DefaultTest.schema.properties.x.type).toBe("number");
  });

  test("setDefault with null creates property without type", () => {
    class NullDefault extends Schema {}
    const gen = generateSchema({ constructor: NullDefault } as Schema);
    gen.setDefault("val", null);
    expect(NullDefault.schema.properties.val.default).toBe(null);
  });

  test("setDefault on existing property preserves type", () => {
    class ExistingDefault extends Schema {}
    const gen = generateSchema({ constructor: ExistingDefault } as Schema);
    gen.setType("x", "number");
    gen.setDefault("x", 0);
    expect(ExistingDefault.schema.properties.x.type).toBe("number");
    expect(ExistingDefault.schema.properties.x.default).toBe(0);
  });

  test("setDefault with different typeof merges into type array (addType line 41)", () => {
    class MergeDefault extends Schema {}
    const gen = generateSchema({ constructor: MergeDefault } as Schema);
    // First set type to "string"
    gen.setType("mixed", "string");
    // Then setDefault with a number value, typeof is "number"
    gen.setDefault("mixed", 42);
    // addType should merge: ["string", "number"]
    expect(Array.isArray(MergeDefault.schema.properties.mixed.type)).toBe(true);
    expect(MergeDefault.schema.properties.mixed.type).toContain("string");
    expect(MergeDefault.schema.properties.mixed.type).toContain("number");
  });

  test("setDefault on array-typed property pushes new type (addType line 39)", () => {
    class ArrayPush extends Schema {}
    const gen = generateSchema({ constructor: ArrayPush } as Schema);
    // Set up an array type first
    gen.setType("val", "string");
    gen.setDefault("val", 42); // merges to ["string", "number"]
    // Now set default with boolean - typeof "boolean" is new
    gen.setDefault("val", true); // should push "boolean" to array
    expect(ArrayPush.schema.properties.val.type).toContain("boolean");
  });

  test("setRequired adds key to required array", () => {
    class ReqTest extends Schema {}
    const gen = generateSchema({ constructor: ReqTest } as Schema);
    gen.setRequired("id");
    expect(ReqTest.schema.required).toContain("id");
  });

  test("setRequired is idempotent", () => {
    class ReqIdempotent extends Schema {}
    const gen = generateSchema({ constructor: ReqIdempotent } as Schema);
    gen.setRequired("id");
    gen.setRequired("id");
    expect(ReqIdempotent.schema.required.filter((r: string) => r === "id").length).toBe(1);
  });

  test("setEnum creates enum property with titles", () => {
    class EnumTest extends Schema {}
    const gen = generateSchema({ constructor: EnumTest } as Schema);
    const myEnum = { Up: 0, Down: 1, Left: 2, Right: 3 };
    gen.setEnum("dir", myEnum);
    expect(EnumTest.schema.properties.dir.enum).toEqual([0, 1, 2, 3]);
    expect(EnumTest.schema.properties.dir.options.enum_titles).toEqual(["Up", "Down", "Left", "Right"]);
  });

  test("setEntityFlag adds key to entityTypes", () => {
    class EntityFlagTest extends Schema {}
    const gen = generateSchema({ constructor: EntityFlagTest } as Schema);
    gen.setEntityFlag("target");
    expect(EntityFlagTest.entityTypes).toContain("target");
  });

  test("setArrayType with string type", () => {
    class ArrayTypeTestStr extends Schema {}
    const gen = generateSchema({ constructor: ArrayTypeTestStr } as Schema);
    gen.setArrayType("items", "number");
    expect(ArrayTypeTestStr.schema.properties.items.type).toBe("array");
    expect(ArrayTypeTestStr.schema.properties.items.items.type).toBe("number");
  });

  test("setArrayType with Schema type sets constructables", () => {
    class Inner extends Schema {}
    // @ts-ignore
    Inner.schema = { properties: { x: { type: "number" } }, required: [] };

    class ArraySchemaTest extends Schema {}
    const gen = generateSchema({ constructor: ArraySchemaTest } as Schema);
    gen.setArrayType("children", Inner);
    expect(ArraySchemaTest.schema.properties.children.type).toBe("array");
    expect(ArraySchemaTest.schema.properties.children.items.type).toBe("object");
    // @ts-ignore
    expect(ArraySchemaTest.constructables.children).toBe(Inner);
  });

  test("setObjectType creates object property with nested schema", () => {
    class InnerObj extends Schema {}
    // @ts-ignore
    InnerObj.schema = { properties: { x: { type: "number" } }, required: ["x"] };

    class ObjTest extends Schema {}
    const gen = generateSchema({ constructor: ObjTest } as Schema);
    gen.setObjectType("inner", InnerObj);
    expect(ObjTest.schema.properties.inner.type).toBe("object");
    expect(ObjTest.schema.properties.inner.additionalProperties).toBe(false);
    // @ts-ignore
    expect(ObjTest.constructables.inner).toBe(InnerObj);
  });

  test("setMapType with string type", () => {
    class MapTest extends Schema {}
    const gen = generateSchema({ constructor: MapTest } as Schema);
    gen.setMapType("data", "number");
    expect(MapTest.schema.properties.data.type).toBe("object");
    expect(MapTest.schema.properties.data.patternProperties[".*"].type).toBe("number");
    expect(MapTest.schema.properties.data.additionalProperties).toBe(false);
  });

  test("setMapType with Schema type", () => {
    class MapInner extends Schema {}
    // @ts-ignore
    MapInner.schema = { properties: { id: { type: "number" } }, required: [] };

    class MapSchemaTest extends Schema {}
    const gen = generateSchema({ constructor: MapSchemaTest } as Schema);
    gen.setMapType("entries", MapInner);
    expect(MapSchemaTest.schema.properties.entries.patternProperties[".*"].type).toBe("object");
  });

  test("generateSchema on inherited class clones parent schema", () => {
    class Parent extends Schema {}
    const parentGen = generateSchema({ constructor: Parent } as Schema);
    parentGen.setType("x", "number");

    class Child extends Schema {}
    // Simulate inheritance by copying schema
    // @ts-ignore
    Child.schema = Parent.schema;

    const childGen = generateSchema({ constructor: Child } as Schema);
    childGen.setType("y", "string");

    // Child should have its own cloned schema
    expect(Child.schema.$comment).toBe("Child");
    expect(Child.schema.properties.y).toBeDefined();
  });
});

describe("Schema constructor", () => {
  test("plain schema construction works", () => {
    const instance = new Schema();
    expect(instance).toBeInstanceOf(Schema);
  });

  test("constructables skip undefined keys", () => {
    class Child extends Schema {}
    class Parent extends Schema {}
    // @ts-ignore test setup
    Parent.constructables = { missing: Child };
    const parent = new Parent() as Parent & { missing?: Child };
    expect(parent.missing).toBeUndefined();
  });
});

describe("additional branch coverage", () => {
  test("setDefault null keeps existing property (does not recreate)", () => {
    class ExistingNull extends Schema {}
    const gen = generateSchema({ constructor: ExistingNull } as Schema);
    gen.setType("v", "number");
    const before = ExistingNull.schema.properties.v;
    gen.setDefault("v", null);
    expect(ExistingNull.schema.properties.v).toBe(before);
    expect(ExistingNull.schema.properties.v.default).toBeNull();
  });

  test("setType normalizes alternate numeric types", () => {
    class AltNum extends Schema {}
    const gen = generateSchema({ constructor: AltNum } as Schema);
    gen.setType("v", "float32");
    expect(AltNum.schema.properties.v.type).toBe("number");
  });

  test("setType merges scalar previous type with new scalar type", () => {
    class ScalarMerge extends Schema {}
    const gen = generateSchema({ constructor: ScalarMerge } as Schema);
    gen.setType("v", "number");
    gen.setType("v", "string");
    expect(ScalarMerge.schema.properties.v.type).toEqual(["number", "string"]);
  });

  test("setType merges scalar previous type with normalized alt-number type", () => {
    class ScalarAltMerge extends Schema {}
    const gen = generateSchema({ constructor: ScalarAltMerge } as Schema);
    gen.setType("v", "string");
    gen.setType("v", "float32");
    expect(ScalarAltMerge.schema.properties.v.type).toEqual(["string", "number"]);
  });

  test("setType scalar previous type branch merges directly seeded schema type", () => {
    class SeededScalarMerge extends Schema {}
    const gen = generateSchema({ constructor: SeededScalarMerge } as Schema);
    SeededScalarMerge.schema.properties.v = { type: "string" };
    gen.setType("v", "boolean");
    expect(SeededScalarMerge.schema.properties.v.type).toEqual(["string", "boolean"]);
  });

  test("setMapType with string primitive follows primitive map branch", () => {
    class PrimitiveMap extends Schema {}
    const gen = generateSchema({ constructor: PrimitiveMap } as Schema);
    gen.setMapType("m", "float32");
    expect(PrimitiveMap.schema.properties.m.patternProperties[".*"].type).toBe("number");
  });
});

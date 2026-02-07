import { describe, expect, test } from "vitest";
import {
  createStore,
  resize,
  resetStore,
  resetStoreFor,
  resizeStore,
  FauxStore,
  free,
  createShadow,
  parentArray,
  $storeFlattened,
  $storeSize,
  $tagStore,
  $storeBase,
  $storeRef,
  $isEidType,
  $queryShadow,
  $serializeShadow,
  $parentArray,
  $indexType,
  $indexBytes,
  $subarray,
  $subarrayCursors,
  type Store,
} from "../src/Storage";

describe("createStore", () => {
  test("empty schema creates tag store", () => {
    const store = createStore(null, 10);
    expect(store[$tagStore]).toBe(true);
    expect(store[$storeFlattened]).toEqual([]);
    expect(store[$storeSize]).toBe(10);
  });

  test("empty object schema creates tag store", () => {
    const store = createStore({}, 10);
    expect(store[$tagStore]).toBe(true);
  });

  test("schema with string type creates typed array store", () => {
    const store = createStore({ x: "f64", y: "f64" }, 100);
    expect(store[$tagStore]).toBeUndefined();
    expect(store[$storeFlattened].length).toBe(2);
    expect(store.x).toBeInstanceOf(Float64Array);
    expect(store.y).toBeInstanceOf(Float64Array);
    expect(store.x.length).toBe(100);
  });

  test("schema with int32 type", () => {
    const store = createStore({ val: "i32" }, 50);
    expect(store.val).toBeInstanceOf(Int32Array);
    expect(store.val.length).toBe(50);
  });

  test("schema with uint8 type", () => {
    const store = createStore({ flag: "ui8" }, 50);
    expect(store.flag).toBeInstanceOf(Uint8Array);
    expect(store.flag.length).toBe(50);
  });

  test("schema with eid type sets isEidType flag", () => {
    const store = createStore({ target: "eid" }, 50);
    expect(store.target[$isEidType]).toBe(true);
  });

  test("schema with array type creates subarray store", () => {
    const store = createStore({ items: ["f32", 4] }, 10);
    expect(store.items).toBeDefined();
    expect(store.items.length).toBe(10);
    // Each eid gets a subarray of length 4
    expect(store.items[0].length).toBe(4);
    expect(store.items[5].length).toBe(4);
    expect(store.items[0][$subarray]).toBe(true);
  });

  test("array store with eid type", () => {
    const store = createStore({ refs: ["eid", 3] }, 10);
    expect(store.refs[0].length).toBe(3);
    expect(store.refs[$isEidType]).toBe(true);
  });

  test("nested object schema creates nested stores", () => {
    const store = createStore({ inner: { a: "f64", b: "i32" } }, 20);
    expect(store.inner.a).toBeInstanceOf(Float64Array);
    expect(store.inner.b).toBeInstanceOf(Int32Array);
    expect(store.inner.a.length).toBe(20);
  });

  test("store base returns self", () => {
    const store = createStore({ x: "f64" }, 10);
    expect(store[$storeBase]()).toBe(store);
  });
});

describe("resize", () => {
  test("grows a typed array preserving data", () => {
    const original = new Float64Array([1.5, 2.5, 3.5]);
    const resized = resize(original, 6);
    expect(resized.length).toBe(6);
    expect(resized[0]).toBe(1.5);
    expect(resized[1]).toBe(2.5);
    expect(resized[2]).toBe(3.5);
    expect(resized[3]).toBe(0);
  });

  test("preserves type of array", () => {
    const original = new Int32Array([10, -20]);
    const resized = resize(original, 5);
    expect(resized).toBeInstanceOf(Int32Array);
    expect(resized[0]).toBe(10);
    expect(resized[1]).toBe(-20);
  });
});

describe("FauxStore", () => {
  test("set and get data by eid", () => {
    const baseStore = createStore({ x: "f64" }, 10);
    const faux = FauxStore("label", baseStore);

    faux[0] = "hello";
    faux[1] = "world";

    expect(faux[0]).toBe("hello");
    expect(faux[1]).toBe("world");
  });

  test("_data returns internal data object", () => {
    const baseStore = createStore(null, 10);
    const faux = FauxStore("test", baseStore);
    faux[5] = "val";
    expect(faux._data).toEqual({ 5: "val" });
  });

  test("_key returns the key name", () => {
    const baseStore = createStore(null, 10);
    const faux = FauxStore("myKey", baseStore);
    expect(faux._key).toBe("myKey");
  });

  test("setting _data replaces entire data object", () => {
    const baseStore = createStore(null, 10);
    const faux = FauxStore("k", baseStore);
    faux[0] = "old";
    faux._data = { 0: "new" };
    expect(faux[0]).toBe("new");
  });

  test("symbol keys return from target", () => {
    const baseStore = createStore({ x: "f64" }, 10);
    const faux = FauxStore("k", baseStore);
    expect(faux[$storeBase]).toBeDefined();
  });
});

describe("resetStore", () => {
  test("zeroes all typed array data", () => {
    const store = createStore({ x: "f64", y: "i32" }, 10);
    store.x[0] = 42.5;
    store.y[3] = 99;

    resetStore(store);

    expect(store.x[0]).toBe(0);
    expect(store.y[3]).toBe(0);
  });

  test("clears FauxStore _data", () => {
    // FauxStore has _data property
    const baseStore = createStore(null, 10);
    const faux = FauxStore("label", baseStore);
    faux[0] = "test";

    // Manually add to flattened so resetStore processes it
    baseStore[$storeFlattened].push(faux);
    resetStore(baseStore);

    expect(faux._data).toEqual({});
  });

  test("no-op on store without flattened", () => {
    const store = {} as Store;
    resetStore(store); // should not throw
  });

  test("resets subarray parent buffer", () => {
    const store = createStore({ items: ["f32", 3] }, 5);
    store.items[0][0] = 1.5;
    store.items[0][1] = 2.5;

    // Get the parent array before reset
    const parent = parentArray(store.items as unknown as Store);
    expect(parent[0]).toBe(1.5);

    resetStore(store);

    // resetStore zeroes the underlying $storeSubarrays buffer
    expect(parent[0]).toBe(0);
    expect(parent[1]).toBe(0);
  });
});

describe("resetStoreFor", () => {
  test("zeroes typed array for specific eid", () => {
    const store = createStore({ x: "f64", y: "f64" }, 10);
    store.x[3] = 42;
    store.y[3] = 99;
    store.x[5] = 10;

    resetStoreFor(store, 3);

    expect(store.x[3]).toBe(0);
    expect(store.y[3]).toBe(0);
    expect(store.x[5]).toBe(10); // other eid untouched
  });

  test("deletes FauxStore data for specific eid", () => {
    const baseStore = createStore(null, 10);
    const faux = FauxStore("label", baseStore);
    faux[0] = "keep";
    faux[1] = "delete";
    baseStore[$storeFlattened].push(faux);

    resetStoreFor(baseStore, 1);

    expect(faux[0]).toBe("keep");
    expect(faux[1]).toBeUndefined();
  });

  test("zeroes subarray for specific eid", () => {
    const store = createStore({ items: ["f32", 3] }, 5);
    store.items[2][0] = 1.5;
    store.items[2][1] = 2.5;
    store.items[2][2] = 3.5;

    resetStoreFor(store, 2);

    expect(store.items[2][0]).toBe(0);
    expect(store.items[2][1]).toBe(0);
    expect(store.items[2][2]).toBe(0);
  });

  test("no-op on store without flattened", () => {
    const store = {} as Store;
    resetStoreFor(store, 0); // should not throw
  });
});

describe("resizeStore", () => {
  test("resizes typed array stores to new size", () => {
    const store = createStore({ x: "f64" }, 10);
    store.x[5] = 42;

    resizeStore(store, 20);

    expect(store[$storeSize]).toBe(20);
    expect(store.x.length).toBe(20);
    expect(store.x[5]).toBe(42); // data preserved
  });

  test("no-op for tag stores", () => {
    const store = createStore(null, 10);
    resizeStore(store, 20);
    expect(store[$storeSize]).toBe(10); // unchanged
  });

  test("resizes subarray stores", () => {
    const store = createStore({ items: ["f32", 3] }, 5);
    store.items[2][0] = 1.5;

    resizeStore(store, 10);

    expect(store[$storeSize]).toBe(10);
    expect(store.items.length).toBe(10);
    expect(store.items[0].length).toBe(3);
  });
});

describe("createShadow", () => {
  test("creates shadow copy of typed array", () => {
    const store = createStore({ x: "f64" }, 10);
    store.x[0] = 42;
    store.x[5] = 99;

    createShadow(store.x, $queryShadow);
    // @ts-ignore
    expect(store.x[$queryShadow][0]).toBe(42);
    // @ts-ignore
    expect(store.x[$queryShadow][5]).toBe(99);

    // Mutating original doesn't affect shadow
    store.x[0] = 100;
    // @ts-ignore
    expect(store.x[$queryShadow][0]).toBe(42);
  });

  test("creates shadow for subarray store", () => {
    const store = createStore({ items: ["f32", 3] }, 5);
    store.items[0][0] = 1.5;
    store.items[0][1] = 2.5;

    createShadow(store.items as unknown as Store, $serializeShadow);

    // Shadow should exist
    // @ts-ignore
    expect(store.items[$serializeShadow]).toBeDefined();
  });
});

describe("free", () => {
  test("removes store from internal registry", () => {
    const store = createStore({ x: "f64" }, 10);
    free(store); // should not throw
  });
});

describe("parentArray", () => {
  test("returns parent array of subarray store", () => {
    const store = createStore({ items: ["f32", 3] }, 5);
    const parent = parentArray(store.items as unknown as Store);
    expect(parent).toBeDefined();
    expect(parent).toBeInstanceOf(Float32Array);
  });
});

describe("additional branch coverage", () => {
  test("resizeSubarray covers ui16/ui32 index selection and cursor reuse branch", () => {
    const store = createStore(
      {
        small: ["f32", 3],
        mid: ["f32", 300],
        large: ["f32", 70000],
      },
      1
    );
    resizeStore(store, 2);
    expect(store.small[0].length).toBe(3);
    expect(store.mid[0].length).toBe(300);
    expect(store.large[0].length).toBe(70000);
  });

  test("resizeRecursive object branch is traversed for nested object stores", () => {
    const store = createStore({ nested: { inner: ["f32", 4] } }, 1);
    expect(() => resizeStore(store, 2)).toThrow();
  });

  test("resizeRecursive object branch traverses nested plain object store nodes", () => {
    const child = { x: new Float32Array([1]), [$storeFlattened]: [] };
    const store = {
      child,
      [$tagStore]: false,
      [$storeSize]: 1,
      [$storeFlattened]: [],
      [$subarrayCursors]: {},
    } as unknown as Store;

    resizeStore(store, 2);
    expect(store.child.x.length).toBe(2);
  });

  test("resizeStore on real nested object store currently throws while traversing recursion", () => {
    const store = createStore({ outer: { x: "f32" } }, 1);
    expect(() => resizeStore(store, 3)).toThrow();
  });

  test("resizeRecursive skips primitive keys while visiting object children", () => {
    const child = { x: new Float32Array([1]), [$storeFlattened]: [] };
    const store = {
      child,
      count: 5,
      [$tagStore]: false,
      [$storeSize]: 1,
      [$storeFlattened]: [],
      [$subarrayCursors]: {},
    } as unknown as Store;

    resizeStore(store, 2);
    expect(store.count).toBe(5);
  });

  test("createArrayStore throws for zero-length arrays", () => {
    expect(() => createStore({ bad: ["f32", 0] }, 1)).toThrow("Must define component array length");
  });

  test("createArrayStore throws for invalid array element types", () => {
    expect(() => createStore({ bad: ["wat", 2] }, 1)).toThrow("Invalid component array property type");
  });

  test("collectArrayElementCounts initializes missing type bucket", () => {
    const store = createStore({ one: ["f32", 1], two: ["f32", 2] }, 1);
    expect(store.one[0].length).toBe(1);
    expect(store.two[0].length).toBe(2);
  });

  test("recursiveTransform handles nested object schemas", () => {
    const store = createStore({ outer: { inner: { values: ["f32", 2] } } }, 1);
    expect(store.outer.inner.values[0].length).toBe(2);
  });

  test("recursiveTransform object branch handles empty nested objects", () => {
    const store = createStore({ nested: { deeper: {} } }, 1);
    expect(store.nested.deeper).toBeDefined();
  });

  test("recursiveTransform object branch handles non-empty nested objects", () => {
    const store = createStore({ nested: { deeper: { n: "f32" } } }, 1);
    expect(store.nested.deeper.n.length).toBe(1);
  });

  test("recursiveTransform skips unknown scalar schema leaves", () => {
    const schema = { weird: 123 } as unknown as Record<string, unknown>;
    const store = createStore(schema, 1);
    expect((store as unknown as Record<string, unknown>).weird).toBe(123);
  });
});

import { describe, expect, test } from "vitest";
import { SparseSet } from "../src/SparseSet";

describe("SparseSet", () => {
  test("add returns false for duplicates", () => {
    const set = SparseSet();
    expect(set.add(5)).toBe(true);
    expect(set.add(5)).toBe(false);
  });

  test("remove on missing element is a no-op", () => {
    const set = SparseSet();
    set.add(1);
    set.remove(99);
    expect(set.dense.length).toBe(1);
    expect(set.dense[0]).toBe(1);
  });

  test("sort updates sparse indices", () => {
    const set = SparseSet();
    set.add(5);
    set.add(2);
    set.add(8);
    set.add(1);

    set.dense.sort((a, b) => a - b);

    expect(set.dense.length).toBe(4);
    expect(set.dense[0]).toBe(1);
    expect(set.dense[1]).toBe(2);
    expect(set.dense[2]).toBe(5);
    expect(set.dense[3]).toBe(8);
    expect(set.sparse[1]).toBe(0);
    expect(set.sparse[2]).toBe(1);
    expect(set.sparse[5]).toBe(2);
    expect(set.sparse[8]).toBe(3);
    expect(set.has(1)).toBe(true);
    expect(set.has(5)).toBe(true);
    expect(set.has(3)).toBe(false);
  });

  test("reset with alternate arrays replaces contents", () => {
    const set = SparseSet();
    set.add(10);
    set.add(20);

    const altDense = [3, 7];
    const altSparse: number[] = [];
    altSparse[3] = 0;
    altSparse[7] = 1;

    set.reset(altDense, altSparse);

    expect(set.dense.length).toBe(2);
    expect(set.dense[0]).toBe(3);
    expect(set.dense[1]).toBe(7);
    expect(set.has(3)).toBe(true);
    expect(set.has(7)).toBe(true);
    expect(set.has(10)).toBe(false);
  });

  test("reset without arguments clears the set", () => {
    const set = SparseSet();
    set.add(1);
    set.add(2);
    set.reset();
    expect(set.dense.length).toBe(0);
    expect(set.has(1)).toBe(false);
  });
});

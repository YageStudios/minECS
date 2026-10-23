const isIndex = (val: unknown): val is number => typeof val === "number" && val >= 0 && Number.isInteger(val);

const $owner = Symbol("sparseSetOwner");

// One shared sort override for every set (instead of a fresh closure per set). Sorting `dense` in place
// is supported public behaviour, so the sparse index is rebuilt afterwards.
function sortDense(this: number[], comparator?: (a: number, b: number) => number) {
  const result = Array.prototype.sort.call(this, comparator);
  ((this as any)[$owner] as SparseSetImpl).reindex();
  return result;
}

export class SparseSetImpl {
  dense: number[];
  // Typed sparse index: never falls into dictionary mode for large / late entity ids and
  // zero-initialised slots are safe because membership is confirmed through `dense`.
  sparse: Uint32Array;

  constructor(initialSize = 0) {
    const dense: number[] = [];
    (dense as any)[$owner] = this;
    dense.sort = sortDense as any;
    this.dense = dense;
    this.sparse = new Uint32Array(initialSize);
  }

  private grow(val: number) {
    const next = new Uint32Array(Math.max(val + 1, this.sparse.length * 2, 8));
    next.set(this.sparse);
    this.sparse = next;
  }

  private setIndex(val: unknown, index: number) {
    if (!isIndex(val)) return;
    if (val >= this.sparse.length) this.grow(val);
    this.sparse[val] = index;
  }

  /** @internal Rebuilds the sparse index from `dense` (after an in-place sort). */
  reindex() {
    const dense = this.dense;
    for (let i = 0; i < dense.length; i++) this.setIndex(dense[i], i);
  }

  has(val: number) {
    return this.dense[this.sparse[val]] === val;
  }

  add(val: number) {
    const dense = this.dense;
    const sparse = this.sparse;
    if (dense[sparse[val]] === val) return false;
    const index = dense.push(val) - 1;
    // Fast path for in-range non-negative integers; anything else goes through the validated path.
    if (val >>> 0 === val && val < sparse.length) sparse[val] = index;
    else this.setIndex(val, index);
    return true;
  }

  remove(val: number) {
    const dense = this.dense;
    const sparse = this.sparse;
    const index = sparse[val];
    if (dense[index] !== val) return;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const swapped = dense.pop()!;
    if (swapped !== val) {
      dense[index] = swapped;
      sparse[swapped] = index;
    }
  }

  // `altSparse` is accepted for backwards compatibility; the index is always rebuilt from `altDense`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reset(altDense?: number[], altSparse?: ArrayLike<number>) {
    const dense = this.dense;
    dense.length = 0;
    if (altDense) {
      const length = altDense.length;
      let max = -1;
      for (let i = 0; i < length; i++) {
        const val = altDense[i];
        if (val > max) max = val;
      }
      if (max >= this.sparse.length) this.grow(max);
      const sparse = this.sparse;
      for (let i = 0; i < length; i++) {
        const val = altDense[i];
        dense.push(val);
        if (val >>> 0 === val) sparse[val] = i;
        else this.setIndex(val, i);
      }
    }
  }
}

export const SparseSet = (initialSize = 0) => new SparseSetImpl(initialSize);

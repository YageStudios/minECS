const isIndex = (val: unknown): val is number => typeof val === "number" && val >= 0 && Number.isInteger(val);

export const SparseSet = (initialSize = 0) => {
  const dense: number[] = [];
  // Typed sparse index: never falls into dictionary mode for large / late entity ids and
  // zero-initialised slots are safe because membership is confirmed through `dense`.
  let sparse = new Uint32Array(initialSize);

  const grow = (val: number) => {
    const next = new Uint32Array(Math.max(val + 1, sparse.length * 2, 8));
    next.set(sparse);
    sparse = next;
    set.sparse = next;
  };

  const setIndex = (val: unknown, index: number) => {
    if (!isIndex(val)) return;
    if (val >= sparse.length) grow(val);
    sparse[val] = index;
  };

  dense.sort = function (comparator) {
    const result = Array.prototype.sort.call(this, comparator);

    for (let i = 0; i < dense.length; i++) {
      setIndex(dense[i], i);
    }

    return result;
  };

  const has = (val: number) => dense[sparse[val]] === val;

  const add = (val: number) => {
    if (dense[sparse[val]] === val) return false;
    const index = dense.push(val) - 1;
    // Fast path for in-range non-negative integers; anything else goes through the validated path.
    if ((val >>> 0) === val && val < sparse.length) sparse[val] = index;
    else setIndex(val, index);
    return true;
  };

  const remove = (val: number) => {
    if (!has(val)) return;
    const index = sparse[val];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const swapped = dense.pop()!;
    if (swapped !== val) {
      dense[index] = swapped;
      sparse[swapped] = index;
    }
  };

  // `altSparse` is accepted for backwards compatibility; the index is always rebuilt from `altDense`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const reset = (altDense?: number[], altSparse?: ArrayLike<number>) => {
    dense.length = 0;
    if (altDense) {
      for (let i = 0; i < altDense.length; i++) {
        const val = altDense[i];
        dense.push(val);
        setIndex(val, i);
      }
    }
  };

  const set = {
    add,
    remove,
    has,
    sparse,
    dense,
    reset,
  };

  return set;
};

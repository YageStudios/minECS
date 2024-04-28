export const SparseSet = () => {
  const dense: number[] = [];
  const sparse: number[] = [];

  dense.sort = function (comparator) {
    const result = Array.prototype.sort.call(this, comparator);

    for (let i = 0; i < dense.length; i++) {
      sparse[dense[i]] = i;
    }

    return result;
  };

  const has = (val: number) => dense[sparse[val]] === val;

  const add = (val: number) => {
    if (has(val)) return false;
    sparse[val] = dense.push(val) - 1;
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

  const reset = (altDense?: number[], altSparse?: number[]) => {
    if (altDense && altSparse) {
      dense.splice(0, dense.length, ...altDense);
      sparse.splice(0, sparse.length, ...altSparse);
    } else {
      dense.length = 0;
      sparse.length = 0;
    }
  };

  return {
    add,
    remove,
    has,
    sparse,
    dense,
    reset,
  };
};

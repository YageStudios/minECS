/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { Query, QueryInstance, World } from "./Types";
import { SparseSet } from "./SparseSet";
import type { Schema } from "./Schema";
import { getEntityCursor } from "./World";

/****************************************************
 *
 * Query
 *
 ****************************************************/

export const queryMap = new Map<string, QueryInstance>();

export const defineQuery = (components: (typeof Schema)[]) => {
  const $query = components
    .map((c) => c.type)
    .sort()
    .join("|");
  if (queryMap.has($query)) return queryMap.get($query)!;

  const createQuery = (world: World) => {
    const querySet = SparseSet();
    const mapComponents = (c: typeof Schema) => world["componentMap"].get(c)!;

    const generations = components
      .map(mapComponents)
      .map((c) => c.generationId)
      .reduce((a, v) => {
        if (a.includes(v)) return a;
        a.push(v);
        return a;
      }, [] as number[]);

    const reduceBitflags = (
      a: {
        [key: number]: number;
      },
      c: {
        generationId: number;
        bitflag: number;
      }
    ) => {
      if (!a[c.generationId]) a[c.generationId] = 0;
      a[c.generationId] |= c.bitflag;
      return a;
    };
    const masks = components.map(mapComponents).reduce(reduceBitflags, {});

    const query = Object.assign(querySet, {
      generations,
      masks,
      toRemove: SparseSet(),
      entered: SparseSet(),
      queryKey: $query,
    });
    world["queryMap"].set($query, query);
    world.queries.add(query);

    components.map(mapComponents).forEach((c) => {
      c.queries.push(query);
    });

    for (let eid = 0; eid < getEntityCursor(world); eid++) {
      if (!world["entitySparseSet"].has(eid)) continue;
      const match = queryCheckEntity(world, query, eid);
      if (match) queryAddEntity(query, eid);
    }

    return query;
  };

  const q = (world: World) => {
    if (!world["queryMap"].has($query)) {
      world["queryMap"].set($query, createQuery(world));
    }
    const q = world["queryMap"].get($query)!;

    commitRemovals(world);

    return q.dense;
  };

  const queryFunc = Object.assign(q, {
    has: (world: World, eid: number) => world["queryMap"].get($query)?.has(eid) ?? false,
  });

  queryMap.set($query, queryFunc);

  return queryFunc;
};

const queryCommitRemovals = (q: Query) => {
  for (let i = q.toRemove.dense.length - 1; i >= 0; i--) {
    const eid = q.toRemove.dense[i];
    q.toRemove.remove(eid);
    q.remove(eid);
  }
};

export const commitRemovals = (world: World) => {
  if (!world["dirtyQueries"].size) return;
  world["dirtyQueries"].forEach(queryCommitRemovals);
  world["dirtyQueries"].clear();
};

export const queryRemoveEntity = (world: World, q: Query, eid: number): boolean => {
  if (!q.has(eid) || q.toRemove.has(eid)) return false;
  q.toRemove.add(eid);
  world["dirtyQueries"].add(q);
  return true;
};

export const queryAddEntity = (q: Query, eid: number) => {
  q.toRemove.remove(eid);
  // if (!q.has(eid))
  q.entered.add(eid);
  return q.add(eid);
};

export const queryCheckEntity = (world: World, q: Query, eid: number) => {
  const { masks, generations } = q;
  for (let i = 0; i < generations.length; i++) {
    const generationId = generations[i];
    const qMask = masks[generationId];
    const eMask = world["entityMasks"][generationId][eid];

    // all
    if (qMask && (eMask & qMask) !== qMask) {
      return false;
    }
  }
  return true;
};

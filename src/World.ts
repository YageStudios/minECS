/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { Store } from "./Storage";
import { $fauxStore, $parentArray, $storeFlattened, free } from "./Storage";
import type { Constructor, Query, ReadOnlyWorld, World, WorldComponent } from "./Types";
import { SparseSet } from "./SparseSet";
import type { Schema } from "./Schema";
import { componentList, freezeComponentOrder } from "./Component";
import { $queryOrder, queryRemoveEntity, queryCheckEntity, queryAddEntity, defineQuery } from "./Query";
import type { DrawSystemImpl, SystemImpl } from "./System";
import {
  $boundQuery,
  $boundWorld,
  $originalRunAll,
  drawSystemRunList,
  systemEntities,
  systemManualList,
  systemRunList,
} from "./System";
import type { DeltaDirtyState, DeltaHolder, DirtyBucket } from "./DeltaTracking";
import { getDeltaHolder, getDirtyBucket, markBucket } from "./DeltaTracking";
import { $bitTable, $capacity, $drawSystems, $reuseThreshold, $stepSystems, WORLD_INTERNAL_SLOTS } from "./Internal";

const removedReuseThreshold = 0.01;

/** Recomputes the cached removed-id reuse threshold; call whenever `world.size` changes. */
export const updateReuseThreshold = (world: World) => {
  (world as any)[$reuseThreshold] = Math.round(world.size * removedReuseThreshold);
};

// Internal (symbol-keyed) caches kept off the public World / WorldComponent shapes.
const $eid = Symbol("eid");
const $accessors = Symbol("accessors");
const $ctx = Symbol("ctx");
const $accessorCtx = Symbol("accessorCtx");
const $accessorCtor = Symbol("accessorCtor");
const $defaults = Symbol("defaults");
const $resetColumns = Symbol("resetColumns");
const $writeTargets = Symbol("writeTargets");

/**
 * Pre-seeds the lazily-populated per-component caches so every WorldComponent shares one
 * hidden class regardless of which cache gets filled first (keeps `world(...)` lookups monomorphic).
 */
export const prepareWorldComponent = (worldComponent: WorldComponent): WorldComponent => {
  const wc = worldComponent as any;
  wc[$accessors] = null;
  wc[$accessorCtx] = null;
  wc[$defaults] = undefined;
  wc[$resetColumns] = null;
  wc[$writeTargets] = null;
  return worldComponent;
};

/**
 * Resolves a schema to its WorldComponent. Tries the index-addressed componentList first (an array
 * read) and falls back to the componentMap for late-registered or duplicate-named schemas.
 */
const lookupComponent = (world: World, schema: typeof Schema): WorldComponent | undefined => {
  if (schema == null) return undefined;
  const c = world.componentList[schema.index];
  if (c !== undefined && c.schema === schema) return c;
  return world.componentMap.get(schema);
};

export const addEntity = (world: World) => {
  const removed = world.removed;
  let eid: number;
  // Recycle once enough ids are free, or whenever the fresh range is used up.
  if (removed.length > (world as any)[$reuseThreshold] || (removed.length && world.entityCursor >= world.size)) {
    eid = removed.pop()!;
  } else {
    eid = world.entityCursor;
    // Masks and columns hold ids 0..size-1; id `size` could not store any component.
    if (eid >= world["size"]) throw new Error("minECS - max entities reached");
    world.entityCursor = eid + 1;
  }

  world["entitySparseSet"].add(eid);

  return eid;
};

// Runs cleanup hooks for groups of systems in reverse group order (matches the historical
// `removeSystems.unshift(...systems)` semantics without re-copying the array on every match).
const runCleanupGroups = (world: World, groups: SystemImpl[][], eid: number) => {
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const systems = groups[gi];
    for (let si = 0; si < systems.length; si++) {
      systems[si].cleanup?.(world, eid);
    }
  }
};

/**
 * Rebuilds the [generationId][bitIndex] -> WorldComponent lookup used by removeEntity.
 * Called whenever componentMap is (re)built.
 */
export const rebuildComponentBitTable = (world: World) => {
  const table: WorldComponent[][] = [];
  world.componentMap.forEach((c) => {
    const row = table[c.generationId] || (table[c.generationId] = []);
    row[31 - Math.clz32(c.bitflag)] = c;
  });
  (world as any)[$bitTable] = table;
  return table;
};

const hasCleanupSystem = (systems: SystemImpl[]) => {
  for (let i = 0; i < systems.length; i++) if (systems[i].cleanup) return true;
  return false;
};

const byQueryOrder = (a: Query, b: Query) =>
  ((a as any)[$queryOrder] ?? Infinity) - ((b as any)[$queryOrder] ?? Infinity);

// Scratch arrays for removeEntity, one per re-entrancy depth (cleanup hooks may remove entities).
const removeScratch: Query[][] = [];
let removeDepth = 0;
// Bumped whenever addComponent/removeComponent leaves an entity matching a query, so removeEntity can
// tell whether its cleanup hooks put this entity back into any query.
let membershipEpoch = 0;

export const removeEntity = (world: World, eid: number) => {
  // Check if entity is already removed
  if (!world.entitySparseSet.has(eid)) return;

  // Remove entity from the queries of the components this entity actually has
  // (instead of scanning every query in the world).
  const systemQueryMap = world.systemQueryMap;
  const masks = world.entityMasks;
  const table: WorldComponent[][] = (world as any)[$bitTable] ?? rebuildComponentBitTable(world);
  // Only queries that have a cleanup system attached need ordering and dispatch.
  const cleanupQueries = removeScratch[removeDepth] || (removeScratch[removeDepth] = []);
  removeDepth++;

  try {
    for (;;) {
      for (let g = 0; g < masks.length; g++) {
        let mask = masks[g][eid];
        const row = table[g];
        while (mask) {
          const low = mask & -mask;
          mask ^= low;
          const c = row?.[31 - Math.clz32(low)];
          if (!c) continue;
          const queries = c.queries;
          for (let qi = 0; qi < queries.length; qi++) {
            const q = queries[qi];
            if (queryRemoveEntity(world, q, eid)) {
              const systems = systemQueryMap.get(q.queryKey);
              if (systems !== undefined && hasCleanupSystem(systems)) cleanupQueries.push(q);
            }
          }
        }
      }

      const count = cleanupQueries.length;
      if (!count) break;
      const epoch = membershipEpoch;
      // Preserve historical cleanup order: queries in world creation order, groups run in reverse.
      if (count > 1) cleanupQueries.sort(byQueryOrder);
      for (let gi = count - 1; gi >= 0; gi--) {
        const systems = systemQueryMap.get(cleanupQueries[gi].queryKey)!;
        for (let si = 0; si < systems.length; si++) {
          systems[si].cleanup?.(world, eid);
        }
      }
      cleanupQueries.length = 0;
      // A cleanup hook removed this entity itself, so it is already freed.
      if (!world.entitySparseSet.has(eid)) return;
      // Cleanup hooks added this entity (or another) to a query: leave those queries too.
      if (epoch === membershipEpoch) break;
    }
  } finally {
    cleanupQueries.length = 0;
    removeDepth--;
  }

  // Free the entity
  world.removed.push(eid);

  // remove all eid state from world
  world.entitySparseSet.remove(eid);

  // Clear entity bitmasks
  for (let i = 0; i < masks.length; i++) masks[i][eid] = 0;
};

export const entityExists = (world: World, eid: number) => world["entitySparseSet"].has(eid);

type ComponentInput<T> = {
  [K in keyof T]?: T[K] extends ArrayBufferView ? T[K] | number[] : T[K];
};

type DefaultEntry = [key: string, value: any, needsClone: boolean, column: any, isSubarray: boolean];

const cloneDefault = (value: any): any => {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneDefault(value[i]);
    return out;
  }
  if (value && typeof value === "object") {
    const out: any = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = cloneDefault(value[keys[i]]);
    return out;
  }
  return value;
};

/**
 * Precomputes the defaults Ajv would apply to an empty override object. Returns null when the
 * schema cannot accept `{}` (required keys without defaults), in which case Ajv must run.
 */
const getComponentDefaults = (c: WorldComponent): DefaultEntry[] | null => {
  const cached = (c as any)[$defaults];
  if (cached !== undefined) return cached;

  const schema = c.schema;
  let entries: DefaultEntry[] | null = null;
  const probe: { [key: string]: any } = {};
  if (schema.validate(probe)) {
    entries = [];
    const keys = Object.keys(probe);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "type") continue;
      const value = probe[key];
      const column = (c.store as any)[key];
      entries.push([key, value, value !== null && typeof value === "object", column, !!column[$parentArray]]);
    }
  }
  (c as any)[$defaults] = entries;
  return entries;
};

/**
 * Columns addComponent must zero before writing. Scalar typed columns whose schema property has a
 * default are skipped: both the precomputed-defaults path and Ajv (useDefaults) always write them.
 */
const getResetColumns = (c: WorldComponent): any[] => {
  const cached = (c as any)[$resetColumns];
  if (cached) return cached;
  const store = c.store as Store;
  const flattened: any[] = store[$storeFlattened] || [];
  const properties = c.schema.schema ? c.schema.schema.properties || {} : {};
  const covered = new Set<any>();
  const keys = Object.keys(store);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const column = (store as any)[key];
    const prop = properties[key];
    if (ArrayBuffer.isView(column) && prop && prop.default !== undefined) covered.add(column);
  }
  const columns = flattened.filter((column) => !covered.has(column));
  (c as any)[$resetColumns] = columns;
  return columns;
};

const resetColumnsFor = (columns: any[], eid: number) => {
  for (let i = 0; i < columns.length; i++) {
    const ta = columns[i];
    if (ta[$fauxStore]) ta[eid] = undefined;
    else if (ArrayBuffer.isView(ta)) (ta as any)[eid] = 0;
    else ta[eid].fill(0);
  }
};

const hasOwnKeys = (obj: object) => {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  }
  return false;
};

const markComponentDirty = (state: DeltaDirtyState, world: World, store: Store, eid: number) => {
  const flattened = store[$storeFlattened];
  if (flattened.length) {
    for (let i = 0; i < flattened.length; i++) {
      markBucket(getDirtyBucket(state, world, flattened[i]), eid);
    }
  } else {
    markBucket(getDirtyBucket(state, world, store), eid);
  }
};

/** `toArray`: the field's schema is an array, so a typed-array override is passed to Ajv as a plain array. */
type WritePlan = { keys: string[]; cols: any[]; sub: boolean[]; toArray: boolean[] };

const isArraySchema = (property: any) => {
  const t = property?.type;
  return t === "array" || (Array.isArray(t) && t.includes("array"));
};

/** The component's writable keys with their columns, so the override path never does keyed store lookups. */
const getWritePlan = (c: WorldComponent): WritePlan => {
  const cached = (c as any)[$writeTargets];
  if (cached) return cached;
  const plan: WritePlan = { keys: [], cols: [], sub: [], toArray: [] };
  const properties = (c.schema as any).schema?.properties ?? {};
  const store = c.store as any;
  const keys = Object.keys(store);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === "type") continue;
    const column = store[key];
    plan.keys.push(key);
    plan.cols.push(column);
    plan.sub.push(!!column[$parentArray]);
    plan.toArray.push(!!column[$parentArray] || isArraySchema(properties[key]));
  }
  (c as any)[$writeTargets] = plan;
  return plan;
};

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * The object addComponent validates and writes from. Overrides are used as given (Ajv fills defaults
 * into them, as it always has); values are read like Ajv reads them, so getters and inherited values
 * count. A private plain copy is used where writing into the given object is unsafe: typed-array
 * values of array fields (converted to arrays so the array schema accepts them; an object field
 * keeps the typed array it was given), toJSON values on non-plain or
 * non-extensible objects (e.g. another world's accessor, whose setters would write through) and
 * frozen/sealed objects that need defaults (see addComponent). Returns null when there is nothing
 * to override.
 */
const resolveOverrides = (c: WorldComponent, overrides: any): { [key: string]: any } | null => {
  if (!hasOwnKeys(overrides)) return null;
  if (typeof overrides !== "object") return overrides;
  const plan = getWritePlan(c);
  const keys = plan.keys;
  for (let i = 0; i < keys.length; i++) {
    const value = overrides[keys[i]];
    if (typeof value !== "object" || value === null) continue;
    if (ArrayBuffer.isView(value)) {
      if (plan.toArray[i]) return copyOverrides(overrides, plan);
      continue;
    }
    if (typeof value.toJSON === "function") {
      if (!isPlainExtensible(overrides)) return copyOverrides(overrides, plan);
      // toJSON values are stored as their JSON form.
      overrides[keys[i]] = value.toJSON();
    }
  }
  return overrides;
};

const isPlainExtensible = (obj: object) => {
  const proto = Object.getPrototypeOf(obj);
  return (proto === Object.prototype || proto === null) && Object.isExtensible(obj);
};

const copyOverrides = (overrides: any, { keys, toArray }: WritePlan) => {
  const input: { [key: string]: any } = {};
  // Own enumerable keys first, so unknown keys still fail validation.
  const own = Object.keys(overrides);
  for (let i = 0; i < own.length; i++) input[own[i]] = overrides[own[i]];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let value = input[key];
    if (value === undefined && !hasOwn.call(input, key)) {
      value = overrides[key];
      if (value === undefined) continue;
    }
    if (typeof value === "object" && value !== null) {
      if (ArrayBuffer.isView(value)) {
        if (toArray[i]) value = Array.from(value as any);
      } else if (typeof value.toJSON === "function") value = value.toJSON();
    }
    input[key] = value;
  }
  return input;
};

export function addComponent<T>(
  world: World,
  component: Constructor<T>,
  eid: number,
  overrides?: ComponentInput<T>,
  reset?: boolean,
) {
  const schema = component as unknown as typeof Schema;

  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world.entitySparseSet.has(eid)) throw new Error("minECS - entity does not exist in the world.");
  let c = lookupComponent(world, schema);
  if (c === undefined) {
    registerComponent(world, schema);
    c = world.componentMap.get(schema)!;
  }
  const { generationId, bitflag, queries, store } = c;
  const entityMasks = world.entityMasks[generationId];
  if ((entityMasks[eid] & bitflag) === bitflag) return;

  // Validate before touching any state: an invalid override must leave the entity unchanged.
  let input = overrides ? resolveOverrides(c, overrides) : null;
  const defaults = input === null ? getComponentDefaults(c) : null;
  if (input === null) {
    // No defaults means the schema rejects `{}` (a required key without a default): the usual error.
    if (defaults === null) validateComponent(schema, eid, {});
  } else if (!tryValidate(schema, input)) {
    // Ajv cannot fill defaults into a frozen or sealed object: validate a plain copy instead.
    if (input === overrides && typeof input === "object" && !Object.isExtensible(input)) {
      input = copyOverrides(input, getWritePlan(c));
    }
    validateComponent(schema, eid, input);
  }

  // Zero out each property value
  if (reset !== false) {
    resetColumnsFor(getResetColumns(c), eid);
  }

  if (defaults !== null) {
    // Fast path: no overrides to validate, apply precomputed defaults directly.
    for (let i = 0; i < defaults.length; i++) {
      const entry = defaults[i];
      const value = entry[2] ? cloneDefault(entry[1]) : entry[1];
      if (entry[4]) (entry[3][eid] as Float32Array).set(value);
      else entry[3][eid] = value;
    }
  } else if (input !== null) {
    // Ajv has applied defaults in place. A key that is absent has no default and keeps its reset
    // value; an explicit `undefined` is written as given (a fixed-length array keeps its reset value).
    const { keys, cols, sub } = getWritePlan(c);
    for (let i = 0; i < keys.length; i++) {
      const value = input[keys[i]];
      if (value === undefined && (sub[i] || !hasOwn.call(input, keys[i]))) continue;
      if (sub[i]) (cols[i][eid] as Float32Array).set(value);
      else cols[i][eid] = value;
    }
  }

  // Add bitflag to entity bitmask (after the writes: a write that throws leaves no half-added component)
  entityMasks[eid] |= bitflag;

  const deltaState = getDeltaHolder(world).state;

  // Mark all component properties dirty so delta serializers include newly added components.
  if (deltaState) markComponentDirty(deltaState, world, store, eid);

  const systemQueryMap = world.systemQueryMap;
  let cleanupGroups: SystemImpl[][] | null = null;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    // remove this entity from toRemove if it exists in this query
    q.toRemove.remove(eid);
    const match = queryCheckEntity(world, q, eid);
    if (match) {
      // Counts re-joins too: re-adding cancels a pending (deferred) removal without a fresh insert.
      membershipEpoch++;
      if (queryAddEntity(q, eid)) {
        const systems = systemQueryMap.get(q.queryKey);
        if (systems) {
          for (let si = 0; si < systems.length; si++) {
            systems[si].init?.(world, eid);
          }
        }
      }
    } else if (queryRemoveEntity(world, q, eid)) {
      const systems = systemQueryMap.get(q.queryKey);
      if (systems !== undefined && hasCleanupSystem(systems)) (cleanupGroups ||= []).push(systems);
    }
  }

  if (cleanupGroups) runCleanupGroups(world, cleanupGroups, eid);
}

const tryValidate = (schema: typeof Schema, overrides: { [key: string]: any }) => {
  try {
    return schema.validate(overrides) as boolean;
  } catch {
    // e.g. a strict-mode default assignment into a frozen object
    return false;
  }
};

const validateComponent = (schema: typeof Schema, entity: number, overrides: { [key: string]: any }) => {
  if (!tryValidate(schema, overrides)) {
    throw {
      overrides,
      schema: schema.schema,
      errors: schema.validate.errors,
      error: new Error(`Invalid schema for component ${schema.type} on entity ${entity}`),
    };
  }
};

export const disableComponent = (world: World, component: typeof Schema, eid: number) => {
  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world.entitySparseSet.has(eid)) throw new Error("minECS - entity does not exist in the world.");
  const c = lookupComponent(world, component);
  if (c === undefined) return;
  const masks = world.entityMasks[c.generationId];
  const bitflag = c.bitflag;
  if ((masks[eid] & bitflag) !== bitflag) return;

  // Remove flag from entity bitmask
  masks[eid] &= ~bitflag;
};

export const removeComponent = (world: World, component: typeof Schema, eid: number) => {
  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world.entitySparseSet.has(eid)) throw new Error("minECS - entity does not exist in the world.");
  const c = lookupComponent(world, component);
  if (c === undefined) return;
  const { generationId, bitflag, queries, store } = c;
  const entityMasks = world.entityMasks[generationId];
  if ((entityMasks[eid] & bitflag) !== bitflag) return;

  // The cached accessor stays: it is bound only to (component, eid), so it is reused when the
  // component is re-added or the eid is recycled instead of being rebuilt.
  const deltaState = getDeltaHolder(world).state;

  // Track membership removals for delta serializers.
  if (deltaState) markComponentDirty(deltaState, world, store, eid);

  // Remove flag from entity bitmask
  entityMasks[eid] &= ~bitflag;

  const systemQueryMap = world.systemQueryMap;
  let cleanupGroups: SystemImpl[][] | null = null;

  // todo: archetype graph
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    // remove this entity from toRemove if it exists in this query
    q.toRemove.remove(eid);
    const match = queryCheckEntity(world, q, eid);
    if (match) {
      // Counts re-joins too: re-adding cancels a pending (deferred) removal without a fresh insert.
      membershipEpoch++;
      if (queryAddEntity(q, eid)) {
        const systems = systemQueryMap.get(q.queryKey);
        if (systems) {
          for (let si = 0; si < systems.length; si++) {
            systems[si].init?.(world, eid);
          }
        }
      }
    } else if (queryRemoveEntity(world, q, eid)) {
      const systems = systemQueryMap.get(q.queryKey);
      if (systems !== undefined && hasCleanupSystem(systems)) (cleanupGroups ||= []).push(systems);
    }
  }

  if (cleanupGroups) runCleanupGroups(world, cleanupGroups, eid);
};

/****************************************************
 *
 * Component accessors
 *
 * `world(Component, eid)` returns a small object with one own, enumerable accessor property per field
 * (plus `type`), reading and writing straight into the column stores. Spread / Object.keys /
 * JSON.stringify see all fields.
 *
 * The accessor class (constructor, private prototype, getter/setter functions) is built once per
 * schema and shared by every world: getters find their world's columns through a hidden per-object
 * context instead of closing over them. All accessors of a component therefore share one hidden
 * class across worlds, so `world(C, eid).x` stays monomorphic in programs that create several
 * worlds (rooms, reconnects, tests); with a class per world, call sites went megamorphic after the
 * fourth world and field access got ~5x slower.
 *
 ****************************************************/

/**
 * What shared-class accessors hold in their hidden `$ctx` property: the world's columns as named
 * fields `c0..cN` plus the AccessorContext, so a field read is `this[$ctx].c0[eid]` and only writes
 * reach the tracking state.
 */
type Slots = { ctx: AccessorContext; [column: string]: any };

/** Per world-component state for the shared accessor functions. */
type AccessorContext = {
  cols: any[];
  slots: Slots;
  tracking: DeltaHolder;
  world: World;
  // Dirty bucket per column, cached per tracking state (one Map lookup per state, not per write).
  buckets: (DirtyBucket | null)[];
  bucketStates: (DeltaDirtyState | undefined)[];
};

type AccessorObject = { [$eid]: number; [$ctx]: Slots; [key: string]: any };
type AccessorCtor = {
  new (eid: number, slots: Slots | null): AccessorObject;
  keys: string[];
  snapshot: Snapshotter | null;
};

const ColumnKind = { Scalar: 0, Subarray: 1, Faux: 2 } as const;
type ColumnKind = (typeof ColumnKind)[keyof typeof ColumnKind];

const columnKind = (column: any): ColumnKind =>
  ArrayBuffer.isView(column)
    ? ColumnKind.Scalar
    : Array.isArray(column) && (column as any)[$parentArray]
      ? ColumnKind.Subarray
      : ColumnKind.Faux;

const markCtxDirty = (ctx: AccessorContext, i: number, state: DeltaDirtyState, eid: number) => {
  let bucket = ctx.buckets[i];
  if (ctx.bucketStates[i] !== state) {
    bucket = ctx.buckets[i] = getDirtyBucket(state, ctx.world, ctx.cols[i]);
    ctx.bucketStates[i] = state;
  }
  markBucket(bucket!, eid);
};

const buildAccessorDescriptor = (i: number, kind: ColumnKind, isBoolean: boolean): PropertyDescriptor => {
  // Constant per getter, so inlined reads become a plain named-field load on the slots object.
  const name = `c${i}`;
  if (kind === ColumnKind.Scalar) {
    // Scalar typed-array column (number / typed number / boolean).
    return {
      enumerable: true,
      configurable: false,
      get: isBoolean
        ? function (this: AccessorObject) {
            return !!this[$ctx][name][this[$eid]];
          }
        : function (this: AccessorObject) {
            return this[$ctx][name][this[$eid]];
          },
      set: function (this: AccessorObject, value: any) {
        const eid = this[$eid];
        const slots = this[$ctx];
        const ctx: AccessorContext = slots.ctx;
        slots[name][eid] = value;
        const state = ctx.tracking.state;
        if (state !== undefined) markCtxDirty(ctx, i, state, eid);
      },
    };
  }

  if (kind === ColumnKind.Subarray) {
    // Fixed-length typed array column: expose the per-eid subarray, copy on assignment.
    return {
      enumerable: true,
      configurable: false,
      get: function (this: AccessorObject) {
        const eid = this[$eid];
        const slots = this[$ctx];
        const ctx: AccessorContext = slots.ctx;
        // Mutations to the returned view bypass the setter, so mark dirty preemptively.
        const state = ctx.tracking.state;
        if (state !== undefined) markCtxDirty(ctx, i, state, eid);
        return slots[name][eid];
      },
      set: function (this: AccessorObject, value: any) {
        const eid = this[$eid];
        const slots = this[$ctx];
        const ctx: AccessorContext = slots.ctx;
        slots[name][eid].set(value);
        const state = ctx.tracking.state;
        if (state !== undefined) markCtxDirty(ctx, i, state, eid);
      },
    };
  }

  // Faux (string/object/array/nullable) columns and anything else: generic behaviour.
  return {
    enumerable: true,
    configurable: false,
    get: function (this: AccessorObject) {
      const eid = this[$eid];
      const slots = this[$ctx];
      const ctx: AccessorContext = slots.ctx;
      const value = slots[name][eid];
      const state = ctx.tracking.state;
      if (state !== undefined && (ArrayBuffer.isView(value) || (value && typeof value === "object"))) {
        // Mutations to returned views/objects bypass the setter, so mark as dirty preemptively.
        markCtxDirty(ctx, i, state, eid);
      }
      return isBoolean ? !!value : value;
    },
    set: function (this: AccessorObject, value: any) {
      const eid = this[$eid];
      const slots = this[$ctx];
      const ctx: AccessorContext = slots.ctx;
      const col = slots[name];
      if (ArrayBuffer.isView(col[eid])) {
        (col[eid] as unknown as Float32Array).set(value);
      } else {
        col[eid] = value;
      }
      const state = ctx.tracking.state;
      if (state !== undefined) markCtxDirty(ctx, i, state, eid);
    },
  };
};

/**
 * Shared descriptors as freshly compiled functions, one set per schema. Closures created at one
 * source site share a single V8 feedback vector, so closure-built shared getters for every schema
 * would pool their inline-cache feedback (and go megamorphic); compiled ones get their own, keeping
 * `this[$ctx].c0[this[$eid]]` monomorphic. Falls back to closures where code generation is blocked.
 */
const compileSharedDescriptors = (kinds: ColumnKind[], booleans: boolean[]): PropertyDescriptor[] => {
  const src: string[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const c = `c${i}`;
    const mark = `{ const st = s.ctx.tracking.state; if (st !== undefined) mark(s.ctx, ${i}, st, e); }`;
    let get: string;
    let set: string;
    if (kinds[i] === ColumnKind.Scalar) {
      get = `return ${booleans[i] ? "!!" : ""}this[$ctx].${c}[this[$eid]];`;
      set = `const e = this[$eid], s = this[$ctx]; s.${c}[e] = v; ${mark}`;
    } else if (kinds[i] === ColumnKind.Subarray) {
      get = `const e = this[$eid], s = this[$ctx]; ${mark} return s.${c}[e];`;
      set = `const e = this[$eid], s = this[$ctx]; s.${c}[e].set(v); ${mark}`;
    } else {
      get =
        `const e = this[$eid], s = this[$ctx], value = s.${c}[e]; const st = s.ctx.tracking.state; ` +
        `if (st !== undefined && (isView(value) || (value && typeof value === "object"))) mark(s.ctx, ${i}, st, e); ` +
        `return ${booleans[i] ? "!!value" : "value"};`;
      set =
        `const e = this[$eid], s = this[$ctx], col = s.${c}; ` +
        `if (isView(col[e])) col[e].set(v); else col[e] = v; ${mark}`;
    }
    src.push(`{ enumerable: true, configurable: false, get: function () { ${get} }, set: function (v) { ${set} } }`);
  }
  try {
    const factory = new Function("$eid", "$ctx", "mark", "isView", `"use strict"; return [${src.join(", ")}];`);
    return factory($eid, $ctx, markCtxDirty, ArrayBuffer.isView);
  } catch {
    return kinds.map((kind, i) => buildAccessorDescriptor(i, kind, booleans[i]));
  }
};

/**
 * Descriptor whose getter/setter close over one world's column. When inlined, V8 constant-folds the
 * column, which makes these ~3x cheaper per access than the shared (slot-reading) descriptors.
 */
const buildBoundDescriptor = (world: World, column: any, isBoolean: boolean): PropertyDescriptor => {
  const tracking = getDeltaHolder(world);
  const col: any = column;
  // Dirty bucket for this column, cached per tracking state (one Map lookup per state, not per write).
  let bucketState: DeltaDirtyState | undefined = undefined;
  let bucket: DirtyBucket | null = null;
  const markDirty = (state: DeltaDirtyState, eid: number) => {
    if (bucketState !== state) {
      bucket = getDirtyBucket(state, world, col);
      bucketState = state;
    }
    markBucket(bucket!, eid);
  };

  if (ArrayBuffer.isView(column)) {
    // Scalar typed-array column (number / typed number / boolean).
    return {
      enumerable: true,
      configurable: false,
      get: isBoolean
        ? function (this: AccessorObject) {
            return !!col[this[$eid]];
          }
        : function (this: AccessorObject) {
            return col[this[$eid]];
          },
      set: function (this: AccessorObject, value: any) {
        const eid = this[$eid];
        col[eid] = value;
        const state = tracking.state;
        if (state !== undefined) markDirty(state, eid);
      },
    };
  }

  if (Array.isArray(column) && col[$parentArray]) {
    // Fixed-length typed array column: expose the per-eid subarray, copy on assignment.
    return {
      enumerable: true,
      configurable: false,
      get: function (this: AccessorObject) {
        const eid = this[$eid];
        // Mutations to the returned view bypass the setter, so mark dirty preemptively.
        const state = tracking.state;
        if (state !== undefined) markDirty(state, eid);
        return col[eid];
      },
      set: function (this: AccessorObject, value: any) {
        const eid = this[$eid];
        col[eid].set(value);
        const state = tracking.state;
        if (state !== undefined) markDirty(state, eid);
      },
    };
  }

  // Faux (string/object/array/nullable) columns and anything else: generic behaviour.
  return {
    enumerable: true,
    configurable: false,
    get: function (this: AccessorObject) {
      const eid = this[$eid];
      const value = col[eid];
      const state = tracking.state;
      if (state !== undefined && (ArrayBuffer.isView(value) || (value && typeof value === "object"))) {
        // Mutations to returned views/objects bypass the setter, so mark as dirty preemptively.
        markDirty(state, eid);
      }
      return isBoolean ? !!value : value;
    },
    set: function (this: AccessorObject, value: any) {
      const eid = this[$eid];
      if (ArrayBuffer.isView(col[eid])) {
        (col[eid] as unknown as Float32Array).set(value);
      } else {
        col[eid] = value;
      }
      const state = tracking.state;
      if (state !== undefined) markDirty(state, eid);
    },
  };
};

/**
 * Number of live worlds per schema that get a dedicated, column-bound accessor class. Other worlds
 * share one slot-reading class, so a `world(C, eid).x` site sees at most DEDICATED_ACCESSOR_WORLDS + 1
 * hidden classes and stays polymorphic (V8 goes megamorphic past 4). A slot is freed only once its
 * world is garbage collected: its class and hidden class die in the same GC, so V8's feedback drops
 * the old hidden class before a new one can take the slot. Worlds already on the shared class keep
 * it, so their accessors are never rebuilt mid-session.
 */
const DEDICATED_ACCESSOR_WORLDS = 3;

type WorldRef = { deref(): World | undefined };
// Without WeakRef (pre-ES2021 runtimes) slots are never freed; later worlds use the shared class.
const refWorld = (world: World): WorldRef =>
  typeof WeakRef === "function" ? new WeakRef(world) : { deref: () => world };

type AccessorClasses = { dedicated: WorldRef[]; shared: Map<string, AccessorCtor> };
const accessorClasses = new WeakMap<typeof Schema, AccessorClasses>();

const hasDedicatedSlot = (classes: AccessorClasses) => {
  if (classes.dedicated.length >= DEDICATED_ACCESSOR_WORLDS) {
    classes.dedicated = classes.dedicated.filter((ref) => ref.deref() !== undefined);
  }
  return classes.dedicated.length < DEDICATED_ACCESSOR_WORLDS;
};

const createAccessorCtor = (
  type: string,
  keys: string[],
  fieldDescriptors: PropertyDescriptor[],
  withSlots: boolean,
): AccessorCtor => {
  const allKeys = [...keys, "type"];
  const descriptors = [...fieldDescriptors, { value: type, writable: false, enumerable: true, configurable: false }];

  const keyCount = allKeys.length;
  // Shared and mutated per construction (construction is synchronous), so no descriptor allocation.
  const eidDescriptor: PropertyDescriptor = { value: -1, writable: false, enumerable: false, configurable: false };
  const ctxDescriptor: PropertyDescriptor = { value: null, writable: false, enumerable: false, configurable: false };

  // Each class gets a private prototype and with it a private V8 transition tree; sharing one root
  // across components with same-named accessors would push accessor objects into dictionary mode.
  const Ctor = function (this: AccessorObject, eid: number, slots: Slots | null) {
    eidDescriptor.value = eid;
    Object.defineProperty(this, $eid, eidDescriptor);
    if (withSlots) {
      ctxDescriptor.value = slots;
      Object.defineProperty(this, $ctx, ctxDescriptor);
      ctxDescriptor.value = null;
    }
    // Own enumerable accessors (getter/setter functions shared by every instance), so object
    // spread and Object.keys see the fields.
    for (let i = 0; i < keyCount; i++) Object.defineProperty(this, allKeys[i], descriptors[i]);
    // Unknown keys (typos) keep throwing in strict mode instead of silently adding own properties.
    Object.preventExtensions(this);
  } as unknown as AccessorCtor;
  (Ctor as any).prototype = Object.create(Object.prototype);
  Ctor.keys = allKeys;
  Ctor.snapshot = null;
  // Lets `snapshot(accessor)` find the class through the prototype with one inherited-property load.
  Object.defineProperty((Ctor as any).prototype, $accessorCtor, { value: Ctor, enumerable: false });
  return Ctor;
};

const getAccessorCtor = (world: World, component: WorldComponent): AccessorCtor => {
  const cached = (component as any)[$accessors];
  if (cached) return cached;

  const store = component.store;
  const keys: string[] = [];
  const cols: any[] = [];
  const kinds: ColumnKind[] = [];
  const booleans: boolean[] = [];
  const storeKeys = Object.keys(store);
  for (let i = 0; i < storeKeys.length; i++) {
    const key = storeKeys[i];
    if (key === "type") continue;
    const column = (store as any)[key];
    keys.push(key);
    cols.push(column);
    kinds.push(columnKind(column));
    booleans.push(!!component.booleanKeys?.has(key));
  }

  let classes = accessorClasses.get(component.schema);
  if (!classes) accessorClasses.set(component.schema, (classes = { dedicated: [], shared: new Map() }));

  let Ctor: AccessorCtor;
  let slots: Slots | null = null;
  if (hasDedicatedSlot(classes)) {
    classes.dedicated.push(refWorld(world));
    const descriptors = cols.map((col, i) => buildBoundDescriptor(world, col, booleans[i]));
    Ctor = createAccessorCtor(component.type, keys, descriptors, false);
  } else {
    const signature = `${component.type}\u0000${keys.join("\u0000")}\u0000${kinds.join("")}${booleans.map(Number).join("")}`;
    let shared = classes.shared.get(signature);
    if (!shared) {
      const descriptors = compileSharedDescriptors(kinds, booleans);
      classes.shared.set(signature, (shared = createAccessorCtor(component.type, keys, descriptors, true)));
    }
    Ctor = shared;
    const ctx: AccessorContext = {
      cols,
      slots: null as unknown as Slots,
      tracking: getDeltaHolder(world),
      world,
      buckets: cols.map(() => null),
      bucketStates: cols.map(() => undefined),
    };
    // Same insertion order in every world, so all slots objects of a schema share one hidden class.
    slots = { ctx } as any;
    for (let i = 0; i < cols.length; i++) slots![`c${i}`] = cols[i];
    ctx.slots = slots!;
  }
  (component as any)[$accessors] = Ctor;
  (component as any)[$accessorCtx] = slots;
  return Ctor;
};

const proxyComponent = (world: World, entity: number, component: WorldComponent) => {
  const Ctor = getAccessorCtor(world, component);
  const accessor = new Ctor(entity, (component as any)[$accessorCtx]);
  // Ids that can never be entities (negative, fractional, past the world) get an uncached accessor:
  // caching them would grow the cache without bound or turn it into a dictionary.
  if (!(entity >>> 0 === entity && entity <= world.size)) return accessor;
  let proxies = component.proxies;
  if (entity >= proxies.length) {
    // Grow geometrically and fill, so the cache keeps fast packed elements; a first write at a high
    // eid into a short array would turn it into a dictionary and make every world(C, eid) a hash lookup.
    const length = Math.min(world.size + 1, Math.max(entity + 1, proxies.length * 2, 64));
    const grown = new Array(length).fill(null);
    for (let i = 0; i < proxies.length; i++) grown[i] = proxies[i];
    proxies = component.proxies = grown;
  }
  proxies[entity] = accessor;
  return accessor;
};

type Snapshotter = (accessor: any) => any;

/**
 * Copier that reads every key through an accessor into an object literal (same getters, same
 * dirty marking as a spread). Spread copies accessors through V8's generic slow path; plain
 * property loads hit inline caches, which is 3-5x faster.
 */
const getSnapshotter = (Ctor: AccessorCtor): Snapshotter => {
  if (Ctor.snapshot) return Ctor.snapshot;
  const keys = Ctor.keys;
  let fn: Snapshotter;
  try {
    const body = keys.map((k) => `${JSON.stringify(k)}: a[${JSON.stringify(k)}]`).join(", ");
    fn = new Function("a", `return { ${body} };`) as Snapshotter;
  } catch {
    // Code generation disallowed (CSP): spread gives the identical result.
    fn = (a) => ({ ...a });
  }
  return (Ctor.snapshot = fn);
};

type ComponentSnapshot<T> = T & { type: string };
/** Every component an entity has, keyed by component type. */
export type EntitySnapshot = Record<string, ComponentSnapshot<any>>;
/** Every entity in a world, keyed by eid. */
export type WorldSnapshot = Record<number, EntitySnapshot>;

// Always reads through the accessor getters, never the raw columns: a component may override a value.
const snapshotWith = (world: World, component: WorldComponent, eid: number) => {
  const accessor = component.proxies[eid] ?? proxyComponent(world, eid, component);
  return getSnapshotter(getAccessorCtor(world, component))(accessor);
};

/**
 * Plain-object copies of component values, read through the accessors (same values and delta
 * dirty marking as a spread, several times faster):
 *
 * - `snapshot(world, Component, eid)`: one component, same result as `{ ...world(Component, eid) }`.
 * - `snapshot(world, eid)`: every component the entity has, keyed by component type.
 * - `snapshot(world)`: every entity, keyed by eid, each as `snapshot(world, eid)`.
 * - `snapshot(accessor)`: copy of an accessor you already hold, e.g. `snapshot(world(C, eid))`.
 */
export function snapshot<T extends Schema>(world: World, component: Constructor<T>, eid: number): ComponentSnapshot<T>;
export function snapshot(world: World, eid: number): EntitySnapshot;
export function snapshot(world: World): WorldSnapshot;
export function snapshot<T extends Schema>(accessor: T): ComponentSnapshot<T>;
export function snapshot(worldOrAccessor: World | Schema, target?: Constructor<Schema> | number, eid?: number): any {
  if (typeof worldOrAccessor !== "function") {
    // An accessor object: its class is reachable through the prototype.
    const Ctor: AccessorCtor | undefined =
      worldOrAccessor != null ? (worldOrAccessor as any)[$accessorCtor] : undefined;
    if (Ctor === undefined) throw new Error("minECS - snapshot expects a world or a component accessor.");
    return getSnapshotter(Ctor)(worldOrAccessor);
  }
  const world = worldOrAccessor as World;
  if (typeof target === "function") {
    const component = lookupComponent(world, target as unknown as typeof Schema);
    if (component === undefined) throw new Error(`minECS - component ${target.name} is not registered.`);
    if (eid === undefined) throw new Error("minECS - entity is undefined.");
    return snapshotWith(world, component, eid);
  }
  if (target !== undefined && typeof target !== "number") {
    throw new Error("minECS - snapshot expects a component or an entity id.");
  }

  const masksByGeneration = world.entityMasks;
  if (typeof target === "number") {
    if (!world.entitySparseSet.has(target)) throw new Error("minECS - entity does not exist in the world.");
    const out: EntitySnapshot = {};
    for (const component of world.componentMap.values()) {
      if ((masksByGeneration[component.generationId][target] & component.bitflag) === component.bitflag) {
        out[component.type] = snapshotWith(world, component, target);
      }
    }
    return out;
  }

  // Whole world: one pass per component over the live entities, so keys come out in component order.
  const dense = world.entitySparseSet.dense;
  const out: WorldSnapshot = {};
  for (let j = 0; j < dense.length; j++) out[dense[j]] = {};
  for (const component of world.componentMap.values()) {
    const masks = masksByGeneration[component.generationId];
    const bitflag = component.bitflag;
    for (let j = 0; j < dense.length; j++) {
      const e = dense[j];
      if ((masks[e] & bitflag) === bitflag) out[e][component.type] = snapshotWith(world, component, e);
    }
  }
  return out;
}

export const sortComponentQueries = (world: World, component: typeof Schema) => {
  const worldComponent = world["componentMap"].get(component);
  if (!worldComponent) return;
  const { queries } = worldComponent;
  const counts = new Map<Query, number>();
  for (let i = 0; i < queries.length; i++) {
    counts.set(queries[i], queries[i].queryKey.split("|").length);
  }
  const sortedQueries = queries.sort((a, b) => {
    const aCount = counts.get(a)!;
    const bCount = counts.get(b)!;
    return aCount - bCount ? aCount - bCount : a.queryKey.localeCompare(b.queryKey);
  });
  worldComponent.queries = sortedQueries;
};

const registerSystem = (world: World, SystemConstructor: typeof SystemImpl, components: (typeof Schema)[]) => {
  const $query = components
    .map((c) => c.type)
    .sort()
    .join("|");
  const query = defineQuery(components);
  query(world);

  const system = new SystemConstructor(query);
  system[$boundWorld] = world;
  system[$boundQuery] = world.queryMap.get($query) ?? null;

  const existingSystems = world.systemQueryMap.get($query);
  if (existingSystems) {
    world.systemQueryMap.set($query, [...existingSystems, system]);
  } else {
    world.systemQueryMap.set($query, [system]);
  }

  return system;
};

const dataSlot = (value: any, enumerable = true): PropertyDescriptor => ({
  value,
  writable: true,
  enumerable,
  configurable: true,
});

/** How many entities the world's component stores can hold (the size it was created with). */
export const getWorldCapacity = (world: World): number => (world as any)[$capacity] ?? world.size;

/**
 * Which components and systems a world registers. Omitted lists mean "everything defined": every
 * @Component, and every @System whose components are all registered.
 */
export type CreateWorldOptions = {
  /** Only these components are registered (in global index order, whatever order they are listed in). */
  components?: readonly (typeof Schema)[];
  /** Only these systems are created (in the usual depth / query order, whatever order they are listed in). */
  systems?: readonly (typeof SystemImpl<any> | typeof DrawSystemImpl<any>)[];
};

const describeType = (schema: typeof Schema | undefined) => (schema && schema.type) || String(schema);

/** Fails with a clear message when `schema` is not registered in `world`. */
const unregistered = (world: World, schema: typeof Schema): never => {
  const known = Array.from(world.componentMap.keys(), (s) => s.type);
  throw new Error(
    `minECS - component ${describeType(schema)} is not registered in this world` +
      (known.length < 40 ? ` (registered: ${known.join(", ") || "none"})` : ` (${known.length} registered)`),
  );
};

/** Whether `world` has `schema` registered (worlds created with a component subset may not). */
export const isComponentRegistered = (world: World, schema: typeof Schema): boolean =>
  lookupComponent(world, schema) !== undefined;

export const createWorld = (size?: number, options?: CreateWorldOptions): World => {
  freezeComponentOrder();
  const worldFn = <T extends Schema>(schema: Constructor<T>, eid?: number): T | WorldComponent => {
    let component = world.componentList[(schema as unknown as typeof Schema).index];
    if (component === undefined || component.schema !== (schema as unknown as typeof Schema)) {
      component = world.componentMap.get(schema as unknown as typeof Schema) ?? unregistered(world, schema as unknown as typeof Schema);
    }

    if (eid === undefined) {
      return component;
    }
    return (component.proxies[eid] as T) ?? (proxyComponent(world, eid, component) as unknown as T);
  };

  const worldSize = size ?? 1000;

  // All properties, including the internal symbol slots, are declared in one defineProperties call so
  // the function object keeps fast (non-dictionary) properties; see Internal.ts.
  const descriptors: PropertyDescriptorMap = {
    entityCursor: dataSlot(0),
    frame: dataSlot(0),
    componentMap: dataSlot(new Map<typeof Schema, WorldComponent>()),
    componentList: dataSlot([]),
    componentSchemaStore: dataSlot(new Map<Store, WorldComponent>()),
    entityMasks: dataSlot([new Uint32Array(worldSize)]),
    size: dataSlot(worldSize),
    bitflag: dataSlot(1),
    entitySparseSet: dataSlot(SparseSet(worldSize + 1)),
    removed: dataSlot([]),
    queryMap: dataSlot(new Map<string, Query>()),
    dirtyQueries: dataSlot(new Set<Query>()),
    queries: dataSlot(new Set<any>()),
    systemQueryMap: dataSlot(new Map<string, SystemImpl[]>()),
    systems: dataSlot([]),
    drawSystems: dataSlot([]),
    timing: dataSlot(null),
  };
  for (let i = 0; i < WORLD_INTERNAL_SLOTS.length; i++) {
    (descriptors as any)[WORLD_INTERNAL_SLOTS[i]] = dataSlot(undefined, false);
  }
  const world = Object.defineProperties(worldFn, descriptors) as unknown as World;
  updateReuseThreshold(world);
  (world as any)[$capacity] = worldSize;

  let components: readonly (typeof Schema)[] = componentList;
  if (options?.components) {
    const wanted = new Set<typeof Schema>();
    for (const schema of options.components) {
      if (!schema || componentList[schema.index] !== schema) {
        throw new Error(
          `minECS - createWorld: ${describeType(schema)} is not a defined component (decorate it with @Component)`,
        );
      }
      wanted.add(schema);
    }
    // Global index order keeps column order, bits and wire layout independent of the listed order.
    components = componentList.filter((schema) => wanted.has(schema));
  }
  components.forEach((component) => {
    registerComponent(world, component);
  });

  let selected: ((entry: [typeof SystemImpl, (typeof Schema)[]]) => boolean) | null = null;
  if (options?.systems) {
    const wanted = new Set<unknown>(options.systems);
    const defined = new Set<unknown>();
    [systemManualList, systemRunList, drawSystemRunList].forEach((list) => list.forEach(([S]) => defined.add(S)));
    for (const S of wanted) {
      if (!defined.has(S)) {
        throw new Error(
          `minECS - createWorld: system ${(S as any)?.name ?? String(S)} is not a defined system (decorate it with @System)`,
        );
      }
    }
    selected = ([S, schemas]) => {
      if (!wanted.has(S)) return false;
      for (const schema of schemas) {
        if (!world.componentMap.has(schema)) {
          throw new Error(
            `minECS - createWorld: system ${S.name} queries ${describeType(schema)}, which is not in this world's components`,
          );
        }
      }
      return true;
    };
  } else if (options?.components) {
    // A component subset without a system list keeps the systems whose components are all present.
    selected = ([, schemas]) => schemas.every((schema) => world.componentMap.has(schema));
  }
  const include = (entry: [typeof SystemImpl, (typeof Schema)[]]) => selected === null || selected(entry);

  systemManualList.forEach((entry) => {
    if (!include(entry)) return;
    const [SystemConstructor, components] = entry;
    world.systems.push(registerSystem(world, SystemConstructor, components));
  });

  const stepSystems: StepEntry[] = [];
  systemRunList.forEach((entry) => {
    if (!include(entry)) return;
    const [SystemConstructor, components] = entry;
    const system = registerSystem(world, SystemConstructor, components);
    world.systems.push(system);
    stepSystems.push(makeStepEntry(SystemConstructor, system));
  });
  (world as any)[$stepSystems] = stepSystems;

  drawSystemRunList.forEach((entry) => {
    if (!include(entry as any)) return;
    const [SystemConstructor, components] = entry;
    world.drawSystems.push(registerSystem(world, SystemConstructor, components));
  });

  components.forEach((component) => {
    sortComponentQueries(world, component);
  });

  return world;
};

export const getEntityCursor = (world: World) => world.entityCursor;

export const deleteWorld = (world: World) => {
  world.componentMap.forEach((component) => {
    free(component.store);
  });

  return;
};

export const getComponentSchema = (world: World, component: Store) => {
  // const registeredComponent = Array.from(world["componentMap"].keys()).find((c) => c.store === component);
  // return registeredComponent!;
  return world.componentSchemaStore.get(component)!;
};

export const hasComponent = <T extends Schema>(world: World, component: Constructor<T>, eid: number) => {
  const registeredComponent = lookupComponent(world, component as unknown as typeof Schema);
  if (!registeredComponent) return false;
  const bitflag = registeredComponent.bitflag;
  return (world.entityMasks[registeredComponent.generationId][eid] & bitflag) === bitflag;
};

const registerComponent = (world: World, schema: typeof Schema) => {
  if (!schema) throw new Error(`minECS - Cannot register null or undefined component`);

  const queries: Query[] = [];

  world.queries.forEach((q) => {
    if (q.queryKey.split("|").includes(schema.type)) {
      queries.push(q);
    }
  });

  const worldComponent: WorldComponent = prepareWorldComponent({
    type: schema.type,
    generationId: world["entityMasks"].length - 1,
    bitflag: world["bitflag"],
    store: schema.createStore(world["size"]),
    queries,
    proxies: [],
    schema: schema,
    booleanKeys: (schema as any).__booleanKeys || null,
  });
  world["componentMap"].set(schema, worldComponent);

  // Index-addressed so world(schema) finds it with one array read, even in a subset world.
  const index = schema.index;
  if (typeof index === "number" && index >= 0 && world.componentList[index] === undefined) {
    world.componentList[index] = worldComponent;
  } else {
    world.componentList.push(worldComponent);
  }
  world.componentSchemaStore.set(worldComponent.store, worldComponent);

  const table: WorldComponent[][] = (world as any)[$bitTable] || ((world as any)[$bitTable] = []);
  const row = table[worldComponent.generationId] || (table[worldComponent.generationId] = []);
  row[31 - Math.clz32(worldComponent.bitflag)] = worldComponent;

  incrementBitflag(world);
};

export const incrementBitflag = (world: World) => {
  world["bitflag"] *= 2;
  if (world["bitflag"] >= 2 ** 31) {
    world["bitflag"] = 1;
    world["entityMasks"].push(new Uint32Array(world["size"]));
  }
};

export const getSystem = <T extends typeof SystemImpl<any>>(world: World, system: T): InstanceType<T> => {
  const key = system.queryKey;
  return world.systemQueryMap.get(key)?.find((s) => s instanceof system) as InstanceType<T>;
};

export const getSystemsByType = <T extends typeof SystemImpl<any>>(world: World, type: string): InstanceType<T>[] => {
  const keys = Array.from(world.systemQueryMap.keys()).filter((key) => key.split("|").includes(type));
  if (keys.length) {
    return keys.map((key) => world.systemQueryMap.get(key) as InstanceType<T>);
  }
  return [];
};

/**
 * A scheduled system with its frameMod/frameModOffset clamping precomputed. The raw static values are
 * re-read each frame (they are public and may be changed at runtime) and the clamp is only redone when
 * they change.
 */
type StepEntry = {
  SystemClass: typeof SystemImpl;
  system: SystemImpl;
  rawMod: number;
  rawOffset: number;
  always: boolean;
  mod: number;
  offset: number;
};

const makeStepEntry = (SystemClass: typeof SystemImpl, system: SystemImpl): StepEntry => ({
  SystemClass,
  system,
  rawMod: NaN,
  rawOffset: NaN,
  always: true,
  mod: 1,
  offset: 0,
});

const shouldEntryRun = (entry: StepEntry, frame: number): boolean => {
  const SystemClass = entry.SystemClass;
  const frameMod = SystemClass.frameMod ?? 1;
  const frameModOffset = SystemClass.frameModOffset ?? 0;
  if (frameMod !== entry.rawMod || frameModOffset !== entry.rawOffset) {
    entry.rawMod = frameMod;
    entry.rawOffset = frameModOffset;
    // Always run if mod is 1 or less and no offset
    entry.always = frameMod <= 1 && frameModOffset === 0;
    // Clamp frameMod to 1-60, offset to 0..frameMod-1
    entry.mod = Math.max(1, Math.min(60, frameMod));
    entry.offset = Math.max(0, Math.min(entry.mod - 1, frameModOffset));
  }
  if (entry.always) return true;
  // offset of 0 means runs on frame 1, 2, 3... (every frame if mod=1)
  // offset of 1 means runs on frame 2, 4, 6... (if mod=2); frame is 1-indexed after increment
  return (frame - 1 - entry.offset) % entry.mod === 0 && frame > entry.offset;
};

// Worlds created via createWorld carry a precomputed entry list; anything else
// falls back to resolving instances from the global run list each step.
const getStepSystems = (world: World): StepEntry[] => {
  const cached = (world as any)[$stepSystems] as StepEntry[] | undefined;
  if (cached) return cached;
  const entries: StepEntry[] = [];
  for (let i = 0; i < systemRunList.length; i++) {
    const SystemClass = systemRunList[i][0];
    entries.push(makeStepEntry(SystemClass, getSystem(world, SystemClass)));
  }
  return entries;
};

// world.drawSystems is a public array, so the cached entries are revalidated by identity each frame.
const getDrawSystems = (world: World): StepEntry[] => {
  const systems = world.drawSystems;
  let entries = (world as any)[$drawSystems] as StepEntry[] | undefined;
  let valid = !!entries && entries.length === systems.length;
  if (valid) {
    for (let i = 0; i < systems.length; i++) {
      if (entries![i].system !== systems[i]) {
        valid = false;
        break;
      }
    }
  }
  if (!valid) {
    entries = systems.map((system) => makeStepEntry(system.constructor as typeof SystemImpl, system));
    (world as any)[$drawSystems] = entries;
  }
  return entries!;
};

const runStepSystems = (world: World) => {
  world.frame++;
  const frame = world.frame;
  const entries = getStepSystems(world);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!shouldEntryRun(entry, frame)) continue;

    const system = entry.system;
    if (entry.SystemClass.runEmpty || systemEntities(system, world).length) {
      system.runAll(world);
    }
  }
};

export const stepWorld = (world: World) => {
  runStepSystems(world);
};

export const stepWorldDraw = (world: ReadOnlyWorld) => {
  const entries = getDrawSystems(world);
  const frame = world.frame;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!shouldEntryRun(entry, frame)) continue;

    const system = entry.system;
    if (entry.SystemClass.runEmpty || systemEntities(system, world).length) {
      system.runAll(world);
    }
  }
};

// Marks a SystemTiming as already listed in the current world.timing.systems.
const $timingListed = Symbol("timingListed");

export const stepWorldTiming = (world: World) => {
  // Initialize world timing for this frame and clear all system timings
  world.timing = { systems: [], totalTime: 0 };

  // Wrap runAll for all systems (including manual) with timing
  const allSystems = world.systems;
  for (let i = 0; i < allSystems.length; i++) {
    const system = allSystems[i] as SystemImpl & { [$originalRunAll]?: (world: World) => void };

    // Reset timing for this frame
    system.timing = {
      name: system.constructor.name,
      totalTime: 0,
      totalCalls: 0,
      averageTime: 0,
    };
    Object.defineProperty(system.timing, $timingListed, { value: false, writable: true, enumerable: false });

    // Only wrap if not already wrapped
    if (!system[$originalRunAll]) {
      const originalRunAll = system.runAll.bind(system);
      system[$originalRunAll] = originalRunAll;

      system.runAll = function (w: World) {
        const t = this.timing;
        if (t && w.timing) {
          const ents = systemEntities(this, w);
          const start = performance.now();
          originalRunAll(w);
          const elapsed = performance.now() - start;

          t.totalCalls += ents.length;
          t.totalTime += elapsed;
          t.averageTime = t.totalCalls > 0 ? t.totalTime / t.totalCalls : 0;

          w.timing.totalTime += elapsed;
          if (!(t as any)[$timingListed]) {
            (t as any)[$timingListed] = true;
            w.timing.systems.push(t);
          }
        } else {
          originalRunAll(w);
        }
      };
    }
  }

  // Run all scheduled systems (same as stepWorld)
  runStepSystems(world);
};

export const clearWorldTiming = (world: World) => {
  world.timing = null;
  const allSystems = world.systems;
  for (let i = 0; i < allSystems.length; i++) {
    const system = allSystems[i] as SystemImpl & { [$originalRunAll]?: (world: World) => void };
    system.timing = null;

    // Restore original runAll if it was wrapped
    if (system[$originalRunAll]) {
      system.runAll = system[$originalRunAll];
      delete system[$originalRunAll];
    }
  }
};

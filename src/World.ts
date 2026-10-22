/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { Store } from "./Storage";
import { $parentArray, $storeFlattened, free, resetStoreFor } from "./Storage";
import type { Constructor, Query, ReadOnlyWorld, World, WorldComponent } from "./Types";
import { SparseSet } from "./SparseSet";
import type { Schema } from "./Schema";
import { componentList, freezeComponentOrder } from "./Component";
import { $queryOrder, queryRemoveEntity, queryCheckEntity, queryAddEntity, defineQuery } from "./Query";
import type { SystemImpl } from "./System";
import { $originalRunAll, drawSystemRunList, systemManualList, systemRunList } from "./System";
import { getDeltaHolder, markDeltaDirty } from "./DeltaTracking";

const removedReuseThreshold = 0.01;

// Internal (symbol-keyed) caches kept off the public World / WorldComponent shapes.
const $eid = Symbol("eid");
const $accessors = Symbol("accessors");
const $accessorProto = Symbol("accessorProto");
const $defaults = Symbol("defaults");
const $bitTable = Symbol("bitTable");
const $stepSystems = Symbol("stepSystems");

/**
 * Pre-seeds the lazily-populated per-component caches so every WorldComponent shares one
 * hidden class regardless of which cache gets filled first (keeps `world(...)` lookups monomorphic).
 */
export const prepareWorldComponent = (worldComponent: WorldComponent): WorldComponent => {
  const wc = worldComponent as any;
  wc[$accessors] = null;
  wc[$accessorProto] = null;
  wc[$defaults] = undefined;
  return worldComponent;
};

type StepEntry = [typeof SystemImpl, SystemImpl];

export const addEntity = (world: World) => {
  const removed = world["removed"];
  const eid =
    removed.length > Math.round(world["size"] * removedReuseThreshold)
      ? removed.pop()!
      : world.entityCursor++;

  if (eid > world["size"]) throw new Error("minECS - max entities reached");

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

export const removeEntity = (world: World, eid: number) => {
  // Check if entity is already removed
  if (!world["entitySparseSet"].has(eid)) return;

  // Remove entity from the queries of the components this entity actually has
  // (instead of scanning every query in the world).
  const systemQueryMap = world.systemQueryMap;
  const masks = world["entityMasks"];
  const table: WorldComponent[][] = (world as any)[$bitTable] ?? rebuildComponentBitTable(world);
  const removedQueries: Query[] = [];

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
          removedQueries.push(q);
        }
      }
    }
  }

  if (removedQueries.length) {
    // Preserve historical cleanup order: queries in world creation order, groups run in reverse.
    if (removedQueries.length > 1) {
      removedQueries.sort(
        (a, b) => ((a as any)[$queryOrder] ?? Infinity) - ((b as any)[$queryOrder] ?? Infinity)
      );
    }
    let groups: SystemImpl[][] | null = null;
    for (let i = 0; i < removedQueries.length; i++) {
      const systems = systemQueryMap.get(removedQueries[i].queryKey);
      if (systems) (groups ||= []).push(systems);
    }
    if (groups) runCleanupGroups(world, groups, eid);
  }

  // Free the entity
  world["removed"].push(eid);

  // remove all eid state from world
  world["entitySparseSet"].remove(eid);

  // Clear entity bitmasks
  for (let i = 0; i < masks.length; i++) masks[i][eid] = 0;
};

export const entityExists = (world: World, eid: number) => world["entitySparseSet"].has(eid);

type ComponentInput<T> = {
  [K in keyof T]?: T[K] extends ArrayBufferView ? T[K] | number[] : T[K];
};

type DefaultEntry = [key: string, value: any, needsClone: boolean];

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
      entries.push([key, value, value !== null && typeof value === "object"]);
    }
  }
  (c as any)[$defaults] = entries;
  return entries;
};

const writeComponentValue = (store: Store, key: string, eid: number, value: any) => {
  const column = store[key];
  if (ArrayBuffer.isView(column[eid])) {
    (column[eid] as unknown as Float32Array).set(value);
  } else {
    column[eid] = value;
  }
};

export function addComponent<T>(
  world: World,
  component: Constructor<T>,
  eid: number,
  overrides?: ComponentInput<T>,
  reset?: boolean
) {
  const schema = component as unknown as typeof Schema;

  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world["entitySparseSet"].has(eid)) throw new Error("minECS - entity does not exist in the world.");
  if (!world["componentMap"].has(schema)) registerComponent(world, schema);
  if (hasComponent(world, schema, eid)) return;

  const c = world["componentMap"].get(schema)!;
  const { generationId, bitflag, queries, store } = c;
  const deltaTrackingActive = !!getDeltaHolder(world).state;

  // Add bitflag to entity bitmask
  world["entityMasks"][generationId][eid] |= bitflag;

  // Zero out each property value
  if (reset !== false) {
    resetStoreFor(store, eid);
  }

  let defaults: DefaultEntry[] | null = null;
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
  if (!hasOverrides) {
    defaults = getComponentDefaults(c);
  }

  if (defaults) {
    // Fast path: no overrides to validate, apply precomputed defaults directly.
    for (let i = 0; i < defaults.length; i++) {
      const entry = defaults[i];
      writeComponentValue(store, entry[0], eid, entry[2] ? cloneDefault(entry[1]) : entry[1]);
    }
  } else {
    const validated = validateComponent(schema, eid, (overrides as any) || {});
    const keys = Object.keys(validated);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key !== "type") {
        writeComponentValue(store, key, eid, validated[key]);
      }
    }
  }

  // Mark all component properties dirty so delta serializers include newly added components.
  if (deltaTrackingActive) {
    const flattened = store[$storeFlattened];
    if (flattened.length) {
      for (let i = 0; i < flattened.length; i++) {
        markDeltaDirty(world, flattened[i], eid);
      }
    } else {
      markDeltaDirty(world, store, eid);
    }
  }

  const systemQueryMap = world.systemQueryMap;
  let cleanupGroups: SystemImpl[][] | null = null;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    // remove this entity from toRemove if it exists in this query
    q.toRemove.remove(eid);
    const match = queryCheckEntity(world, q, eid);
    if (match) {
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
      if (systems) {
        (cleanupGroups ||= []).push(systems);
      }
    }
  }

  if (cleanupGroups) runCleanupGroups(world, cleanupGroups, eid);
}

const validateComponent = (schema: typeof Schema, entity: number, overrides: { [key: string]: any }) => {
  overrides = overrides || {};
  const keys = Object.keys(overrides);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = overrides[key];
    if (typeof value === "object" && value?.toJSON) {
      overrides[key] = value.toJSON();
    }
  }

  if (!schema.validate(overrides)) {
    throw {
      overrides,
      schema: schema.schema,
      errors: schema.validate.errors,
      error: new Error(`Invalid schema for component ${schema.type} on entity ${entity}`),
    };
  }
  return overrides;
};

export const disableComponent = (world: World, component: typeof Schema, eid: number) => {
  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world["entitySparseSet"].has(eid)) throw new Error("minECS - entity does not exist in the world.");
  if (!hasComponent(world, component, eid)) return;

  const c = world["componentMap"].get(component)!;
  const { generationId, bitflag } = c;

  // Remove flag from entity bitmask
  world["entityMasks"][generationId][eid] &= ~bitflag;
};

export const removeComponent = (world: World, component: typeof Schema, eid: number) => {
  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world["entitySparseSet"].has(eid)) throw new Error("minECS - entity does not exist in the world.");
  if (!hasComponent(world, component, eid)) return;

  world.componentList[component.index].proxies[eid] = null;
  const c = world["componentMap"].get(component)!;
  const { generationId, bitflag, queries } = c;
  const store = c.store;
  const deltaTrackingActive = !!getDeltaHolder(world).state;

  // Track membership removals for delta serializers.
  if (deltaTrackingActive) {
    const flattened = store[$storeFlattened];
    if (flattened.length) {
      for (let i = 0; i < flattened.length; i++) {
        markDeltaDirty(world, flattened[i], eid);
      }
    } else {
      markDeltaDirty(world, store, eid);
    }
  }

  // Remove flag from entity bitmask
  world["entityMasks"][generationId][eid] &= ~bitflag;

  const systemQueryMap = world.systemQueryMap;
  let cleanupGroups: SystemImpl[][] | null = null;

  // todo: archetype graph
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    // remove this entity from toRemove if it exists in this query
    q.toRemove.remove(eid);
    const match = queryCheckEntity(world, q, eid);
    if (match) {
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
      if (systems) {
        (cleanupGroups ||= []).push(systems);
      }
    }
  }

  if (cleanupGroups) runCleanupGroups(world, cleanupGroups, eid);
};

/****************************************************
 *
 * Component accessors
 *
 * `world(Component, eid)` returns a plain object whose own enumerable accessor properties
 * read/write straight into the component's column stores. One shared descriptor map is built
 * per WorldComponent, so every accessor object of a component shares the same hidden class
 * and the same getter/setter functions (monomorphic call sites, no Proxy traps).
 *
 ****************************************************/

type AccessorObject = { [$eid]: number; [key: string]: any };

const buildAccessorDescriptor = (world: World, column: any, isBoolean: boolean): PropertyDescriptor => {
  const tracking = getDeltaHolder(world);
  const col: any = column;

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
        if (tracking.state) markDeltaDirty(world, col, eid);
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
        if (tracking.state) markDeltaDirty(world, col, eid);
        return col[eid];
      },
      set: function (this: AccessorObject, value: any) {
        const eid = this[$eid];
        col[eid].set(value);
        if (tracking.state) markDeltaDirty(world, col, eid);
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
      if (tracking.state && (ArrayBuffer.isView(value) || (value && typeof value === "object"))) {
        // Mutations to returned views/objects bypass the setter, so mark as dirty preemptively.
        markDeltaDirty(world, col, eid);
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
      if (tracking.state) markDeltaDirty(world, col, eid);
    },
  };
};

type AccessorPlan = {
  keys: string[];
  descriptors: PropertyDescriptor[];
  eidDescriptor: PropertyDescriptor;
  proto: object;
};

const getAccessorPlan = (world: World, component: WorldComponent): AccessorPlan => {
  const cached = (component as any)[$accessors];
  if (cached) return cached;

  const store = component.store;
  const keys: string[] = [];
  const descriptors: PropertyDescriptor[] = [];
  const storeKeys = Object.keys(store);
  for (let i = 0; i < storeKeys.length; i++) {
    const key = storeKeys[i];
    if (key === "type") continue;
    keys.push(key);
    descriptors.push(buildAccessorDescriptor(world, (store as any)[key], !!component.booleanKeys?.has(key)));
  }
  keys.push("type");
  descriptors.push({
    value: component.type,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  // Each world-component gets a private prototype, and with it a private V8 transition tree.
  // Accessor objects created from the shared Object.prototype root collide as soon as a second
  // component (or world) defines the same property name with different getter functions, at which
  // point V8 drops them into dictionary mode and every read becomes a hash lookup.
  const plan: AccessorPlan = {
    keys,
    descriptors,
    eidDescriptor: { value: -1, writable: false, enumerable: false, configurable: false },
    proto: Object.create(Object.prototype),
  };
  (component as any)[$accessorProto] = plan.proto;
  (component as any)[$accessors] = plan;
  return plan;
};

const proxyComponent = (world: World, entity: number, component: WorldComponent) => {
  const plan = getAccessorPlan(world, component);
  const { keys, descriptors, eidDescriptor } = plan;
  // Per-key defineProperty with shared descriptor objects is ~2.5x cheaper than
  // Object.create(proto, descriptorMap), which re-validates the whole map on every call.
  const accessor = Object.create(plan.proto);
  for (let i = 0; i < keys.length; i++) {
    Object.defineProperty(accessor, keys[i], descriptors[i]);
  }
  eidDescriptor.value = entity;
  Object.defineProperty(accessor, $eid, eidDescriptor);
  Object.preventExtensions(accessor);

  component.proxies[entity] = accessor;

  return accessor;
};

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

  const existingSystems = world.systemQueryMap.get($query);
  if (existingSystems) {
    world.systemQueryMap.set($query, [...existingSystems, system]);
  } else {
    world.systemQueryMap.set($query, [system]);
  }

  return system;
};

export const createWorld = (size?: number): World => {
  freezeComponentOrder();
  const worldFn = <T extends Schema>(schema: Constructor<T>, eid?: number): T | WorldComponent => {
    const component = world.componentList[(schema as unknown as typeof Schema).index];

    if (eid === undefined) {
      return component;
    }
    return (component.proxies?.[eid] as T) ?? (proxyComponent(world, eid, component) as T);
  };

  const worldSize = size ?? 1000;

  const world: World = Object.assign(worldFn, {
    entityCursor: 0,
    frame: 0,
    componentMap: new Map<typeof Schema, WorldComponent>(),
    componentList: [],
    componentSchemaStore: new Map<Store, WorldComponent>(),
    entityMasks: [new Uint32Array(worldSize)],
    size: worldSize,
    bitflag: 1,
    entitySparseSet: SparseSet(worldSize + 1),
    removed: [],
    queryMap: new Map<string, Query>(),
    dirtyQueries: new Set<Query>(),
    queries: new Set<any>(),
    systemQueryMap: new Map<string, SystemImpl[]>(),
    systems: [],
    drawSystems: [],
    timing: null,
  });

  componentList.forEach((component) => {
    registerComponent(world, component);
  });

  systemManualList.forEach(([SystemConstructor, components]) => {
    world.systems.push(registerSystem(world, SystemConstructor, components));
  });

  const stepSystems: StepEntry[] = [];
  systemRunList.forEach(([SystemConstructor, components]) => {
    const system = registerSystem(world, SystemConstructor, components);
    world.systems.push(system);
    stepSystems.push([SystemConstructor, system]);
  });
  (world as any)[$stepSystems] = stepSystems;

  drawSystemRunList.forEach(([SystemConstructor, components]) => {
    world.drawSystems.push(registerSystem(world, SystemConstructor, components));
  });

  componentList.forEach((component) => {
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
  const registeredComponent = world["componentMap"].get(component as unknown as typeof Schema);
  if (!registeredComponent) return false;
  const { generationId, bitflag } = registeredComponent;
  const mask = world["entityMasks"][generationId][eid];
  return (mask & bitflag) === bitflag;
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

  world.componentList.push(worldComponent);
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

const shouldSystemRun = (frame: number, frameMod: number, frameModOffset: number): boolean => {
  if (frameMod <= 1 && frameModOffset === 0) return true; // Always run if mod is 1 or less and no offset
  // Clamp frameMod to 1-60
  const clampedMod = Math.max(1, Math.min(60, frameMod));
  // Clamp offset to 0 to frameMod-1
  const clampedOffset = Math.max(0, Math.min(clampedMod - 1, frameModOffset));
  // System runs when (frame - offset) % mod === 0, but we need to handle the offset meaning "starts on frame offset+1"
  // offset of 0 means runs on frame 1, 2, 3... (every frame if mod=1)
  // offset of 1 means runs on frame 2, 4, 6... (if mod=2)
  // So we check if (frame - 1 - offset) % mod === 0, where frame is 1-indexed after increment
  return (frame - 1 - clampedOffset) % clampedMod === 0 && frame > clampedOffset;
};

// Worlds created via createWorld carry a precomputed [SystemClass, instance] list; anything else
// falls back to resolving instances from the global run list each step.
const getStepSystems = (world: World): StepEntry[] => {
  const cached = (world as any)[$stepSystems] as StepEntry[] | undefined;
  if (cached) return cached;
  const entries: StepEntry[] = [];
  for (let i = 0; i < systemRunList.length; i++) {
    const SystemClass = systemRunList[i][0];
    entries.push([SystemClass, getSystem(world, SystemClass)]);
  }
  return entries;
};

const runStepSystems = (world: World) => {
  world.frame++;
  const frame = world.frame;
  const entries = getStepSystems(world);
  for (let i = 0; i < entries.length; i++) {
    const SystemClass = entries[i][0];
    const frameMod = SystemClass.frameMod ?? 1;
    const frameModOffset = SystemClass.frameModOffset ?? 0;

    if (!shouldSystemRun(frame, frameMod, frameModOffset)) {
      continue;
    }

    const system = entries[i][1];
    if (system.query(world).length) {
      system.runAll(world);
    }
  }
};

export const stepWorld = (world: World) => {
  runStepSystems(world);
};

export const stepWorldDraw = (world: ReadOnlyWorld) => {
  const systems = world.drawSystems;
  for (let i = 0; i < systems.length; i++) {
    const SystemClass = world.drawSystems[i].constructor as typeof SystemImpl;
    const frameMod = SystemClass.frameMod ?? 1;
    const frameModOffset = SystemClass.frameModOffset ?? 0;

    if (!shouldSystemRun(world.frame, frameMod, frameModOffset)) {
      continue;
    }

    const system = systems[i];
    if (system.query(world).length) {
      system.runAll(world);
    }
  }
};

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

    // Only wrap if not already wrapped
    if (!system[$originalRunAll]) {
      const originalRunAll = system.runAll.bind(system);
      system[$originalRunAll] = originalRunAll;

      system.runAll = function (w: World) {
        const t = this.timing;
        if (t && w.timing) {
          const ents = this.query(w);
          const start = performance.now();
          originalRunAll(w);
          const elapsed = performance.now() - start;

          t.totalCalls += ents.length;
          t.totalTime += elapsed;
          t.averageTime = t.totalCalls > 0 ? t.totalTime / t.totalCalls : 0;

          w.timing.totalTime += elapsed;
          if (!w.timing.systems.includes(t)) {
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

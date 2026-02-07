/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { Store } from "./Storage";
import { free, resetStoreFor } from "./Storage";
import type { Constructor, Query, ReadOnlyWorld, World, WorldComponent } from "./Types";
import { SparseSet } from "./SparseSet";
import type { Schema } from "./Schema";
import { componentList, freezeComponentOrder } from "./Component";
import { queryRemoveEntity, queryCheckEntity, queryAddEntity, defineQuery } from "./Query";
import type { SystemImpl } from "./System";
import { drawSystemRunList, systemManualList, systemRunList } from "./System";

const removedReuseThreshold = 0.01;

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

export const removeEntity = (world: World, eid: number) => {
  // Check if entity is already removed
  if (!world["entitySparseSet"].has(eid)) return;

  // Remove entity from all queries

  const removeSystems: SystemImpl[] = [];
  const systemQueryMap = world.systemQueryMap;

  for (const q of world.queries) {
    if (queryRemoveEntity(world, q, eid)) {
      const systems = systemQueryMap.get(q.queryKey);
      if (systems) {
        removeSystems.unshift(...systems);
      }
    }
  }

  for (let i = 0; i < removeSystems.length; i++) {
    removeSystems[i].cleanup?.(world, eid);
  }

  // Free the entity
  world["removed"].push(eid);

  // remove all eid state from world
  world["entitySparseSet"].remove(eid);

  // Clear entity bitmasks
  const masks = world["entityMasks"];
  for (let i = 0; i < masks.length; i++) masks[i][eid] = 0;
};

export const entityExists = (world: World, eid: number) => world["entitySparseSet"].has(eid);

export function addComponent<T>(
  world: World,
  component: Constructor<T>,
  eid: number,
  overrides?: Partial<T>,
  reset?: boolean
) {
  const schema = component as unknown as typeof Schema;

  if (eid === undefined) throw new Error("minECS - entity is undefined.");
  if (!world["entitySparseSet"].has(eid)) throw new Error("minECS - entity does not exist in the world.");
  if (!world["componentMap"].has(schema)) registerComponent(world, schema);
  if (hasComponent(world, schema, eid)) return;

  const c = world["componentMap"].get(schema)!;
  const { generationId, bitflag, queries, store } = c;

  // Add bitflag to entity bitmask
  world["entityMasks"][generationId][eid] |= bitflag;

  // Zero out each property value
  if (reset !== false) {
    resetStoreFor(store, eid);
  }
  overrides = validateComponent(schema, eid, overrides ?? {}) as T;
  const keys = Object.keys(overrides);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== "type") store[key][eid] = (overrides as any)[key];
  }

  const systemQueryMap = world.systemQueryMap;
  const removeSystems: SystemImpl[] = [];

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
    }
    if (!match) {
      q.entered.remove(eid);

      if (queryRemoveEntity(world, q, eid)) {
        const systems = systemQueryMap.get(q.queryKey);
        if (systems) {
          removeSystems.unshift(...systems);
        }
      }
    }
  }

  for (let i = 0; i < removeSystems.length; i++) {
    removeSystems[i].cleanup?.(world, eid);
  }
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

  // Remove flag from entity bitmask
  world["entityMasks"][generationId][eid] &= ~bitflag;

  const removeSystems: SystemImpl[] = [];
  const systemQueryMap = world.systemQueryMap;

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
    }
    if (!match) {
      q.entered.remove(eid);
      if (queryRemoveEntity(world, q, eid)) {
        const systems = systemQueryMap.get(q.queryKey);
        if (systems) {
          removeSystems.unshift(...systems);
        }
      }
    }
  }

  for (let i = 0; i < removeSystems.length; i++) {
    removeSystems[i].cleanup?.(world, eid);
  }
};

// Cache ownKeys per component type to avoid repeated Object.keys() calls
const componentOwnKeysCache = new WeakMap<WorldComponent, string[]>();

const getComponentOwnKeys = (component: WorldComponent): string[] => {
  let keys = componentOwnKeysCache.get(component);
  if (!keys) {
    keys = Object.keys(component.store).concat(["type"]);
    componentOwnKeysCache.set(component, keys);
  }
  return keys;
};

const proxyComponent = (world: World, entity: number, component: WorldComponent) => {
  const store = component.store;
  const type = component.type;

  component.proxies[entity] = new Proxy(
    {
      type,
    },
    {
      set: (target: any, key, value) => {
        const arr = store[key as string];
        if (!arr) {
          return false;
        }
        arr[entity] = value;
        return true;
      },
      get: (target: any, key) => {
        if (key === "type") {
          return type;
        }
        const arr = store[key as string];
        if (!arr) {
          return undefined;
        }
        const value = arr[entity];
        if (component.booleanKeys?.has(key as string)) return !!value;
        return value;
      },
      ownKeys: () => {
        return getComponentOwnKeys(component);
      },
      getOwnPropertyDescriptor: (target: any, key) => {
        if (key === "type") {
          return {
            value: type,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Object.getOwnPropertyDescriptor(store, key);
      },
    }
  );

  return component.proxies[entity];
};

export const sortComponentQueries = (world: World, component: typeof Schema) => {
  const worldComponent = world["componentMap"].get(component);
  if (!worldComponent) return;
  const { queries } = worldComponent;
  const sortedQueries = queries.sort((a, b) => {
    const aCount = a.queryKey.split("|").length;
    const bCount = b.queryKey.split("|").length;
    return aCount - bCount ? aCount - bCount : a.queryKey.localeCompare(b.queryKey);
  });
  worldComponent.queries = sortedQueries;
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

  const world: World = Object.assign(worldFn, {
    entityCursor: 0,
    frame: 0,
    componentMap: new Map<typeof Schema, WorldComponent>(),
    componentList: [],
    componentSchemaStore: new Map<Store, WorldComponent>(),
    entityMasks: [new Uint32Array(size ?? 1000)],
    size: size ?? 1000,
    bitflag: 1,
    entitySparseSet: SparseSet(),
    removed: [],
    queryMap: new Map<string, Query>(),
    dirtyQueries: new Set<Query>(),
    queries: new Set<any>(),
    systemQueryMap: new Map<string, SystemImpl[]>(),
    systems: [],
    drawSystems: [],
  });

  componentList.forEach((component) => {
    registerComponent(world, component);
  });

  systemManualList.forEach(([SystemConstructor, components]) => {
    const $query = components
      .map((c) => c.type)
      .sort()
      .join("|");
    const query = defineQuery(components);
    query(world);

    const system = new SystemConstructor(query);

    if (world.systemQueryMap.has($query)) {
      const existingSystems = world.systemQueryMap.get($query)!;
      world.systemQueryMap.set($query, [...existingSystems, system]);
    } else {
      world.systemQueryMap.set($query, [system]);
    }

    world.systems.push(system);
  });

  systemRunList.forEach(([SystemConstructor, components]) => {
    const $query = components
      .map((c) => c.type)
      .sort()
      .join("|");
    const query = defineQuery(components);
    query(world);

    const system = new SystemConstructor(query);

    if (world.systemQueryMap.has($query)) {
      const existingSystems = world.systemQueryMap.get($query)!;
      world.systemQueryMap.set($query, [...existingSystems, system]);
    } else {
      world.systemQueryMap.set($query, [system]);
    }

    world.systems.push(system);
  });

  drawSystemRunList.forEach(([SystemConstructor, components]) => {
    const $query = components
      .map((c) => c.type)
      .sort()
      .join("|");
    const query = defineQuery(components);
    query(world);
    const system = new SystemConstructor(query);

    if (world.systemQueryMap.has($query)) {
      const existingSystems = world.systemQueryMap.get($query)!;
      world.systemQueryMap.set($query, [...existingSystems, system]);
    } else {
      world.systemQueryMap.set($query, [system]);
    }

    world.drawSystems.push(system);
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
  const changedQueries = new Set<Query>();

  world.queries.forEach((q) => {
    if (q.queryKey.includes(schema.type)) {
      queries.push(q);
    }
  });

  const worldComponent: WorldComponent = {
    type: schema.type,
    generationId: world["entityMasks"].length - 1,
    bitflag: world["bitflag"],
    store: schema.createStore(world["size"]),
    queries,
    changedQueries,
    proxies: [],
    schema: schema,
    booleanKeys: (schema as any).__booleanKeys || null,
  };
  world["componentMap"].set(schema, worldComponent);

  world.componentList.push(worldComponent);
  world.componentSchemaStore.set(worldComponent.store, worldComponent);

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

export const stepWorld = (world: World) => {
  world.frame++;
  for (let i = 0; i < systemRunList.length; i++) {
    const system = getSystem(world, systemRunList[i][0]);
    if (system.query(world).length) {
      system.runAll(world);
    }
  }
};

export const stepWorldDraw = (world: ReadOnlyWorld) => {
  const systems = world.drawSystems;
  for (let i = 0; i < systems.length; i++) {
    const system = systems[i];
    if (system.query(world).length) {
      system.runAll(world);
    }
  }
};

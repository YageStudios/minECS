/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable prefer-const */
import { Base64 } from "js-base64";

import type { Schema } from "./Schema";
import {
  NULL_FLAG,
  SERIALIZER_VERSION,
  SERIALIZER_MIN_VERSION,
  UNDEFINED_FLAG,
  configInfo,
  getSerialPlan,
  readLatin1,
  type ValueConfig,
} from "./Serialize";
import { SparseSet } from "./SparseSet";
import { resetStore } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { componentKeyMap } from "./Component";
import {
  addComponent,
  createWorld,
  getWorldCapacity,
  hasComponent,
  rebuildComponentBitTable,
  sortComponentQueries,
  updateReuseThreshold,
} from "./World";
import { $queryOrder, queryAddEntity, queryCheckEntity } from "./Query";

function reviver(key: string, value: any) {
  if (typeof value === "object" && value !== null) {
    if (value.dataType === "Map") {
      return new Map(value.value);
    }
    if (value.dataType === "Set") {
      return new Set(value.value);
    }
  }
  return value;
}

// Out-parameter for deserializeValue (avoids allocating a [where, value] tuple per value).
let valueOut: any = undefined;

const deserializeValue = (
  where: number,
  view: DataView,
  bytes: Uint8Array,
  key: string,
  config: ValueConfig,
  complexData: any,
): number => {
  const flag = view.getUint8(where);
  if (flag === NULL_FLAG) {
    valueOut = null;
    return where + 1;
  }
  if (flag === UNDEFINED_FLAG) {
    valueOut = undefined;
    return where + 1;
  }
  where += 1;

  const info = configInfo(config);

  switch (info.type) {
    case "string": {
      const length = view.getUint8(where);
      where += 1;
      valueOut = readLatin1(bytes, where, length);
      return where + length;
    }
    case "array": {
      const count = view.getUint16(where);
      where += 2;
      const array = new Array(count);
      for (let i = 0; i < count; i++) {
        where = deserializeValue(where, view, bytes, "index", config.items, complexData);
        array[i] = valueOut;
      }
      valueOut = array;
      return where;
    }
    case "number": {
      valueOut = view.getFloat64(where);
      return where + 8;
    }
    case "boolean": {
      valueOut = view.getUint8(where) === 1;
      return where + 1;
    }
    case "object": {
      if (info.complex) {
        valueOut = complexData[key];
        return where;
      }
      const objectValue: any = {};
      const properties = config.properties!;
      const keys = Object.keys(properties);
      for (let i = 0; i < keys.length; i++) {
        const propKey = keys[i];
        where = deserializeValue(where, view, bytes, propKey, properties[propKey], complexData?.[propKey]);
        objectValue[propKey] = valueOut;
      }
      valueOut = objectValue;
      return where;
    }
    default:
      throw new Error(`Unsupported object type: ${config.type}`);
  }
};

const deserializeFauxProp = (
  where: number,
  eid: number,
  view: DataView,
  bytes: Uint8Array,
  prop: any,
  key: string,
  config: ValueConfig,
  complexData: undefined | any,
): number => {
  if (complexData !== undefined) {
    // Already decoded (and revived) as part of the trailing JSON block.
    prop[eid] = complexData;
    return where + 1;
  }

  where = deserializeValue(where, view, bytes, key, config, undefined);
  const value = valueOut;
  valueOut = undefined;
  if (value !== undefined) {
    prop[eid] = value;
  }

  return where;
};

const deserializeEntityBuffer = (world: World, where: number, view: DataView, bytes: Uint8Array) => {
  const columns = getSerialPlan(world);
  const entitySize = view.getUint32(where);
  where += 4;

  const complexWhere = where + entitySize + 4;
  const complexSize = view.getUint32(where + entitySize);

  const complexEntityData = JSON.parse(readLatin1(bytes, complexWhere, complexSize), reviver);
  const entityMasks = world.entityMasks;

  while (where < complexWhere - 4) {
    // pid
    const pid = view.getUint16(where);
    where += 2;

    // entity count
    const entityCount = view.getUint32(where);
    where += 4;

    // component property and its per-column invariants (resolved once per world layout)
    const column = columns[pid];
    const prop: any = column.prop;
    const schema = column.schema;
    const componentType = column.componentType;
    const worldComponent = column.component;
    const masks = worldComponent ? entityMasks[worldComponent.generationId] : null;
    const bitflag = worldComponent ? worldComponent.bitflag : 0;
    const isTagComponent = column.isTagComponent;
    const kind = column.kind;
    const elementIO = column.elementIO;
    const indexIO = column.indexIO;
    const indexBytes = column.indexBytes;
    const fauxKey = column.fauxKey;
    const fauxConfig = column.fauxConfig!;

    // Get the entities and set their prop values
    for (let i = 0; i < entityCount; i++) {
      const eid = view.getUint32(where);
      where += 4;

      const isMember = masks ? (masks[eid] & bitflag) === bitflag : hasComponent(world, schema, eid);
      if (!isMember) {
        addComponent(world, schema, eid);
      }

      if (isTagComponent) {
        continue;
      }

      if (kind === 1) {
        const array = prop[eid];
        const idxIO = indexIO!;
        const elemIO = elementIO!;
        const elemBytes = elemIO.bytes;
        const count = idxIO.read(view, where);
        where += indexBytes;

        // iterate over count
        for (let j = 0; j < count; j++) {
          const index = idxIO.read(view, where);
          where += indexBytes;

          array[index] = elemIO.read(view, where);
          where += elemBytes;
        }
      } else if (kind === 2) {
        const elemIO = elementIO!;
        prop[eid] = elemIO.read(view, where);
        where += elemIO.bytes;
      } else {
        where = deserializeFauxProp(
          where,
          eid,
          view,
          bytes,
          prop,
          fauxKey,
          fauxConfig,
          complexEntityData[eid]?.[componentType]?.[fauxKey],
        );
      }
    }
  }
};

/** Reads an entity id or count, written as uint32 when `wide` and uint16 otherwise. */
const readIndex = (view: DataView, where: number, wide: boolean) =>
  wide ? view.getUint32(where) : view.getUint16(where);

const readDenseFromBuffer = (where: number, view: DataView, wide: boolean): [number, number[]] => {
  const step = wide ? 4 : 2;
  const missing = wide ? 0xffffffff : 0xffff;
  const denseLength = readIndex(view, where, wide);
  where += step;
  const dense: number[] = new Array(denseLength);
  for (let i = 0; i < denseLength; i++) {
    const value = readIndex(view, where, wide);
    dense[i] = value === missing ? -1 : value;
    where += step;
  }
  return [where, dense];
};

const deserializeString = (where: number, view: DataView, bytes: Uint8Array): [number, string] => {
  const length = view.getUint16(where);
  where += 2;
  const str = readLatin1(bytes, where, length);
  where += length;
  return [where, str];
};

const deserializeNumberObject = (where: number, view: DataView): [number, { [key: number]: number }] => {
  const numObj: { [key: number]: number } = {};

  const length = view.getUint16(where);
  where += 2;

  for (let i = 0; i < length; i++) {
    const key = view.getUint32(where);
    where += 4;
    const value = view.getFloat64(where);
    where += 8;
    numObj[key] = value;
  }

  return [where, numObj];
};

const deserializeNumberArray = (where: number, view: DataView): [number, number[]] => {
  const length = view.getUint16(where);
  where += 2;
  const arr: number[] = [];
  for (let i = 0; i < length; i++) {
    arr.push(view.getFloat64(where));
    where += 8;
  }

  return [where, arr];
};

const deserializeUintArray = (where: number, view: DataView, wide: boolean): [number, number[]] => {
  const step = wide ? 4 : 2;
  const length = readIndex(view, where, wide);
  where += step;
  const arr: number[] = new Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = readIndex(view, where, wide);
    where += step;
  }

  return [where, arr];
};

const maxGenerationIdOf = (world: World) => {
  let max = -Infinity;
  world.componentMap.forEach((c) => {
    if (c.generationId > max) max = c.generationId;
  });
  return max;
};

/****************************************************
 *
 * In-place layout updates
 *
 * Deserialization updates the world's existing WorldComponent and Query objects instead of replacing
 * them. That keeps accessor objects (`world(C, eid)`), systems' bound queries and the serializer's
 * column plan valid across deserialize/applyDelta, and keeps componentList, componentSchemaStore and
 * componentMap pointing at the same objects.
 *
 ****************************************************/

type ComponentLayoutEntry = { type: string; generationId: number; bitflag: number };

const applyComponentLayout = (
  world: World,
  entries: ComponentLayoutEntry[],
  payloadBitflag: number,
  resetStores: boolean,
) => {
  const oldMap = world.componentMap;
  const schemas: (typeof Schema)[] = new Array(entries.length);
  let sameOrder = oldMap.size === entries.length;
  let layoutChanged = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const schema = componentKeyMap.get(entry.type)!;
    schemas[i] = schema;
    const component = oldMap.get(schema);
    if (!component) throw new Error(`minECS - component ${entry.type} is not registered in this world`);
    if (component.generationId !== entry.generationId || component.bitflag !== entry.bitflag) {
      component.generationId = entry.generationId;
      component.bitflag = entry.bitflag;
      layoutChanged = true;
    }
    if (resetStores) resetStore(component.store);
  }

  if (sameOrder) {
    let i = 0;
    for (const schema of oldMap.keys()) {
      if (schema !== schemas[i++]) {
        sameOrder = false;
        break;
      }
    }
  }

  world.bitflag = payloadBitflag;
  if (!sameOrder) {
    // Serialized order defines column ids, so the map follows it. Components the payload does not
    // mention go at the end, with fresh bits allocated after the payload's last one (as
    // registerComponent would) so they cannot collide with a payload component's bit.
    const map = new Map<typeof Schema, WorldComponent>();
    for (let i = 0; i < schemas.length; i++) map.set(schemas[i], oldMap.get(schemas[i])!);
    let generationId = 0;
    for (let i = 0; i < entries.length; i++)
      if (entries[i].generationId > generationId) generationId = entries[i].generationId;
    // incrementBitflag starts a new generation when the bit wraps back to 1.
    if (entries.length && payloadBitflag === 1) generationId++;
    oldMap.forEach((component, schema) => {
      if (map.has(schema)) return;
      component.generationId = generationId;
      component.bitflag = world.bitflag;
      world.bitflag *= 2;
      if (world.bitflag >= 2 ** 31) {
        world.bitflag = 1;
        generationId++;
      }
      if (resetStores) resetStore(component.store);
      map.set(schema, component);
    });
    world.componentMap = map;
    layoutChanged = true;
  }

  if (layoutChanged) rebuildComponentBitTable(world);
};

/** Makes sure entityMasks has a generation for every component in the world. */
const ensureMaskGenerations = (world: World, size: number) => {
  const max = maxGenerationIdOf(world);
  while (world.entityMasks.length <= max) world.entityMasks.push(new Uint32Array(size));
};

type QueryData = {
  name: string;
  queryKey: string;
  dense: number[];
  toRemoveDense: number[];
  masks: { [key: number]: number };
  generations: number[];
};

/**
 * Updates (or creates) the world's queries from serialized data. Returns the set of queries the
 * payload described and whether any new query object was created.
 */
const applyQueries = (world: World, data: QueryData[]): { seen: Set<Query>; created: boolean } => {
  const seen = new Set<Query>();
  let created = false;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    let query = world.queryMap.get(d.name);
    if (query) {
      query.reset(d.dense);
      query.toRemove.reset(d.toRemoveDense);
      query.masks = d.masks;
      query.generations = d.generations;
      query.queryKey = d.queryKey;
    } else {
      const set = SparseSet();
      set.reset(d.dense);
      const toRemove = SparseSet();
      toRemove.reset(d.toRemoveDense);
      query = Object.assign(set, {
        generations: d.generations,
        masks: d.masks,
        toRemove,
        queryKey: d.queryKey,
      });
      (query as any)[$queryOrder] = world.queries.size;
      world.queryMap.set(d.name, query);
      world.queries.add(query);
      created = true;
    }
    seen.add(query);
  }
  return { seen, created };
};

/** Recomputes membership for world queries that the payload did not describe. */
const clearRemovedEntityMasks = (world: World, previousDense: number[]) => {
  const alive = world.entitySparseSet;
  const masks = world.entityMasks;
  for (let i = 0; i < previousDense.length; i++) {
    const eid = previousDense[i];
    if (eid == null || alive.has(eid)) continue;
    for (let g = 0; g < masks.length; g++) masks[g][eid] = 0;
  }
};

/** Empties the world of entities and query membership, keeping its layout, size and frame. */
const clearEntities = (world: World) => {
  world.entitySparseSet.reset([]);
  world.removed = [];
  world.entityCursor = 0;
  for (let g = 0; g < world.entityMasks.length; g++) world.entityMasks[g].fill(0);
  world.componentMap.forEach((component) => resetStore(component.store));
  world.queryMap.forEach((query) => {
    query.reset();
    query.toRemove.reset();
  });
  world.dirtyQueries.clear();
};

const recomputeUnseenQueries = (world: World, seen: Set<Query>) => {
  world.queryMap.forEach((query) => {
    if (seen.has(query)) return;
    // Component bits may have moved, so the query's masks are rebuilt from its components.
    const masks: { [key: number]: number } = {};
    const generations: number[] = [];
    const types = query.queryKey.split("|");
    for (let i = 0; i < types.length; i++) {
      const component = world.componentMap.get(componentKeyMap.get(types[i])!);
      if (!component) continue;
      if (!masks[component.generationId]) {
        masks[component.generationId] = 0;
        generations.push(component.generationId);
      }
      masks[component.generationId] |= component.bitflag;
    }
    query.masks = masks;
    query.generations = generations;
    query.reset();
    query.toRemove.reset();
    const dense = world.entitySparseSet.dense;
    for (let i = 0; i < dense.length; i++) {
      const eid = dense[i];
      if (queryCheckEntity(world, query, eid)) queryAddEntity(query, eid);
    }
  });
};

/**
 * Entity data is applied with component→query links detached, so addComponent during deserialization
 * neither touches query membership nor fires system init hooks (membership comes from the payload).
 */
const detachComponentQueries = (world: World) => {
  const saved = new Map<WorldComponent, Query[]>();
  world.componentMap.forEach((component) => {
    saved.set(component, component.queries);
    component.queries = [];
  });
  return saved;
};

const reattachComponentQueries = (world: World, saved: Map<WorldComponent, Query[]>, rebuild: boolean) => {
  if (!rebuild) {
    saved.forEach((queries, component) => {
      component.queries = queries;
    });
    return;
  }
  world.componentMap.forEach((component) => {
    component.queries = [];
  });
  world.queryMap.forEach((query: Query) => {
    const components = query.queryKey.split("|");
    for (let i = 0; i < components.length; i++) {
      const component = componentKeyMap.get(components[i])!;
      world.componentMap.get(component)!.queries.push(query);
    }
  });
  world.componentMap.forEach((component) => {
    sortComponentQueries(world, component.schema);
  });
};

/****************************************************
 *
 * Binary
 *
 ****************************************************/

const toViews = (buffer: ArrayBuffer | ArrayBufferView) => {
  if (ArrayBuffer.isView(buffer)) {
    return {
      view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    };
  }
  return { view: new DataView(buffer), bytes: new Uint8Array(buffer) };
};

/**
 * Reads the world size from a binary payload's header, or returns null for a header-only (empty v4)
 * payload. Throws on an unsupported version.
 */
const readPayloadSize = (view: DataView): number | null => {
  const version = view.getUint16(0);
  if (version < SERIALIZER_MIN_VERSION || version > SERIALIZER_VERSION) {
    throw new Error(`Mismatched serializer version: ${version}, expected: ${SERIALIZER_VERSION}`);
  }
  let where = 3;
  if (where >= view.byteLength) return null;
  let wide = false;
  if (version >= 5) {
    const width = view.getUint8(where);
    where += 1;
    if (width !== 2 && width !== 4) throw new Error(`minECS - invalid index width ${width}`);
    wide = width === 4;
  }
  const step = wide ? 4 : 2;
  // entity list, free list, cursor, then size
  where += (readIndex(view, where, wide) + 1) * step;
  where += (readIndex(view, where, wide) + 1) * step;
  where += step;
  return readIndex(view, where, wide);
};

/** Throws, before anything is changed, when the payload holds more entities than the world's stores. */
const assertFits = (world: World, size: number) => {
  const capacity = getWorldCapacity(world);
  if (size > capacity) {
    throw new Error(
      `minECS - the payload is for a world of size ${size} but this world was created with size ${capacity}; ` +
        `create the target with createWorld(${size}) or call deserializeWorld without a world`,
    );
  }
};

export const deserializeFromBuffer = (
  world: World,
  buffer: ArrayBuffer | ArrayBufferView,
  options?: { skipStoreReset?: boolean },
) => {
  const { view, bytes } = toViews(buffer);

  const payloadSize = readPayloadSize(view);
  if (payloadSize !== null) assertFits(world, payloadSize);

  let where = 0;

  const version = view.getUint16(where);
  where += 2;

  // skip mode byte (0 = full, 1 = delta); full deserialization accepts either payload layout here
  where += 1;

  if (where >= view.byteLength) {
    // Header-only payload: older serializers wrote an empty world this way.
    clearEntities(world);
    return;
  }

  // v5 adds an index width byte (2 or 4); v4 always used 2.
  let wide = false;
  if (version >= 5) {
    const width = view.getUint8(where);
    where += 1;
    if (width !== 2 && width !== 4) throw new Error(`minECS - invalid index width ${width}`);
    wide = width === 4;
  }

  let entityDense: number[];
  [where, entityDense] = readDenseFromBuffer(where, view, wide);
  // A delta keeps the receiver's masks, so entities that were removed since the last frame have their
  // component bits cleared here (otherwise they would still report components, and pass them on to
  // whatever entity reuses the id).
  const previousDense = options?.skipStoreReset ? world.entitySparseSet.dense.slice() : null;
  world.entitySparseSet.reset(entityDense);
  if (previousDense) clearRemovedEntityMasks(world, previousDense);

  let removed: number[];
  [where, removed] = deserializeUintArray(where, view, wide);
  world.removed = removed;

  const entityCursor = readIndex(view, where, wide);
  where += wide ? 4 : 2;

  world.entityCursor = entityCursor;

  const size = readIndex(view, where, wide);
  where += wide ? 4 : 2;
  if (world.size !== size) {
    world.size = size;
    updateReuseThreshold(world);
  }

  const bitflag = view.getUint32(where);
  where += 4;

  const frame = view.getUint32(where);
  where += 4;
  world.frame = frame;

  const componentMapSize = view.getUint16(where);
  where += 2;

  const layout: ComponentLayoutEntry[] = new Array(componentMapSize);
  for (let i = 0; i < componentMapSize; i++) {
    let componentType: string;
    [where, componentType] = deserializeString(where, view, bytes);
    const generationId = view.getUint32(where);
    where += 4;
    const bitflag = view.getUint32(where);
    where += 4;
    layout[i] = { type: componentType, generationId, bitflag };
  }
  applyComponentLayout(world, layout, bitflag, !options?.skipStoreReset);
  if (!options?.skipStoreReset) world.entityMasks = [new Uint32Array(size)];
  ensureMaskGenerations(world, size);

  const queryMapSize = view.getUint16(where);
  where += 2;
  const queryData: QueryData[] = new Array(queryMapSize);
  for (let i = 0; i < queryMapSize; i++) {
    let name: string;
    [where, name] = deserializeString(where, view, bytes);
    let dense: number[];
    [where, dense] = readDenseFromBuffer(where, view, wide);
    let toRemoveDense: number[];
    [where, toRemoveDense] = readDenseFromBuffer(where, view, wide);
    let queryKey: string;
    [where, queryKey] = deserializeString(where, view, bytes);
    let masks: Record<number, number>;
    [where, masks] = deserializeNumberObject(where, view);
    let generations: number[];
    [where, generations] = deserializeNumberArray(where, view);
    queryData[i] = { name, queryKey, dense, toRemoveDense, masks, generations };
  }
  const { seen, created } = applyQueries(world, queryData);

  world.dirtyQueries.clear();
  const dirtyQueriesSize = view.getUint16(where);
  where += 2;
  for (let i = 0; i < dirtyQueriesSize; i++) {
    let queryName: string;
    [where, queryName] = deserializeString(where, view, bytes);
    world.dirtyQueries.add(world.queryMap.get(queryName)!);
  }

  const savedQueries = detachComponentQueries(world);
  try {
    deserializeEntityBuffer(world, where, view, bytes);
  } finally {
    reattachComponentQueries(world, savedQueries, created);
  }

  if (seen.size !== world.queryMap.size) recomputeUnseenQueries(world, seen);
};

/****************************************************
 *
 * JSON
 *
 ****************************************************/

const toArrayLike = (value: any): ArrayLike<number> => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value as ArrayLike<number>;
  const out: number[] = [];
  for (const key in value) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0) out[index] = value[key];
  }
  return out;
};

const denseFromJSON = (dense: number[]) => dense.map((d) => (d === -1 ? null : d)) as number[];

export const deserializeFromJSON = (world: World, serializedWorld: SerializedWorld) => {
  assertFits(world, serializedWorld.size);
  world.entityCursor = serializedWorld.entityCursor;
  world.entitySparseSet.reset(serializedWorld.entitySparseSet.dense);
  world.removed = [...serializedWorld.removed];
  world.frame = serializedWorld.frame;

  applyComponentLayout(
    world,
    serializedWorld.componentMap.map(([type, value]) => ({
      type,
      generationId: value.generationId,
      bitflag: value.bitflag,
    })),
    serializedWorld.bitflag,
    true,
  );

  world.entityMasks = [new Uint32Array(serializedWorld.size)];
  ensureMaskGenerations(world, serializedWorld.size);

  const savedQueries = detachComponentQueries(world);
  let created = false;
  try {
    serializedWorld.entities.forEach((entity: any) => {
      const entityId = entity.entityId;
      Object.keys(entity.components).forEach((componentKey) => {
        const schema = componentKeyMap.get(componentKey)!;
        const component = world.componentMap.get(schema)!;
        const componentData = entity.components[componentKey];
        addComponent(world, schema, entityId);
        Object.keys(componentData).forEach((key) => {
          const column = component.store[key];
          const current = column[entityId];
          if (ArrayBuffer.isView(current)) {
            // Fixed-length array: copy into the column's own view. Through JSON text a typed array
            // arrives as an index-keyed object.
            (current as unknown as Float64Array).set(toArrayLike(componentData[key]));
          } else {
            column[entityId] = componentData[key];
          }
        });
      });
    });

    const queryMap = serializedWorld.queryMap;
    const queryData: QueryData[] = Object.keys(queryMap).map((name) => {
      const q: SerializedQuery = queryMap[name];
      return {
        name,
        queryKey: q.queryKey,
        dense: denseFromJSON(q.dense),
        toRemoveDense: denseFromJSON(q.toRemove.dense),
        masks: { ...q.masks },
        generations: [...q.generations],
      };
    });
    const applied = applyQueries(world, queryData);
    created = applied.created;

    world.dirtyQueries.clear();
    for (let i = 0; i < serializedWorld.dirtyQueries.length; i++) {
      const query = world.queryMap.get(serializedWorld.dirtyQueries[i]);
      if (query) world.dirtyQueries.add(query);
    }

    if (applied.seen.size !== world.queryMap.size) recomputeUnseenQueries(world, applied.seen);
  } finally {
    reattachComponentQueries(world, savedQueries, created);
  }

  return world;
};

/**
 * Loads a payload into `world`, or into a new world sized for the payload when none is given. A
 * given world must have been created at least as large as the payload's world.
 */
export const deserializeWorld = (
  serializedWorld: SerializedWorld | ArrayBuffer | ArrayBufferView | string,
  world?: World,
) => {
  if (serializedWorld instanceof ArrayBuffer || ArrayBuffer.isView(serializedWorld)) {
    world ??= createWorld(readPayloadSize(toViews(serializedWorld).view) ?? undefined);
    deserializeFromBuffer(world, serializedWorld);
    return world;
  } else if (typeof serializedWorld === "string") {
    const bytes = Base64.toUint8Array(serializedWorld);
    world ??= createWorld(readPayloadSize(toViews(bytes).view) ?? undefined);
    deserializeFromBuffer(world, bytes);
    return world;
  } else {
    world ??= createWorld((serializedWorld as SerializedWorld).size);
    return deserializeFromJSON(world, serializedWorld as SerializedWorld);
  }
};

export const applyDelta = (buffer: ArrayBuffer | ArrayBufferView, world: World) => {
  const { view } = toViews(buffer);
  // read mode byte after version (2 bytes)
  const mode = view.getUint8(2);
  if (mode !== 1) {
    throw new Error(`applyDelta expects delta mode (1), got: ${mode}`);
  }
  deserializeFromBuffer(world, buffer, { skipStoreReset: true });
};

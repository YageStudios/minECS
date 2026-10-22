/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable prefer-const */
import { Base64 } from "js-base64";

import type { Schema } from "./Schema";
import {
  INDEX_IO,
  NULL_FLAG,
  SERIALIZER_VERSION,
  UNDEFINED_FLAG,
  readLatin1,
  typedIOFor,
  type TypedIO,
} from "./Serialize";
import { SparseSet } from "./SparseSet";
import type { Store } from "./Storage";
import { $indexBytes, $indexType, $parentArray, $storeBase, $storeFlattened, $tagStore, resetStore } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { componentKeyMap, componentList } from "./Component";
import {
  getComponentSchema,
  hasComponent,
  addComponent,
  sortComponentQueries,
  createWorld,
  prepareWorldComponent,
  rebuildComponentBitTable,
} from "./World";
import { $queryOrder } from "./Query";

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

type ValueConfig = {
  type: string;
  properties?: {
    [key: string]: { type: string; key: string; properties?: any; items?: any };
  };
  items?: any;
};

const configType = (config: ValueConfig): string =>
  Array.isArray(config.type) ? (config.type as string[]).filter((t) => t !== "null").join("|") : config.type;

const deserializeValue = (
  where: number,
  eid: number,
  view: DataView,
  bytes: Uint8Array,
  key: string,
  config: ValueConfig,
  complexData: any
): [number, any] => {
  const flag = view.getUint8(where);
  if (flag === NULL_FLAG) {
    return [where + 1, null];
  }
  if (flag === UNDEFINED_FLAG) {
    return [where + 1, undefined];
  }
  where += 1;

  const type = configType(config);

  switch (type) {
    case "string": {
      const length = view.getUint8(where);
      where += 1;
      const str = readLatin1(bytes, where, length);
      where += length;
      return [where, str];
    }
    case "array": {
      const count = view.getUint16(where);
      where += 2;
      const array = new Array(count);
      for (let i = 0; i < count; i++) {
        let value = undefined;
        [where, value] = deserializeValue(where, eid, view, bytes, "index", config.items, complexData);
        array[i] = value;
      }

      return [where, array];
    }
    case "number": {
      const value = view.getFloat64(where);
      where += 8;

      return [where, value];
    }
    case "boolean": {
      const value = view.getUint8(where) === 1;
      where += 1;

      return [where, value];
    }
    case "object": {
      const objectValue: any = {};
      if (
        !config.properties ||
        Object.values(config.properties).find((p: { type: string }) => p.type === "object" || p.type === "array")
      ) {
        return [where, complexData[key]];
      } else {
        const properties = config.properties;
        const keys = Object.keys(properties);
        for (let i = 0; i < keys.length; i++) {
          const propKey = keys[i];
          let value = undefined;
          [where, value] = deserializeValue(where, eid, view, bytes, propKey, properties[propKey], complexData?.[propKey]);
          objectValue[propKey] = value;
        }
      }
      return [where, objectValue];
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
  complexData: undefined | any
): number => {
  if (complexData) {
    where += 1;
    prop[eid] = JSON.parse(complexData, reviver);
    return where;
  }

  let value = undefined;
  [where, value] = deserializeValue(where, eid, view, bytes, key, config, undefined);
  if (value !== undefined) {
    prop[eid] = value;
  }

  return where;
};

type PropKind = 0 | 1 | 2 | 3; // tag | subarray | typed | faux

const deserializeEntityBuffer = (world: World, where: number, view: DataView, bytes: Uint8Array) => {
  const deserializedEntities = new Set<number>();
  const componentProps: Store[] = [];
  world["componentMap"].forEach((c) => {
    if (c.store[$storeFlattened].length) componentProps.push(...c.store[$storeFlattened]);
    else componentProps.push(c.store);
  });
  const entitySize = view.getUint32(where);
  where += 4;

  const complexWhere = where + entitySize + 4;
  const complexSize = view.getUint32(where + entitySize);

  const complexEntityData = JSON.parse(readLatin1(bytes, complexWhere, complexSize), reviver);
  const entityMasks = world["entityMasks"];

  while (where < complexWhere - 4) {
    // pid
    const pid = view.getUint16(where);
    where += 2;

    // entity count
    const entityCount = view.getUint32(where);
    where += 4;

    // component property and its per-column invariants (hoisted out of the entity loop)
    const prop: any = componentProps[pid];
    const store = prop[$storeBase]();
    const component = getComponentSchema(world, store);
    const schema = component.schema;
    const componentType = component.type;
    const worldComponent = world["componentMap"].get(schema);
    const masks = worldComponent ? entityMasks[worldComponent.generationId] : null;
    const bitflag = worldComponent ? worldComponent.bitflag : 0;
    const isTagComponent = store[$storeFlattened].length === 0;

    const kind: PropKind = prop[$tagStore]
      ? 0
      : Array.isArray(prop) && (prop as any)[$parentArray]
        ? 1
        : ArrayBuffer.isView(prop)
          ? 2
          : 3;
    const elementIO: TypedIO | null = kind === 1 ? typedIOFor(prop[$parentArray]) : kind === 2 ? typedIOFor(prop) : null;
    const indexIO: TypedIO | null = kind === 1 ? INDEX_IO[prop[$indexType] as string] : null;
    const indexBytes: number = kind === 1 ? prop[$indexBytes] : 0;
    const fauxKey: string = kind === 3 ? prop._key : "";
    const fauxConfig: ValueConfig = kind === 3 ? schema.schema.properties[fauxKey] : null;

    // Get the entities and set their prop values
    for (let i = 0; i < entityCount; i++) {
      const eid = view.getUint32(where); // throws with [changed, c, changed]
      where += 4;

      const isMember = masks ? (masks[eid] & bitflag) === bitflag : hasComponent(world, schema, eid);
      if (!isMember) {
        addComponent(world, schema, eid);
      }
      // add eid to deserialized ents after it has been transformed by MAP mode
      deserializedEntities.add(eid);

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
          complexEntityData[eid]?.[componentType]?.[fauxKey]
        );
      }
    }
  }
  const ents = Array.from(deserializedEntities);

  deserializedEntities.clear();

  return ents;
};

const deserializeSparseSetFromBuffer = (where: number, view: DataView): [number, ReturnType<typeof SparseSet>] => {
  const set = SparseSet();

  const denseLength = view.getUint16(where);
  where += 2;
  const dense: number[] = new Array(denseLength);
  for (let i = 0; i < denseLength; i++) {
    const value = view.getUint16(where);
    dense[i] = value === 65535 ? -1 : value;
    where += 2;
  }
  set.reset(dense);

  return [where, set];
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

const deserializeUintArray = (where: number, view: DataView): [number, number[]] => {
  const length = view.getUint16(where);
  where += 2;
  const arr: number[] = [];
  for (let i = 0; i < length; i++) {
    arr.push(view.getUint16(where));
    where += 2;
  }

  return [where, arr];
};

const deserializeQueryFromBuffer = (where: number, view: DataView, bytes: Uint8Array): [number, Query] => {
  let q: ReturnType<typeof SparseSet>;
  [where, q] = deserializeSparseSetFromBuffer(where, view);

  let toRemove: ReturnType<typeof SparseSet>;
  [where, toRemove] = deserializeSparseSetFromBuffer(where, view);

  let queryKey: string;
  [where, queryKey] = deserializeString(where, view, bytes);

  let masks: Record<number, number>;
  [where, masks] = deserializeNumberObject(where, view);

  let generations: number[];
  [where, generations] = deserializeNumberArray(where, view);

  const query: Query = Object.assign(q, {
    toRemove,
    queryKey,
    masks,
    generations,
  });

  return [where, query];
};

const maxGenerationIdOf = (world: World) => {
  let max = -Infinity;
  world.componentMap.forEach((c) => {
    if (c.generationId > max) max = c.generationId;
  });
  return max;
};

export const deserializeFromBuffer = (world: World, buffer: ArrayBuffer, options?: { skipStoreReset?: boolean }) => {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let where = 0;

  const version = view.getUint16(where);
  where += 2;

  if (version !== SERIALIZER_VERSION) {
    throw new Error(`Mismatched serializer version: ${version}, expected: ${SERIALIZER_VERSION}`);
  }

  // skip mode byte (0 = full, 1 = delta); full deserialization accepts either payload layout here
  where += 1;

  let entitySparseSet: ReturnType<typeof SparseSet>;
  [where, entitySparseSet] = deserializeSparseSetFromBuffer(where, view);
  world.entitySparseSet.reset(entitySparseSet.dense);

  let removed: number[];
  [where, removed] = deserializeUintArray(where, view);
  world.removed = removed;

  const entityCursor = view.getUint16(where);
  where += 2;

  world.entityCursor = entityCursor;

  const size = view.getUint16(where);
  where += 2;
  world.size = size;

  const bitflag = view.getUint32(where);
  where += 4;
  world.bitflag = bitflag;

  if (!options?.skipStoreReset) {
    world.entityMasks = [new Uint32Array(size)];
    const maxGenerationId = maxGenerationIdOf(world);
    for (let i = 1; i <= maxGenerationId; i++) {
      world.entityMasks.push(new Uint32Array(size));
    }
  }

  const frame = view.getUint32(where);
  where += 4;
  world.frame = frame;

  const componentMapSize = view.getUint16(where);
  where += 2;

  const worldComponentMap = new Map<typeof Schema, WorldComponent>();

  for (let i = 0; i < componentMapSize; i++) {
    let componentType: string;
    [where, componentType] = deserializeString(where, view, bytes);
    const schema = componentKeyMap.get(componentType)!;

    const generationId = view.getUint32(where);
    where += 4;

    const bitflag = view.getUint32(where);
    where += 4;

    const component = world.componentMap.get(schema)!;

    const worldComponent: WorldComponent = prepareWorldComponent({
      type: componentType,
      schema: schema,
      proxies: [],
      generationId: generationId,
      bitflag: bitflag,
      queries: [],
      store: component.store,
      booleanKeys: (schema as any).__booleanKeys || null,
    });

    if (!options?.skipStoreReset) {
      resetStore(component.store);
    }
    worldComponentMap.set(schema, worldComponent);
  }
  world.componentMap = worldComponentMap;
  rebuildComponentBitTable(world);

  const worldQueryMap = new Map<string, Query>();
  const queryMapSize = view.getUint16(where);
  where += 2;
  for (let i = 0; i < queryMapSize; i++) {
    let queryName: string;
    [where, queryName] = deserializeString(where, view, bytes);

    let query: Query;
    [where, query] = deserializeQueryFromBuffer(where, view, bytes);

    worldQueryMap.set(queryName, query);
  }
  world.queryMap = worldQueryMap;

  world.dirtyQueries = new Set<Query>();
  const dirtyQueriesSize = view.getUint16(where);
  where += 2;
  for (let i = 0; i < dirtyQueriesSize; i++) {
    let queryName: string;
    [where, queryName] = deserializeString(where, view, bytes);
    world.dirtyQueries.add(world.queryMap.get(queryName)!);
  }

  deserializeEntityBuffer(world, where, view, bytes);

  world.queryMap.forEach((query: Query) => {
    const components = query.queryKey.split("|");
    components.forEach((componentKey) => {
      const component = componentKeyMap.get(componentKey)!;
      world.componentMap.get(component)!.queries.push(query);
    });
  });

  componentList.forEach((component) => {
    sortComponentQueries(world, component);
  });
};

const deserializeSparseSet = (set: { dense: number[]; sparse: number[] }) => {
  const newSet = SparseSet();
  newSet.reset(set.dense.map((d) => (d === -1 ? null : d)) as number[]);
  return newSet;
};

const deserializeQuery = (q: SerializedQuery): Query => {
  const query = deserializeSparseSet(q);
  const toRemove = deserializeSparseSet(q.toRemove);
  const masks = { ...q.masks };
  const generations = [...q.generations];

  return Object.assign(query, {
    generations,
    masks,
    toRemove,
    queryKey: q.queryKey,
  });
};

export const deserializeFromJSON = (world: World, serializedWorld: SerializedWorld) => {
  world.entityCursor = serializedWorld.entityCursor;
  world.entitySparseSet.reset(serializedWorld.entitySparseSet.dense);
  world.removed = [...serializedWorld.removed];
  world.frame = serializedWorld.frame;
  world.componentMap = new Map(
    serializedWorld.componentMap.map(([key, value]) => {
      const schema = componentKeyMap.get(key)!;
      const component = world.componentMap.get(schema)!;

      resetStore(component.store);
      return [
        schema,
        prepareWorldComponent({
          generationId: value.generationId,
          bitflag: value.bitflag,
          queries: [],
          store: component.store,
          proxies: [],
          type: key,
          schema,
          booleanKeys: (schema as any).__booleanKeys || null,
        } as WorldComponent),
      ];
    })
  );
  rebuildComponentBitTable(world);
  world.bitflag = serializedWorld.bitflag;

  world.entityMasks = [new Uint32Array(serializedWorld.size)];
  const maxGenerationId = maxGenerationIdOf(world);
  for (let i = 1; i <= maxGenerationId; i++) {
    world.entityMasks.push(new Uint32Array(serializedWorld.size));
  }

  serializedWorld.entities.forEach((entity: any) => {
    const entityId = entity.entityId;
    Object.keys(entity.components).forEach((componentKey) => {
      const schema = componentKeyMap.get(componentKey)!;
      const component = world.componentMap.get(schema)!;
      const componentData = entity.components[componentKey];
      addComponent(world, schema, entityId);
      Object.keys(componentData).forEach((key) => {
        component.store[key][entityId] = componentData[key];
      });
    });
  });

  world.dirtyQueries = new Set();

  const queryMap = serializedWorld.queryMap;
  Object.keys(queryMap).forEach((key) => {
    const query = deserializeQuery(queryMap[key]);
    (query as any)[$queryOrder] = world.queries.size;
    world.queryMap.set(key, query);
    world.queries.add(query);
    if (serializedWorld.dirtyQueries.includes(key)) {
      world.dirtyQueries.add(query);
    }
    query.queryKey.split("|").forEach((componentKey) => {
      const component = componentKeyMap.get(componentKey)!;
      world.componentMap.get(component)!.queries.push(query);
    });
  });

  return world;
};

export const deserializeWorld = (serializedWorld: SerializedWorld | ArrayBuffer | string, world = createWorld()) => {
  if (serializedWorld instanceof ArrayBuffer) {
    deserializeFromBuffer(world, serializedWorld);
    return world;
  } else if (typeof serializedWorld === "string") {
    const decodedBuffer = Base64.toUint8Array(serializedWorld).buffer;
    // @ts-ignore
    deserializeFromBuffer(world, decodedBuffer);
    return world;
  } else {
    return deserializeFromJSON(world, serializedWorld as SerializedWorld);
  }
};

export const applyDelta = (buffer: ArrayBuffer, world: World) => {
  const view = new DataView(buffer);
  // read mode byte after version (2 bytes)
  const mode = view.getUint8(2);
  if (mode !== 1) {
    throw new Error(`applyDelta expects delta mode (1), got: ${mode}`);
  }
  deserializeFromBuffer(world, buffer, { skipStoreReset: true });
};

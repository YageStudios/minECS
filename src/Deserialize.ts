/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable prefer-const */
import { Base64 } from "js-base64";

import type { Schema } from "./Schema";
import { NULL_FLAG, SERIALIZER_VERSION, UNDEFINED_FLAG } from "./Serialize";
import { SparseSet } from "./SparseSet";
import type { Store } from "./Storage";
import { $indexBytes, $indexType, $storeBase, $storeFlattened, resetStore } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { componentKeyMap, componentList } from "./Component";
import { getComponentSchema, hasComponent, addComponent, sortComponentQueries, createWorld } from "./World";

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

const deserializeValue = (
  where: number,
  eid: number,
  view: DataView,
  key: string,
  config: {
    type: string;
    properties?: {
      [key: string]: { type: string; key: string; properties?: any; items?: any };
    };
    items?: any;
  },
  complexData: any
): [number, any] => {
  if (view.getUint8(where) === NULL_FLAG) {
    return [where + 1, null];
  }
  if (view.getUint8(where) === UNDEFINED_FLAG) {
    return [where + 1, undefined];
  }
  where += 1;

  const type = Array.isArray(config.type) ? config.type.filter((t) => t !== "null").join("|") : config.type;

  switch (type) {
    case "string": {
      const length = view.getUint8(where);
      where += 1;

      let str = "";
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view.getUint8(where));
        where += 1;
      }

      return [where, str];
    }
    case "array": {
      const count = view.getUint16(where);
      where += 2;
      const array = new Array(count);
      for (let i = 0; i < count; i++) {
        let value = undefined;
        [where, value] = deserializeValue(where, eid, view, "index", config.items, complexData);
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
        Object.keys(config.properties).forEach((i) => {
          const key = i;
          const prop = config.properties![i];

          let value = undefined;
          [where, value] = deserializeValue(where, eid, view, key, prop, complexData?.[key]);
          objectValue[key] = value;
        });
      }
      return [where, objectValue];
    }
    default:
      throw new Error(`Unsupported object type: ${config.type}`);
  }
};

const deserializeProp = (
  where: number,
  eid: number,
  view: DataView,
  prop: any,
  type: string,
  schema: typeof Schema,
  complexData: undefined | any
): any => {
  if (type !== "Object") {
    // @ts-ignore
    const value = view[`get${type}`](where);
    where += prop.BYTES_PER_ELEMENT;

    prop[eid] = value;
    return where;
  }

  const config = schema.schema.properties[prop._key];
  let value = undefined;

  if (complexData) {
    where += 1;
    prop[eid] = JSON.parse(complexData, reviver);
    return where;
  }

  [where, value] = deserializeValue(where, eid, view, prop._key, config, undefined);
  if (value !== undefined) {
    prop[eid] = value;
  }

  return where;
};

const deserializeEntityBuffer = (world: World, where: number, view: DataView) => {
  const deserializedEntities = new Set();
  const componentProps: Store[] = [];
  world["componentMap"].forEach((c) => {
    if (c.store[$storeFlattened].length) componentProps.push(...c.store[$storeFlattened]);
    else componentProps.push(c.store);
  });
  const entitySize = view.getUint32(where);
  where += 4;

  const complexWhere = where + entitySize + 4;
  const complexSize = view.getUint32(where + entitySize);

  let complexDataString = "";
  for (let i = 0; i < complexSize; i++) {
    complexDataString += String.fromCharCode(view.getUint8(complexWhere + i));
  }
  const complexEntityData = JSON.parse(complexDataString, reviver);

  while (where < complexWhere - 4) {
    // pid
    const pid = view.getUint16(where);
    where += 2;

    // entity count
    const entityCount = view.getUint32(where);
    where += 4;

    // component property
    const prop = componentProps[pid];

    // Get the entities and set their prop values
    for (let i = 0; i < entityCount; i++) {
      const eid = view.getUint32(where); // throws with [changed, c, changed]
      where += 4;

      const store = prop[$storeBase]();
      const component = getComponentSchema(world, store);
      const schema = component.schema;

      if (!hasComponent(world, schema, eid)) {
        addComponent(world, schema, eid, false);
      }
      // add eid to deserialized ents after it has been transformed by MAP mode
      deserializedEntities.add(eid);

      if (store[$storeFlattened].length === 0) {
        continue;
      }

      if (ArrayBuffer.isView(prop[eid])) {
        const array = prop[eid];
        // @ts-ignore
        const count = view[`get${array[$indexType]}`](where);
        // @ts-ignore
        where += array[$indexBytes];

        // iterate over count
        for (let i = 0; i < count; i++) {
          // @ts-ignore
          const index = view[`get${array[$indexType]}`](where);
          // @ts-ignore
          where += array[$indexBytes];

          const value =
            // @ts-ignore
            view[`get${array.constructor.name.replace("Array", "")}`](where);
          // @ts-ignore
          where += array.BYTES_PER_ELEMENT;
          // @ts-ignore
          prop[eid][index] = value;
        }
      } else {
        const type = prop.constructor.name.replace("Array", "");
        where = deserializeProp(
          where,
          eid,
          view,
          prop,
          type,
          schema,
          complexEntityData[eid]?.[component.type]?.[(prop as any)._key]
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
  for (let i = 0; i < denseLength; i++) {
    set.dense.push(view.getUint16(where));
    if (set.dense[i] === 65535) set.dense[i] = -1;
    where += 2;
  }
  const sparseLength = view.getUint16(where);
  where += 2;
  for (let i = 0; i < sparseLength; i++) {
    set.sparse.push(view.getUint16(where));
    if (set.sparse[i] === 65535) set.sparse[i] = -1;
    where += 2;
  }

  return [where, set];
};

const deserializeString = (where: number, view: DataView): [number, string] => {
  // view.setUint16(where, str.length);
  // where += 2;
  // for (let i = 0; i < str.length; i++) {
  //   view.setUint8(where, str.charCodeAt(i));
  //   where += 1;
  // }
  const length = view.getUint16(where);
  where += 2;
  let str = "";
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(where));
    where += 1;
  }
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
  // view.setUint16(where, arr.length);
  // where += 2;
  // arr.forEach((a) => {
  //   view.setUint16(where, a);
  //   where += 2;
  // });

  const length = view.getUint16(where);
  where += 2;
  const arr: number[] = [];
  for (let i = 0; i < length; i++) {
    arr.push(view.getUint16(where));
    where += 2;
  }

  return [where, arr];
};

const deserializeQueryFromBuffer = (where: number, view: DataView): [number, Query] => {
  let q: ReturnType<typeof SparseSet>;
  [where, q] = deserializeSparseSetFromBuffer(where, view);

  let toRemove: ReturnType<typeof SparseSet>;
  [where, toRemove] = deserializeSparseSetFromBuffer(where, view);

  let entered: ReturnType<typeof SparseSet>;
  [where, entered] = deserializeSparseSetFromBuffer(where, view);

  let queryKey: string;
  [where, queryKey] = deserializeString(where, view);

  let masks: Record<number, number>;
  [where, masks] = deserializeNumberObject(where, view);

  let generations: number[];
  [where, generations] = deserializeNumberArray(where, view);

  const query: Query = Object.assign(q, {
    toRemove,
    entered,
    queryKey,
    masks,
    generations,
  });

  return [where, query];
};

export const deserializeFromBuffer = (world: World, buffer: ArrayBuffer) => {
  const view = new DataView(buffer);

  let where = 0;

  const version = view.getUint16(where);
  where += 2;

  if (version !== SERIALIZER_VERSION) {
    throw new Error(`Mismatched serializer version: ${version}, expected: ${SERIALIZER_VERSION}`);
  }

  let entitySparseSet: ReturnType<typeof SparseSet>;
  [where, entitySparseSet] = deserializeSparseSetFromBuffer(where, view);
  world.entitySparseSet.reset(entitySparseSet.dense, entitySparseSet.sparse);

  let removed: number[];
  [where, removed] = deserializeUintArray(where, view);
  world.removed = removed;

  const entityCursor = view.getUint16(where);
  where += 2;

  world.entityCursor = entityCursor;

  // view.setUint16(where, world.size);
  const size = view.getUint16(where);
  where += 2;
  world.size = size;

  const bitflag = view.getUint32(where);
  where += 4;
  world.bitflag = bitflag;

  world.entityMasks = [new Uint32Array(size)];
  const maxGenerationId = Math.max(...Array.from(world.componentMap.values()).map((c) => c.generationId));
  for (let i = 1; i <= maxGenerationId; i++) {
    world.entityMasks.push(new Uint32Array(size));
  }

  const frame = view.getUint32(where);
  where += 4;
  world.frame = frame;

  const componentMapSize = view.getUint16(where);
  where += 2;

  const worldComponentMap = new Map<typeof Schema, WorldComponent>();

  for (let i = 0; i < componentMapSize; i++) {
    let componentType: string;
    [where, componentType] = deserializeString(where, view);
    const schema = componentKeyMap.get(componentType)!;

    const generationId = view.getUint32(where);
    where += 4;

    const bitflag = view.getUint32(where);
    where += 4;

    const component = world.componentMap.get(schema)!;

    const worldComponent: WorldComponent = {
      type: componentType,
      schema: schema,
      proxies: [],
      generationId: generationId,
      bitflag: bitflag,
      queries: [],
      changedQueries: new Set<Query>(),
      store: component.store,
    };

    resetStore(component.store);
    worldComponentMap.set(schema, worldComponent);
  }
  world.componentMap = worldComponentMap;

  const worldQueryMap = new Map<string, Query>();
  const queryMapSize = view.getUint16(where);
  where += 2;
  for (let i = 0; i < queryMapSize; i++) {
    let queryName: string;
    [where, queryName] = deserializeString(where, view);

    let query: Query;
    [where, query] = deserializeQueryFromBuffer(where, view);

    worldQueryMap.set(queryName, query);
  }
  world.queryMap = worldQueryMap;

  world.dirtyQueries = new Set<Query>();
  const dirtyQueriesSize = view.getUint16(where);
  where += 2;
  for (let i = 0; i < dirtyQueriesSize; i++) {
    let queryName: string;
    [where, queryName] = deserializeString(where, view);
    world.dirtyQueries.add(world.queryMap.get(queryName)!);
  }

  deserializeEntityBuffer(world, where, view);

  Array.from(world.queryMap).forEach(([key, query]: [string, Query]) => {
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
  newSet.reset(
    set.dense.map((d) => (d === -1 ? null : d)) as number[],
    set.sparse.map((s) => (s === -1 ? null : s)) as number[]
  );
  return newSet;
};

const deserializeQuery = (q: SerializedQuery): Query => {
  const query = deserializeSparseSet(q);
  const toRemove = deserializeSparseSet(q.toRemove);
  const entered = deserializeSparseSet(q.entered);
  const masks = { ...q.masks };
  const generations = [...q.generations];

  return Object.assign(query, {
    generations,
    masks,
    toRemove,
    entered,
    queryKey: q.queryKey,
  });
};

export const deserializeFromJSON = (world: World, serializedWorld: SerializedWorld) => {
  world.entityCursor = serializedWorld.entityCursor;
  world.entitySparseSet.reset(serializedWorld.entitySparseSet.dense, serializedWorld.entitySparseSet.sparse);
  world.removed = [...serializedWorld.removed];
  world.frame = serializedWorld.frame;
  world.componentMap = new Map(
    serializedWorld.componentMap.map(([key, value]) => {
      const schema = componentKeyMap.get(key)!;
      const component = world.componentMap.get(schema)!;

      resetStore(component.store);
      return [
        schema,
        {
          generationId: value.generationId,
          bitflag: value.bitflag,
          queries: [],
          changedQueries: new Set<Query>(),
          store: component.store,
          proxies: [],
          type: key,
          schema,
        } as WorldComponent,
      ];
    })
  );
  world.bitflag = serializedWorld.bitflag;

  world.entityMasks = [new Uint32Array(serializedWorld.size)];
  const maxGenerationId = Math.max(...Array.from(world.componentMap.values()).map((c) => c.generationId));
  for (let i = 1; i <= maxGenerationId; i++) {
    world.entityMasks.push(new Uint32Array(serializedWorld.size));
  }

  serializedWorld.entities.forEach((entity: any) => {
    const entityId = entity.entityId;
    Object.keys(entity.components).forEach((componentKey) => {
      const schema = componentKeyMap.get(componentKey)!;
      const component = world.componentMap.get(schema)!;
      const componentData = entity.components[componentKey];
      addComponent(world, schema, entityId, false);
      Object.keys(componentData).forEach((key) => {
        component.store[key][entityId] = componentData[key];
      });
    });
  });

  world.dirtyQueries = new Set();

  const queryMap = serializedWorld.queryMap;
  Object.keys(queryMap).forEach((key) => {
    const query = deserializeQuery(queryMap[key]);
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

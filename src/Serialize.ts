import lodash from "lodash";
import type { Schema } from "./Schema";
import type { Store } from "./Storage";
import { $indexBytes, $indexType, $parentArray, $storeBase, $storeFlattened, $tagStore, createShadow } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { SerialMode } from "./Types";
import type { SparseSet } from "./SparseSet";
import { Base64 } from "js-base64";
import { getComponentSchema, hasComponent } from "./World";

const { cloneDeep, isEqual } = lodash;

type DeltaShadow =
  | { kind: "subarray"; symbol: symbol }
  | { kind: "typed"; symbol: symbol }
  | { kind: "faux"; values: Map<number, any> };

type DeltaState = {
  changedProps: Map<any, DeltaShadow>;
  storeEntityCache: Map<any, Set<number>>;
};

export const SERIALIZER_VERSION = 2;

function replacer(key: string, value: any) {
  if (value instanceof Map) {
    return {
      dataType: "Map",
      value: Array.from(value.entries()),
    };
  } else if (value instanceof Set) {
    return {
      dataType: "Set",
      value: Array.from(value),
    };
  } else {
    return value;
  }
}

export const UNDEFINED_FLAG = 255;
export const NULL_FLAG = 254;

const isPrimitiveValue = (value: any): boolean => {
  return value === null || (typeof value !== "object" && typeof value !== "function");
};

const cloneShadowValue = (value: any): any => {
  return isPrimitiveValue(value) ? value : cloneDeep(value);
};

const shadowValuesEqual = (a: any, b: any): boolean => {
  if (isPrimitiveValue(a) && isPrimitiveValue(b)) {
    return Object.is(a, b);
  }
  return isEqual(a, b);
};

const serializeValue = (
  where: number,
  eid: number,
  view: DataView,
  key: string,
  value: any,
  config: {
    type: string;
    properties?: {
      [key: string]: { type: string; key: string; properties?: any; items?: any };
    };
    items?: any;
  },
  complexEntityData: any | null,
  schema: typeof Schema
) => {
  if (value === null) {
    view.setUint8(where, NULL_FLAG);
    where += 1;
    return [where, complexEntityData];
  }
  if (value === undefined) {
    view.setUint8(where, UNDEFINED_FLAG);
    where += 1;
    return [where, complexEntityData];
  }
  view.setUint8(where, 0);
  where += 1;

  const type = Array.isArray(config.type) ? config.type.filter((t) => t !== "null").join("|") : config.type;

  switch (type) {
    case "string":
      view.setUint8(where, value.length);
      where += 1;
      for (let i = 0; i < value.length; i++) {
        view.setUint8(where, value.charCodeAt(i));
        where += 1;
      }
      break;
    case "object":
      if (
        !config.properties ||
        Object.values(config.properties).find((p: { type: string }) => p.type === "object" || p.type === "array")
      ) {
        // if (!complexEntityData[schema.type]) complexEntityData[schema.type] = {};
        // complexEntityData[schema.type][eid] = complexEntityData[schema.type][eid] || {};
        // complexEntityData[schema.type][eid][prop._key] = value;
        if (!complexEntityData) {
          complexEntityData = {};
        }
        complexEntityData[key] = value;
      } else if (config.properties) {
        Object.keys(config.properties).forEach((i) => {
          const key = i;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const prop = config.properties![i];
          [where, complexEntityData] = serializeValue(
            where,
            eid,
            view,
            key,
            value[key],
            prop,
            complexEntityData,
            schema
          );
        });
      }

      break;
    case "array":
      {
        const isComplexArray = config.items.type === "object" || config.items.type === "array";
        if (isComplexArray && value.length) {
          if (!complexEntityData) complexEntityData = {};
          complexEntityData[key] = [];
          for (let i = 0; i < value.length; i++) {
            complexEntityData[key][i] = value[i];
          }
        } else {
          view.setUint16(where, value.length);
          where += 2;
          let arrayComplexEntityData: any = null;

          for (let i = 0; i < value.length; i++) {
            let nestedComplexData = null;
            [where, nestedComplexData] = serializeValue(
              where,
              eid,
              view,
              "index",
              value[i],
              config.items,
              complexEntityData,
              schema
            );
            if (isComplexArray)
              if (nestedComplexData) {
                if (!arrayComplexEntityData) arrayComplexEntityData = [];
                arrayComplexEntityData[i] = nestedComplexData["index"];
              }
          }
          if (arrayComplexEntityData) {
            if (!complexEntityData) complexEntityData = {};
            complexEntityData[key] = arrayComplexEntityData;
          }
        }
      }
      break;
    case "number":
      view.setFloat64(where, value);
      where += 8;
      break;
    case "boolean":
      view.setUint8(where, value ? 1 : 0);
      where += 1;
      break;
    default:
      throw new Error(`Unsupported object type: ${config.type}`);
  }

  return [where, complexEntityData];
};

const serialzeProp = (
  where: number,
  eid: number,
  view: DataView,
  prop: any,
  type: string,
  schema: typeof Schema
): [number, null | any] => {
  if (type !== "Object") {
    // set value next [type] bytes
    // @ts-ignore
    view[`set${type}`](where, prop[eid]);
    where += prop.BYTES_PER_ELEMENT;
    return [where, null];
  }

  const config = schema.schema.properties[prop._key];
  let propComplexData = null;
  [where, propComplexData] = serializeValue(where, eid, view, prop._key, prop[eid], config, propComplexData, schema);

  return [where, propComplexData];
};

const serializeEntities = (world: World, where: number, view: DataView, deltaState?: DeltaState): number => {
  const worldSerializer = true;

  const changedProps = deltaState ? deltaState.changedProps : new Map<any, DeltaShadow>();
  let componentProps = [] as Store[];
  const storeEntityCache = deltaState ? deltaState.storeEntityCache : null;

  const complexEntityData: any = {};
  if (worldSerializer) {
    componentProps = [];
    world["componentMap"].forEach((c) => {
      if (c.store[$storeFlattened].length) componentProps.push(...c.store[$storeFlattened]);
      else componentProps.push(c.store);
    });
  }

  const whereEntitySize = where;
  where += 4;

  const ents = world["entitySparseSet"].dense;

  const storeEntityListCache = new Map<any, number[]>();
  const storeNewlyAddedCache = deltaState ? new Map<any, Set<number>>() : null;

  // iterate over component props
  for (let pid = 0; pid < componentProps.length; pid++) {
    const prop = componentProps[pid];
    const store = prop[$storeBase]();
    const component = getComponentSchema(world, store);
    const schema = component.schema;
    const componentMasks = world["entityMasks"][component.generationId];
    const componentBitflag = component.bitflag;
    const deltaShadow = changedProps.get(prop);
    // @ts-ignore
    const shadow = deltaShadow && "symbol" in deltaShadow ? prop[deltaShadow.symbol] : null;

    let storeEntities = storeEntityListCache.get(store);
    if (!storeEntities) {
      storeEntities = [];
      for (let i = 0; i < ents.length; i++) {
        const eid = ents[i];
        if ((componentMasks[eid] & componentBitflag) === componentBitflag) {
          storeEntities.push(eid);
        }
      }
      storeEntityListCache.set(store, storeEntities);

      if (storeEntityCache && storeNewlyAddedCache) {
        const prevMembers = storeEntityCache.get(store) || new Set<number>();
        const nextMembers = new Set<number>();
        const newlyAdded = new Set<number>();

        for (let i = 0; i < storeEntities.length; i++) {
          const eid = storeEntities[i];
          nextMembers.add(eid);
          if (!prevMembers.has(eid)) {
            newlyAdded.add(eid);
          }
        }

        storeEntityCache.set(store, nextMembers);
        storeNewlyAddedCache.set(store, newlyAdded);
      }
    }

    // write pid
    view.setUint16(where, pid);
    where += 2;

    // save space for entity count
    const countWhere = where;
    where += 4;

    let writeCount = 0;

    const storeNewlyAdded = storeNewlyAddedCache ? storeNewlyAddedCache.get(store) : null;

    // write eid,val
    for (let i = 0; i < storeEntities.length; i++) {
      const eid = storeEntities[i];
      const newlyAddedComponent = storeNewlyAdded ? storeNewlyAdded.has(eid) : false;
      const rewindWhere = where;

      // write eid
      view.setUint32(where, eid);
      where += 4;

      // if it's a tag store we can stop here
      if (prop[$tagStore]) {
        if (deltaState && !newlyAddedComponent) {
          where = rewindWhere;
          continue;
        }
        writeCount++;
        continue;
      }

      // if property is an array
      if (ArrayBuffer.isView(prop[eid])) {
        const type = prop[eid].constructor.name.replace("Array", "");
        // @ts-ignore
        const indexType = prop[eid][$indexType] as string;
        // @ts-ignore
        const indexBytes = prop[eid][$indexBytes];

        // save space for count of dirty array elements
        const countWhere2 = where;
        where += indexBytes;

        let arrayWriteCount = 0;

        // write index,value
        // @ts-ignore
        for (let i = 0; i < prop[eid].length; i++) {
          if (shadow) {
            // @ts-ignore
            const changed = shadow[eid][i] !== prop[eid][i];

            // sync shadow
            // @ts-ignore
            shadow[eid][i] = prop[eid][i];

            // if state has not changed since the last call
            // todo: if newly added then entire component will serialize (instead of only changed values)
            if (!changed && !newlyAddedComponent) {
              // skip writing this value
              continue;
            }
          }

          // write array index

          // @ts-ignore
          view[`set${indexType}`](where, i);
          where += indexBytes;

          // write value at that index
          // @ts-ignore
          const value = prop[eid][i];
          // @ts-ignore
          view[`set${type}`](where, value);
          // @ts-ignore
          where += prop[eid].BYTES_PER_ELEMENT;
          arrayWriteCount++;
        }

        if (arrayWriteCount > 0) {
          // write total element count
          // @ts-ignore
          view[`set${indexType}`](countWhere2, arrayWriteCount);
          writeCount++;
        } else {
          where = rewindWhere;
          continue;
        }
      } else {
        if (deltaShadow && !newlyAddedComponent) {
          if (deltaShadow.kind === "typed") {
            // @ts-ignore
            const typedShadow = prop[deltaShadow.symbol];
            const changed = !Object.is(typedShadow[eid], prop[eid]);
            typedShadow[eid] = prop[eid];
            if (!changed) {
              where = rewindWhere;
              continue;
            }
          } else if (deltaShadow.kind === "faux") {
            const previous = deltaShadow.values.get(eid);
            const current = prop[eid];
            if (shadowValuesEqual(previous, current)) {
              where = rewindWhere;
              continue;
            }
            deltaShadow.values.set(eid, cloneShadowValue(current));
          }
        }

        const type = prop.constructor.name.replace("Array", "");

        let propComplexData: any = null;

        [where, propComplexData] = serialzeProp(where, eid, view, prop, type, schema);
        if (propComplexData) {
          complexEntityData[eid] = complexEntityData[eid] || {};
          complexEntityData[eid][schema.type] = complexEntityData[eid][schema.type] || {};
          complexEntityData[eid][schema.type][(prop as any)._key] = JSON.stringify(
            propComplexData[(prop as any)._key],
            replacer
          );
        }

        if (deltaShadow && newlyAddedComponent) {
          if (deltaShadow.kind === "typed") {
            // @ts-ignore
            prop[deltaShadow.symbol][eid] = prop[eid];
          } else if (deltaShadow.kind === "faux") {
            deltaShadow.values.set(eid, cloneShadowValue(prop[eid]));
          }
        }

        writeCount++;
      }
    }

    if (writeCount > 0) {
      // write how many eid/value pairs were written
      view.setUint32(countWhere, writeCount);
    } else {
      // if nothing was written (diffed with no changes)
      // then move cursor back 6 bytes (remove PID and countWhere space)
      where -= 6;
    }
  }

  const entitySize = where - whereEntitySize - 4;
  view.setUint32(whereEntitySize, entitySize);

  const complexEntityDataBuffer = JSON.stringify(complexEntityData, replacer);

  view.setUint32(where, complexEntityDataBuffer.length);
  where += 4;

  for (let i = 0; i < complexEntityDataBuffer.length; i++) {
    view.setUint8(where, complexEntityDataBuffer.charCodeAt(i));
    where += 1;
  }

  return where;
};

const serializeComponent = <T>(entityId: number, component: WorldComponent) => {
  const data: any = {};
  Object.keys(component.store).forEach((key) => {
    if (key.startsWith("_") || key === "id" || key === "store" || key === "type") {
      return;
    }
    let value = cloneDeep(component.store[key][entityId]);
    if (value !== undefined) {
      if (component.booleanKeys?.has(key)) value = !!value;
      data[key] = value;
    }
  });
  return data as T;
};

const serializeEntity = (world: World, entityId: number) => {
  const components = Array.from(world.componentMap.entries());
  const data: any = {
    entityId,
    components: (
      components
        .map(([schema, component]) => {
          return hasComponent(world, schema, entityId) ? [serializeComponent(entityId, component), component] : null;
        })
        .filter((c) => c !== null) as [Schema, WorldComponent][]
    ).reduce((components, [componentData, component]) => {
      components[component.type] = componentData;
      return components;
    }, {} as Record<string, any>),
  };
  return data as {
    entityId: number;
    components: {
      [key: string]: Schema;
    };
  };
};

const serializeToJSON = (world: World) => {
  return world.entitySparseSet.dense.map((entityId) => serializeEntity(world, entityId));
};

const serializeSparseSet = (set: ReturnType<typeof SparseSet>) => {
  return {
    dense: [...set.dense].map((d) => d ?? -1),
    sparse: [...set.sparse].map((s) => s ?? -1),
  };
};

const serializeQuery = (q: Query): SerializedQuery => {
  return {
    queryKey: q.queryKey,
    generations: [...q.generations],
    masks: { ...q.masks },
    ...serializeSparseSet(q),
    toRemove: serializeSparseSet(q.toRemove),
    entered: serializeSparseSet(q.entered),
  };
};

const serializeSparseSetToBuffer = (set: ReturnType<typeof SparseSet>, where: number, view: DataView) => {
  view.setUint16(where, set.dense.length);
  where += 2;
  for (let i = 0; i < set.dense.length; i++) {
    view.setUint16(where, set.dense[i] ?? -1);
    where += 2;
  }
  view.setUint16(where, set.sparse.length);
  where += 2;
  for (let i = 0; i < set.sparse.length; i++) {
    view.setUint16(where, set.sparse[i] ?? -1);
    where += 2;
  }
  return where;
};

const serializeString = (str: string, where: number, view: DataView) => {
  view.setUint16(where, str.length);
  where += 2;
  for (let i = 0; i < str.length; i++) {
    view.setUint8(where, str.charCodeAt(i));
    where += 1;
  }
  return where;
};

const serializeNumberObject = (obj: Record<number, number>, where: number, view: DataView) => {
  view.setUint16(where, Object.keys(obj).length);
  where += 2;
  Object.keys(obj).forEach((key) => {
    const k = parseInt(key);
    view.setUint32(where, k);
    where += 4;
    view.setFloat64(where, obj[k]);
    where += 8;
  });
  return where;
};

const serializeNumberArray = (arr: number[], where: number, view: DataView) => {
  view.setUint16(where, arr.length);
  where += 2;
  arr.forEach((a) => {
    view.setFloat64(where, a);
    where += 8;
  });
  return where;
};

const serializeUintArray = (arr: number[], where: number, view: DataView) => {
  view.setUint16(where, arr.length);
  where += 2;
  arr.forEach((a) => {
    view.setUint16(where, a);
    where += 2;
  });
  return where;
};

const serializeQueryToBuffer = (query: Query, where: number, view: DataView) => {
  where = serializeSparseSetToBuffer(query, where, view);
  where = serializeSparseSetToBuffer(query.toRemove, where, view);
  where = serializeSparseSetToBuffer(query.entered, where, view);
  where = serializeString(query.queryKey, where, view);
  where = serializeNumberObject(query.masks, where, view);
  where = serializeNumberArray(query.generations, where, view);

  return where;
};

const serializeWorldToBuffer = (world: World, maxBytes = 20000000, deltaState?: DeltaState, mode: number = 0) => {
  const buffer = new ArrayBuffer(maxBytes);
  const view = new DataView(buffer);

  let where = 0;

  view.setUint16(where, SERIALIZER_VERSION);
  where += 2;

  // mode byte: 0 = full, 1 = delta
  view.setUint8(where, mode);
  where += 1;

  if (!world.entitySparseSet.dense.length) return buffer.slice(0, where);

  where = serializeSparseSetToBuffer(world.entitySparseSet, where, view);
  where = serializeUintArray(world.removed, where, view);
  view.setUint16(where, world.entityCursor);
  where += 2;
  view.setUint16(where, world.size);
  where += 2;
  view.setUint32(where, world.bitflag);
  where += 4;
  view.setUint32(where, world.frame);
  where += 4;

  view.setUint16(where, world.componentMap.size);
  where += 2;

  Array.from(world.componentMap).forEach(([key, value]) => {
    const component = key as typeof Schema;
    where = serializeString(component.type, where, view);
    view.setUint32(where, value.generationId);
    where += 4;
    view.setUint32(where, value.bitflag);
    where += 4;
  });

  const queryMap = Array.from(world.queryMap.entries());
  view.setUint16(where, queryMap.length);
  where += 2;
  queryMap.forEach(([key, value]) => {
    where = serializeString(key, where, view);
    where = serializeQueryToBuffer(value, where, view);
  });

  view.setUint16(where, world.dirtyQueries.size);
  where += 2;

  queryMap.forEach(([key, value]) => {
    if (world.dirtyQueries.has(value)) {
      where = serializeString(key, where, view);
    }
  });

  where = serializeEntities(world, where, view, deltaState);

  return buffer.slice(0, where);
};

export function serializeWorld(serializationType: SerialMode.BINARY, world: World): ArrayBuffer;
export function serializeWorld(serializationType: SerialMode.JSON, world: World): SerializedWorld;
export function serializeWorld(serializationType: SerialMode.BASE64, world: World): string;
export function serializeWorld(serializationType: SerialMode, world: World): SerializedWorld | ArrayBuffer | string {
  if (serializationType === SerialMode.JSON) {
    const serializedWorld: SerializedWorld = {
      frame: world.frame,
      entitySparseSet: {
        dense: [...world["entitySparseSet"].dense],
        sparse: [...world["entitySparseSet"].sparse],
      },
      removed: [...world["removed"]],
      entities: serializeToJSON(world),
      entityCursor: world.entityCursor,
      size: world.size,
      bitflag: world.bitflag,
      componentMap: Array.from(world.componentMap).map(([key, value]) => {
        const component = key as typeof Schema;
        return [
          component.type,
          {
            generationId: value.generationId,
            bitflag: value.bitflag,
          },
        ];
      }),
      queryMap: {
        ...Array.from(world.queryMap.entries()).reduce((queries, [key, value]) => {
          queries[key] = serializeQuery(value);
          return queries;
        }, {} as Record<string, SerializedQuery>),
      },
      dirtyQueries: Array.from(world.queryMap.entries())
        .map(([key, value]) => {
          return world.dirtyQueries.has(value) ? key : null;
        })
        .filter((q) => q !== null) as string[],
    };

    return serializedWorld;
  } else if (serializationType === SerialMode.BINARY) {
    return serializeWorldToBuffer(world);
  } else {
    const buffer = serializeWorld(SerialMode.BINARY, world);
    const base64Buffer = Base64.fromUint8Array(new Uint8Array(buffer));
    return base64Buffer;
  }
}

export const createDeltaSerializer = (world: World) => {
  let initialized = false;
  const changedProps = new Map<any, DeltaShadow>();
  const storeEntityCache = new Map<any, Set<number>>();

  const initShadows = () => {
    changedProps.clear();
    storeEntityCache.clear();
    world.componentMap.forEach((c) => {
      const flattened = c.store[$storeFlattened];
      for (let i = 0; i < flattened.length; i++) {
        const prop = flattened[i];
        // @ts-ignore
        if (Array.isArray(prop) && prop[$parentArray]) {
          const sym = Symbol("deltaShadow");
          createShadow(prop as unknown as import("./Storage").Store, sym);
          changedProps.set(prop, { kind: "subarray", symbol: sym });
        } else if (ArrayBuffer.isView(prop)) {
          const sym = Symbol("deltaShadow");
          createShadow(prop as unknown as import("./Storage").Store, sym);
          changedProps.set(prop, { kind: "typed", symbol: sym });
        } else {
          changedProps.set(prop, { kind: "faux", values: new Map<number, any>() });
        }
      }
    });
    initialized = true;
  };

  const serialize = (maxBytes = 20000000): ArrayBuffer => {
    if (!initialized) {
      initShadows();
      // First call: full serialization (mode 0) but with shadows active so they get synced
      return serializeWorldToBuffer(world, maxBytes, { changedProps, storeEntityCache }, 0);
    }
    // Subsequent calls: delta serialization (mode 1)
    return serializeWorldToBuffer(world, maxBytes, { changedProps, storeEntityCache }, 1);
  };

  const reset = () => {
    initialized = false;
  };

  return { serialize, reset };
};

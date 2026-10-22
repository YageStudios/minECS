import cloneDeep from "lodash/cloneDeep";
import isEqual from "lodash/isEqual";
import type { Schema } from "./Schema";
import type { Store } from "./Storage";
import { $indexBytes, $indexType, $parentArray, $storeBase, $storeFlattened, $tagStore, createShadow } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { SerialMode } from "./Types";
import type { SparseSet } from "./SparseSet";
import { Base64 } from "js-base64";
import { getComponentSchema } from "./World";
import { activateDeltaDirtyTracking, clearDeltaDirtyTracking, consumeDeltaDirtyTracking } from "./DeltaTracking";

type DeltaShadow =
  | { kind: "subarray"; symbol: symbol }
  | { kind: "typed"; symbol: symbol }
  | { kind: "faux"; values: Map<number, any> };

type DeltaState = {
  changedProps: Map<any, DeltaShadow>;
  storeEntityCache: Map<any, Set<number>>;
  dirtyProps?: Map<any, number[]>;
};

// v3: sparse-set indices are rebuilt from `dense` on load (no longer serialized) and the
// write-only `entered` query set was removed.
export const SERIALIZER_VERSION = 3;

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

/****************************************************
 *
 * Typed IO tables (resolved once per column instead of
 * building `set${Type}` method names per element)
 *
 ****************************************************/

export type TypedIO = {
  bytes: number;
  write: (view: DataView, where: number, value: number) => void;
  read: (view: DataView, where: number) => number;
};

const io = (
  bytes: number,
  write: (view: DataView, where: number, value: number) => void,
  read: (view: DataView, where: number) => number
): TypedIO => ({ bytes, write, read });

const Int8IO = io(
  1,
  (v, w, x) => v.setInt8(w, x),
  (v, w) => v.getInt8(w)
);
const Uint8IO = io(
  1,
  (v, w, x) => v.setUint8(w, x),
  (v, w) => v.getUint8(w)
);
const Int16IO = io(
  2,
  (v, w, x) => v.setInt16(w, x),
  (v, w) => v.getInt16(w)
);
const Uint16IO = io(
  2,
  (v, w, x) => v.setUint16(w, x),
  (v, w) => v.getUint16(w)
);
const Int32IO = io(
  4,
  (v, w, x) => v.setInt32(w, x),
  (v, w) => v.getInt32(w)
);
const Uint32IO = io(
  4,
  (v, w, x) => v.setUint32(w, x),
  (v, w) => v.getUint32(w)
);
const Float32IO = io(
  4,
  (v, w, x) => v.setFloat32(w, x),
  (v, w) => v.getFloat32(w)
);
const Float64IO = io(
  8,
  (v, w, x) => v.setFloat64(w, x),
  (v, w) => v.getFloat64(w)
);

type TypedArrayConstructor = new (...args: any[]) => ArrayBufferView;

export const TYPED_IO = new Map<TypedArrayConstructor, TypedIO>([
  [Int8Array, Int8IO],
  [Uint8Array, Uint8IO],
  [Uint8ClampedArray, Uint8IO],
  [Int16Array, Int16IO],
  [Uint16Array, Uint16IO],
  [Int32Array, Int32IO],
  [Uint32Array, Uint32IO],
  [Float32Array, Float32IO],
  [Float64Array, Float64IO],
]);

export const INDEX_IO: Record<string, TypedIO> = {
  Uint8: Uint8IO,
  Uint16: Uint16IO,
  Uint32: Uint32IO,
};

export const typedIOFor = (arr: ArrayBufferView): TypedIO => {
  const result = TYPED_IO.get(arr.constructor as TypedArrayConstructor);
  if (!result) throw new Error(`minECS - Unsupported typed array ${arr.constructor.name}`);
  return result;
};

/****************************************************
 *
 * Byte-level string IO (one byte per UTF-16 code unit,
 * identical to the historical charCodeAt/setUint8 loop)
 *
 ****************************************************/

const LATIN1_CHUNK = 8192;

export const writeLatin1 = (bytes: Uint8Array, where: number, str: string) => {
  const length = str.length;
  if (where + length > bytes.length) {
    throw new RangeError("minECS - serialization buffer too small");
  }
  for (let i = 0; i < length; i++) {
    bytes[where + i] = str.charCodeAt(i);
  }
  return where + length;
};

export const readLatin1 = (bytes: Uint8Array, where: number, length: number): string => {
  if (length <= LATIN1_CHUNK) {
    return String.fromCharCode.apply(null, bytes.subarray(where, where + length) as unknown as number[]);
  }
  let out = "";
  for (let i = 0; i < length; i += LATIN1_CHUNK) {
    const end = Math.min(length, i + LATIN1_CHUNK);
    out += String.fromCharCode.apply(null, bytes.subarray(where + i, where + end) as unknown as number[]);
  }
  return out;
};

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

type ValueConfig = {
  type: string;
  properties?: {
    [key: string]: { type: string; key: string; properties?: any; items?: any };
  };
  items?: any;
};

const configType = (config: ValueConfig): string =>
  Array.isArray(config.type) ? (config.type as string[]).filter((t) => t !== "null").join("|") : config.type;

const hasComplexProperty = (config: ValueConfig): boolean =>
  !config.properties ||
  !!Object.values(config.properties).find((p: { type: string }) => p.type === "object" || p.type === "array");

const serializeValue = (
  where: number,
  eid: number,
  view: DataView,
  bytes: Uint8Array,
  key: string,
  value: any,
  config: ValueConfig,
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

  const type = configType(config);

  switch (type) {
    case "string":
      view.setUint8(where, value.length);
      where += 1;
      where = writeLatin1(bytes, where, value);
      break;
    case "object":
      if (hasComplexProperty(config)) {
        if (!complexEntityData) {
          complexEntityData = {};
        }
        complexEntityData[key] = value;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const properties = config.properties!;
        const keys = Object.keys(properties);
        for (let i = 0; i < keys.length; i++) {
          const propKey = keys[i];
          [where, complexEntityData] = serializeValue(
            where,
            eid,
            view,
            bytes,
            propKey,
            value[propKey],
            properties[propKey],
            complexEntityData,
            schema
          );
        }
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
          for (let i = 0; i < value.length; i++) {
            [where] = serializeValue(where, eid, view, bytes, "index", value[i], config.items, complexEntityData, schema);
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

type PropKind = 0 | 1 | 2 | 3; // tag | subarray | typed | faux

const serializeEntities = (
  world: World,
  where: number,
  view: DataView,
  bytes: Uint8Array,
  deltaState?: DeltaState,
  mode: number = 0
): number => {
  const changedProps = deltaState ? deltaState.changedProps : new Map<any, DeltaShadow>();
  const componentProps: Store[] = [];
  const storeEntityCache = deltaState ? deltaState.storeEntityCache : null;
  const dirtyProps = deltaState?.dirtyProps;

  const complexEntityData: any = {};
  world["componentMap"].forEach((c) => {
    if (c.store[$storeFlattened].length) componentProps.push(...c.store[$storeFlattened]);
    else componentProps.push(c.store);
  });

  const whereEntitySize = where;
  where += 4;

  const ents = world["entitySparseSet"].dense;

  const storeEntityListCache = new Map<any, number[]>();

  // iterate over component props
  for (let pid = 0; pid < componentProps.length; pid++) {
    const prop: any = componentProps[pid];
    const store = prop[$storeBase]();
    const component = getComponentSchema(world, store);
    const schema = component.schema;
    const componentType = schema.type;
    const componentMasks = world["entityMasks"][component.generationId];
    const componentBitflag = component.bitflag;
    const deltaShadow = changedProps.get(prop);
    const shadow = deltaShadow && "symbol" in deltaShadow ? prop[deltaShadow.symbol] : null;

    // Per-column invariants (hoisted out of the entity loop).
    const kind: PropKind = prop[$tagStore]
      ? 0
      : Array.isArray(prop) && (prop as any)[$parentArray]
        ? 1
        : ArrayBuffer.isView(prop)
          ? 2
          : 3;
    const elementIO = kind === 1 ? typedIOFor(prop[$parentArray]) : kind === 2 ? typedIOFor(prop) : null;
    const indexIO = kind === 1 ? INDEX_IO[prop[$indexType] as string] : null;
    const indexBytes: number = kind === 1 ? prop[$indexBytes] : 0;
    const fauxKey: string = kind === 3 ? prop._key : "";
    const fauxConfig: ValueConfig = kind === 3 ? schema.schema.properties[fauxKey] : null;

    let entitiesToProcess: number[] = [];

    let prevMembers: Set<number> | null = null;
    if (storeEntityCache) {
      let members = storeEntityCache.get(store);
      if (!members) {
        members = new Set<number>();
        storeEntityCache.set(store, members);
      }
      prevMembers = members;
    }

    if (mode === 1 && deltaState) {
      const dirtyList = dirtyProps?.get(prop);
      if (!dirtyList || dirtyList.length === 0) {
        continue;
      }
      entitiesToProcess = dirtyList;
    } else {
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
      }
      entitiesToProcess = storeEntities;
      if (prevMembers) {
        prevMembers.clear();
        for (let i = 0; i < storeEntities.length; i++) {
          prevMembers.add(storeEntities[i]);
        }
      }
    }

    // write pid
    view.setUint16(where, pid);
    where += 2;

    // save space for entity count
    const countWhere = where;
    where += 4;

    let writeCount = 0;

    // write eid,val
    for (let i = 0; i < entitiesToProcess.length; i++) {
      const eid = entitiesToProcess[i];
      const isCurrentMember = (componentMasks[eid] & componentBitflag) === componentBitflag;
      let newlyAddedComponent = false;

      if (mode === 1 && prevMembers) {
        newlyAddedComponent = isCurrentMember && !prevMembers.has(eid);
        if (isCurrentMember) {
          prevMembers.add(eid);
        } else {
          prevMembers.delete(eid);
        }
      }

      if (!isCurrentMember) {
        continue;
      }

      const rewindWhere = where;

      // write eid
      view.setUint32(where, eid);
      where += 4;

      // if it's a tag store we can stop here
      if (kind === 0) {
        if (mode === 1 && !newlyAddedComponent) {
          where = rewindWhere;
          continue;
        }
        writeCount++;
        continue;
      }

      if (kind === 1) {
        // fixed-length typed array property: write (index, value) pairs
        const sub = prop[eid];
        const length = sub.length;
        const shadowSub = shadow ? shadow[eid] : null;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const idxIO = indexIO!;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const elemIO = elementIO!;
        const elemBytes = elemIO.bytes;

        // save space for count of dirty array elements
        const countWhere2 = where;
        where += indexBytes;

        let arrayWriteCount = 0;

        for (let j = 0; j < length; j++) {
          const value = sub[j];
          if (shadowSub) {
            const changed = shadowSub[j] !== value;

            // sync shadow
            shadowSub[j] = value;

            // if state has not changed since the last call
            // todo: if newly added then entire component will serialize (instead of only changed values)
            if (mode === 1 && !changed && !newlyAddedComponent) {
              // skip writing this value
              continue;
            }
          }

          // write array index
          idxIO.write(view, where, j);
          where += indexBytes;

          // write value at that index
          elemIO.write(view, where, value);
          where += elemBytes;
          arrayWriteCount++;
        }

        if (arrayWriteCount > 0) {
          // write total element count
          idxIO.write(view, countWhere2, arrayWriteCount);
          writeCount++;
        } else {
          where = rewindWhere;
          continue;
        }
      } else {
        if (mode === 1 && deltaShadow && !newlyAddedComponent) {
          if (deltaShadow.kind === "typed") {
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

        if (kind === 2) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const elemIO = elementIO!;
          elemIO.write(view, where, prop[eid]);
          where += elemIO.bytes;
        } else {
          let propComplexData: any = null;
          [where, propComplexData] = serializeValue(
            where,
            eid,
            view,
            bytes,
            fauxKey,
            prop[eid],
            fauxConfig,
            propComplexData,
            schema
          );
          if (propComplexData) {
            const entityData = complexEntityData[eid] || (complexEntityData[eid] = {});
            const componentData = entityData[componentType] || (entityData[componentType] = {});
            componentData[fauxKey] = JSON.stringify(propComplexData[fauxKey], replacer);
          }
        }

        if (deltaShadow && (mode === 0 || newlyAddedComponent)) {
          if (deltaShadow.kind === "typed") {
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

  where = writeLatin1(bytes, where, complexEntityDataBuffer);

  return where;
};

/****************************************************
 *
 * JSON serialization
 *
 ****************************************************/

const isSerializableKey = (key: string) => !(key.startsWith("_") || key === "id" || key === "store" || key === "type");

const serializeComponent = <T>(entityId: number, component: WorldComponent, keys: string[]) => {
  const data: any = {};
  const store = component.store;
  const booleanKeys = component.booleanKeys;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let value = store[key][entityId];
    if (value !== undefined) {
      if (value !== null && typeof value === "object") value = cloneDeep(value);
      if (booleanKeys?.has(key)) value = !!value;
      data[key] = value;
    }
  }
  return data as T;
};

type JSONComponentEntry = {
  component: WorldComponent;
  masks: Uint32Array;
  bitflag: number;
  keys: string[];
};

const jsonComponentEntries = (world: World): JSONComponentEntry[] => {
  const entries: JSONComponentEntry[] = [];
  world.componentMap.forEach((component) => {
    entries.push({
      component,
      masks: world["entityMasks"][component.generationId],
      bitflag: component.bitflag,
      keys: Object.keys(component.store).filter(isSerializableKey),
    });
  });
  return entries;
};

const serializeEntityWith = (entityId: number, entries: JSONComponentEntry[]) => {
  const components: Record<string, any> = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if ((entry.masks[entityId] & entry.bitflag) === entry.bitflag) {
      components[entry.component.type] = serializeComponent(entityId, entry.component, entry.keys);
    }
  }
  return { entityId, components } as {
    entityId: number;
    components: {
      [key: string]: Schema;
    };
  };
};

const serializeToJSON = (world: World) => {
  const entries = jsonComponentEntries(world);
  return world.entitySparseSet.dense.map((entityId) => serializeEntityWith(entityId, entries));
};

// Derived sparse index: index of each member id, -1 for non-member slots (format compatibility only).
const sparseToArray = (set: ReturnType<typeof SparseSet>) => {
  const { dense, sparse } = set;
  let length = 0;
  for (let i = 0; i < dense.length; i++) {
    const val = dense[i];
    if (typeof val === "number" && val + 1 > length) length = val + 1;
  }
  length = Math.min(length, sparse.length);
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    const idx = sparse[i];
    out[i] = dense[idx] === i ? idx : -1;
  }
  return out;
};

const serializeSparseSet = (set: ReturnType<typeof SparseSet>) => {
  return {
    dense: [...set.dense].map((d) => d ?? -1),
    sparse: sparseToArray(set),
  };
};

const serializeQuery = (q: Query): SerializedQuery => {
  return {
    queryKey: q.queryKey,
    generations: [...q.generations],
    masks: { ...q.masks },
    ...serializeSparseSet(q),
    toRemove: serializeSparseSet(q.toRemove),
  };
};

/****************************************************
 *
 * Binary serialization
 *
 ****************************************************/

const serializeSparseSetToBuffer = (set: ReturnType<typeof SparseSet>, where: number, view: DataView) => {
  const dense = set.dense;
  view.setUint16(where, dense.length);
  where += 2;
  for (let i = 0; i < dense.length; i++) {
    view.setUint16(where, dense[i] ?? -1);
    where += 2;
  }
  return where;
};

const serializeString = (str: string, where: number, view: DataView, bytes: Uint8Array) => {
  view.setUint16(where, str.length);
  where += 2;
  return writeLatin1(bytes, where, str);
};

const serializeNumberObject = (obj: Record<number, number>, where: number, view: DataView) => {
  const keys = Object.keys(obj);
  view.setUint16(where, keys.length);
  where += 2;
  for (let i = 0; i < keys.length; i++) {
    const k = parseInt(keys[i]);
    view.setUint32(where, k);
    where += 4;
    view.setFloat64(where, obj[k]);
    where += 8;
  }
  return where;
};

const serializeNumberArray = (arr: number[], where: number, view: DataView) => {
  view.setUint16(where, arr.length);
  where += 2;
  for (let i = 0; i < arr.length; i++) {
    view.setFloat64(where, arr[i]);
    where += 8;
  }
  return where;
};

const serializeUintArray = (arr: number[], where: number, view: DataView) => {
  view.setUint16(where, arr.length);
  where += 2;
  for (let i = 0; i < arr.length; i++) {
    view.setUint16(where, arr[i]);
    where += 2;
  }
  return where;
};

const serializeQueryToBuffer = (query: Query, where: number, view: DataView, bytes: Uint8Array) => {
  where = serializeSparseSetToBuffer(query, where, view);
  where = serializeSparseSetToBuffer(query.toRemove, where, view);
  where = serializeString(query.queryKey, where, view, bytes);
  where = serializeNumberObject(query.masks, where, view);
  where = serializeNumberArray(query.generations, where, view);

  return where;
};

// Reusable scratch buffer: allocated once (and grown on demand) instead of a fresh
// `maxBytes` allocation per call. The returned buffer is always a trimmed copy.
let scratchBuffer: ArrayBuffer | null = null;
let scratchView: DataView | null = null;
let scratchBytes: Uint8Array | null = null;

const getScratch = (maxBytes: number) => {
  if (!scratchBuffer || scratchBuffer.byteLength < maxBytes) {
    scratchBuffer = new ArrayBuffer(maxBytes);
    scratchView = new DataView(scratchBuffer);
    scratchBytes = new Uint8Array(scratchBuffer);
  }
  return { buffer: scratchBuffer, view: scratchView as DataView, bytes: scratchBytes as Uint8Array };
};

const serializeWorldToBuffer = (world: World, maxBytes = 20000000, deltaState?: DeltaState, mode: number = 0) => {
  const { buffer, view, bytes } = getScratch(maxBytes);

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

  world.componentMap.forEach((value, key) => {
    const component = key as typeof Schema;
    where = serializeString(component.type, where, view, bytes);
    view.setUint32(where, value.generationId);
    where += 4;
    view.setUint32(where, value.bitflag);
    where += 4;
  });

  const queryMap = Array.from(world.queryMap.entries());
  view.setUint16(where, queryMap.length);
  where += 2;
  for (let i = 0; i < queryMap.length; i++) {
    const [key, value] = queryMap[i];
    where = serializeString(key, where, view, bytes);
    where = serializeQueryToBuffer(value, where, view, bytes);
  }

  view.setUint16(where, world.dirtyQueries.size);
  where += 2;

  for (let i = 0; i < queryMap.length; i++) {
    const [key, value] = queryMap[i];
    if (world.dirtyQueries.has(value)) {
      where = serializeString(key, where, view, bytes);
    }
  }

  where = serializeEntities(world, where, view, bytes, deltaState, mode);

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
        sparse: sparseToArray(world["entitySparseSet"]),
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
    activateDeltaDirtyTracking(world);
    clearDeltaDirtyTracking(world);
    changedProps.clear();
    storeEntityCache.clear();
    world.componentMap.forEach((c) => {
      const flattened = c.store[$storeFlattened];
      for (let i = 0; i < flattened.length; i++) {
        const prop = flattened[i];
        if (Array.isArray(prop) && (prop as any)[$parentArray]) {
          const sym = Symbol("deltaShadow");
          createShadow(prop as unknown as Store, sym);
          changedProps.set(prop, { kind: "subarray", symbol: sym });
        } else if (ArrayBuffer.isView(prop)) {
          const sym = Symbol("deltaShadow");
          createShadow(prop as unknown as Store, sym);
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
    const dirtyProps = consumeDeltaDirtyTracking(world);
    // Subsequent calls: delta serialization (mode 1)
    return serializeWorldToBuffer(world, maxBytes, { changedProps, storeEntityCache, dirtyProps }, 1);
  };

  const reset = () => {
    initialized = false;
    clearDeltaDirtyTracking(world);
  };

  return { serialize, reset };
};

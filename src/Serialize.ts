import cloneDeep from "lodash/cloneDeep.js";
import isEqual from "lodash/isEqual.js";
import type { Schema } from "./Schema";
import type { Store } from "./Storage";
import { $indexBytes, $indexType, $parentArray, $storeFlattened, $tagStore, createShadow } from "./Storage";
import type { Query, SerializedQuery, SerializedWorld, World, WorldComponent } from "./Types";
import { SerialMode } from "./Types";
import type { SparseSet } from "./SparseSet";
import { Base64 } from "js-base64";
import { activateDeltaDirtyTracking, clearDeltaDirtyTracking, consumeDeltaDirtyTracking } from "./DeltaTracking";
import { $serialPlan } from "./Internal";

type DeltaShadow =
  | { kind: "subarray"; symbol: symbol }
  | { kind: "typed"; symbol: symbol }
  | { kind: "faux"; values: Map<number, any> };

type DeltaState = {
  changedProps: Map<any, DeltaShadow>;
  /** Per store, which entities had the component at the last serialize (1 = member), by entity id. */
  storeEntityCache: Map<any, Uint8Array>;
  dirtyProps?: Map<any, number[]>;
};

// v3: sparse-set indices are rebuilt from `dense` on load (no longer serialized) and the
// write-only `entered` query set was removed.
// v4: complex (object/array) faux values are embedded in the trailing JSON block as values instead of
// as individually JSON-encoded strings (no more double encoding).
// v5: a width byte after the mode byte (2 or 4) sets the size of entity ids and entity counts in the
// header (entity list, free list, cursor, world size, query members), so worlds can exceed 65535
// entities. Worlds of up to 65535 entities keep the v4 two-byte layout. v4 payloads are still read.
export const SERIALIZER_VERSION = 5;
/** Oldest payload version deserialization still accepts. */
export const SERIALIZER_MIN_VERSION = 4;

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
  read: (view: DataView, where: number) => number,
): TypedIO => ({ bytes, write, read });

const Int8IO = io(
  1,
  (v, w, x) => v.setInt8(w, x),
  (v, w) => v.getInt8(w),
);
const Uint8IO = io(
  1,
  (v, w, x) => v.setUint8(w, x),
  (v, w) => v.getUint8(w),
);
const Int16IO = io(
  2,
  (v, w, x) => v.setInt16(w, x),
  (v, w) => v.getInt16(w),
);
const Uint16IO = io(
  2,
  (v, w, x) => v.setUint16(w, x),
  (v, w) => v.getUint16(w),
);
const Int32IO = io(
  4,
  (v, w, x) => v.setInt32(w, x),
  (v, w) => v.getInt32(w),
);
const Uint32IO = io(
  4,
  (v, w, x) => v.setUint32(w, x),
  (v, w) => v.getUint32(w),
);
const Float32IO = io(
  4,
  (v, w, x) => v.setFloat32(w, x),
  (v, w) => v.getFloat32(w),
);
const Float64IO = io(
  8,
  (v, w, x) => v.setFloat64(w, x),
  (v, w) => v.getFloat64(w),
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

const isPlainObject = (value: any): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Deep clone specialised for JSON-shaped data (plain objects, plain arrays, primitives). Anything else
 * (Map, Set, class instances, Dates...) is handed to lodash. Typed arrays are copied element-wise.
 */
export const fastClone = (value: any): any => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return cloneDeep(value);
    const length = value.length;
    const out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = fastClone(value[i]);
    return out;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // Copy just the elements. cloneDeep would copy the whole backing buffer, which for store
    // subarrays is the entire column.
    return (value as any).slice();
  }
  if (!isPlainObject(value)) return cloneDeep(value);
  const out: any = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    // Assigning "__proto__" would set the clone's prototype instead of copying the own key.
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: fastClone(value[key]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else out[key] = fastClone(value[key]);
  }
  return out;
};

/** Structural equality with lodash isEqual semantics, fast-pathed for JSON-shaped data. */
export const fastEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // SameValueZero, as lodash isEqual uses for primitives.
    return a !== a && b !== b;
  }
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    if (Object.getPrototypeOf(a) !== Array.prototype || Object.getPrototypeOf(b) !== Array.prototype) {
      return isEqual(a, b);
    }
    const length = a.length;
    if (length !== b.length) return false;
    for (let i = 0; i < length; i++) if (!fastEqual(a[i], b[i])) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return isEqual(a, b);
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (!Object.prototype.hasOwnProperty.call(b, key) || !fastEqual(a[key], b[key])) return false;
  }
  return true;
};

const cloneShadowValue = (value: any): any => {
  return isPrimitiveValue(value) ? value : fastClone(value);
};

const shadowValuesEqual = (a: any, b: any): boolean => {
  if (isPrimitiveValue(a) && isPrimitiveValue(b)) {
    return Object.is(a, b);
  }
  return fastEqual(a, b);
};

export type ValueConfig = {
  type: string;
  properties?: {
    [key: string]: { type: string; key: string; properties?: any; items?: any };
  };
  items?: any;
};

export type ConfigInfo = {
  /** Resolved type name ("null" stripped from union types). */
  type: string;
  /** For objects: has object/array properties (or no declared properties). For arrays: object/array items. */
  complex: boolean;
};

const configInfoCache = new WeakMap<object, ConfigInfo>();

/** Per-schema-node type info, computed once instead of on every serialized value. */
export const configInfo = (config: ValueConfig): ConfigInfo => {
  let info = configInfoCache.get(config);
  if (info === undefined) {
    const type = Array.isArray(config.type)
      ? (config.type as string[]).filter((t) => t !== "null").join("|")
      : config.type;
    let complex = false;
    if (type === "object") {
      complex =
        !config.properties ||
        !!Object.values(config.properties).find((p: { type: string }) => p.type === "object" || p.type === "array");
    } else if (type === "array") {
      complex = !!config.items && (config.items.type === "object" || config.items.type === "array");
    }
    info = { type, complex };
    configInfoCache.set(config, info);
  }
  return info;
};

// Out-parameter for serializeValue: complex (object/array) values that go to the JSON block, keyed by
// property name. Reset by the caller before each top-level value.
let complexOut: { [key: string]: any } | null = null;

const serializeValue = (where: number, key: string, value: any, config: ValueConfig): number => {
  // Flag byte plus the widest fixed-size value (a float64).
  reserve(where, 9);
  if (value === null) {
    scratchView!.setUint8(where, NULL_FLAG);
    return where + 1;
  }
  if (value === undefined) {
    scratchView!.setUint8(where, UNDEFINED_FLAG);
    return where + 1;
  }
  scratchView!.setUint8(where, 0);
  where += 1;

  const info = configInfo(config);

  switch (info.type) {
    case "string":
      reserve(where, 1 + value.length);
      scratchView!.setUint8(where, value.length);
      where += 1;
      where = writeLatin1(scratchBytes!, where, value);
      break;
    case "object":
      if (info.complex) {
        (complexOut || (complexOut = {}))[key] = value;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const properties = config.properties!;
        const keys = Object.keys(properties);
        for (let i = 0; i < keys.length; i++) {
          const propKey = keys[i];
          where = serializeValue(where, propKey, value[propKey], properties[propKey]);
        }
      }
      break;
    case "array":
      if (info.complex && value.length) {
        (complexOut || (complexOut = {}))[key] = value;
      } else {
        reserve(where, 2);
        scratchView!.setUint16(where, value.length);
        where += 2;
        for (let i = 0; i < value.length; i++) {
          where = serializeValue(where, "index", value[i], config.items);
        }
      }
      break;
    case "number":
      scratchView!.setFloat64(where, value);
      where += 8;
      break;
    case "boolean":
      scratchView!.setUint8(where, value ? 1 : 0);
      where += 1;
      break;
    default:
      throw new Error(`Unsupported object type: ${config.type}`);
  }

  return where;
};

type PropKind = 0 | 1 | 2 | 3; // tag | subarray | typed | faux

/** Everything the (de)serializers need about one column, resolved once per world layout. */
export type ColumnPlan = {
  prop: any;
  store: Store;
  component: WorldComponent;
  schema: typeof Schema;
  componentType: string;
  isTagComponent: boolean;
  kind: PropKind;
  elementIO: TypedIO | null;
  indexIO: TypedIO | null;
  indexBytes: number;
  fauxKey: string;
  fauxConfig: ValueConfig | null;
};

type SerialPlan = { map: Map<typeof Schema, WorldComponent>; size: number; columns: ColumnPlan[] };

/**
 * Column plan for a world, in componentMap order (that order defines the wire `pid`). Cached on the
 * world and rebuilt only when the componentMap is replaced or grows.
 */
export const getSerialPlan = (world: World): ColumnPlan[] => {
  const cached = (world as any)[$serialPlan] as SerialPlan | undefined;
  const map = world.componentMap;
  if (cached && cached.map === map && cached.size === map.size) return cached.columns;

  const columns: ColumnPlan[] = [];
  map.forEach((component) => {
    const store = component.store as Store;
    const flattened = store[$storeFlattened];
    const props: any[] = flattened.length ? flattened : [store];
    const schema = component.schema;
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      const kind: PropKind = prop[$tagStore]
        ? 0
        : Array.isArray(prop) && (prop as any)[$parentArray]
          ? 1
          : ArrayBuffer.isView(prop)
            ? 2
            : 3;
      const fauxKey: string = kind === 3 ? prop._key : "";
      columns.push({
        prop,
        store,
        component,
        schema,
        componentType: component.type,
        isTagComponent: flattened.length === 0,
        kind,
        elementIO: kind === 1 ? typedIOFor(prop[$parentArray]) : kind === 2 ? typedIOFor(prop) : null,
        indexIO: kind === 1 ? INDEX_IO[prop[$indexType] as string] : null,
        indexBytes: kind === 1 ? prop[$indexBytes] : 0,
        fauxKey,
        fauxConfig: kind === 3 ? schema.schema.properties[fauxKey] : null,
      });
    }
  });
  (world as any)[$serialPlan] = { map, size: map.size, columns };
  return columns;
};

const serializeEntities = (world: World, where: number, deltaState?: DeltaState, mode: number = 0): number => {
  // The scratch buffer can be replaced while writing (see reserve), so these are refreshed after
  // every reserve.
  let view = scratchView!;
  const changedProps = deltaState ? deltaState.changedProps : null;
  const columns = getSerialPlan(world);
  const storeEntityCache = deltaState ? deltaState.storeEntityCache : null;
  const dirtyProps = deltaState?.dirtyProps;
  const entityMasks = world.entityMasks;

  const complexEntityData: any = {};

  reserve(where, 4);
  view = scratchView!;
  const whereEntitySize = where;
  where += 4;

  const ents = world["entitySparseSet"].dense;

  const storeEntityListCache = new Map<any, number[]>();

  // iterate over component props
  for (let pid = 0; pid < columns.length; pid++) {
    const column = columns[pid];
    const prop: any = column.prop;
    const store = column.store;
    const component = column.component;
    const componentType = column.componentType;
    const componentMasks = entityMasks[component.generationId];
    const componentBitflag = component.bitflag;
    const deltaShadow = changedProps ? changedProps.get(prop) : undefined;
    const shadow = deltaShadow && "symbol" in deltaShadow ? prop[deltaShadow.symbol] : null;

    // Per-column invariants (resolved once per world layout).
    const kind = column.kind;
    const elementIO = column.elementIO;
    const indexIO = column.indexIO;
    const indexBytes = column.indexBytes;
    const fauxKey = column.fauxKey;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const fauxConfig = column.fauxConfig!;

    let entitiesToProcess: number[] = [];

    let prevMembers: Uint8Array | null = null;
    if (storeEntityCache) {
      let members = storeEntityCache.get(store);
      if (!members || members.length < world.size) {
        const grown = new Uint8Array(world.size);
        if (members) grown.set(members);
        members = grown;
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
        // Once per store: every column of a store has the same members.
        if (prevMembers) {
          prevMembers.fill(0);
          for (let i = 0; i < storeEntities.length; i++) prevMembers[storeEntities[i]] = 1;
        }
      }
      entitiesToProcess = storeEntities;
    }

    // Room for the pid, the count and every fixed-size entry; faux values reserve as they write.
    const subLength = kind === 1 && entitiesToProcess.length ? prop[entitiesToProcess[0]].length : 0;
    const entryBytes =
      kind === 1 ? 4 + indexBytes + subLength * (indexBytes + elementIO!.bytes) : kind === 2 ? 4 + elementIO!.bytes : 4;
    reserve(where, 6 + entitiesToProcess.length * entryBytes);
    view = scratchView!;

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
        newlyAddedComponent = isCurrentMember && prevMembers[eid] === 0;
        prevMembers[eid] = isCurrentMember ? 1 : 0;
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
          complexOut = null;
          where = serializeValue(where, fauxKey, prop[eid], fauxConfig);
          // Room for the next entity id (the column reserve only covered the first one).
          reserve(where, 4);
          view = scratchView!;
          if (complexOut !== null) {
            const complexValue = (complexOut as { [key: string]: any })[fauxKey];
            complexOut = null;
            if (complexValue !== undefined) {
              const entityData = complexEntityData[eid] || (complexEntityData[eid] = {});
              const componentData = entityData[componentType] || (entityData[componentType] = {});
              // Stored as a value; the whole block is JSON-encoded once below.
              componentData[fauxKey] = complexValue;
            }
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

  reserve(where, 4 + complexEntityDataBuffer.length);
  scratchView!.setUint32(where, complexEntityDataBuffer.length);
  where += 4;

  where = writeLatin1(scratchBytes!, where, complexEntityDataBuffer);

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
      if (value !== null && typeof value === "object") value = fastClone(value);
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
  const dense = world.entitySparseSet.dense;
  const out = new Array(dense.length);
  for (let i = 0; i < dense.length; i++) out[i] = serializeEntityWith(dense[i], entries);
  return out;
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

// Entity ids and counts are written as uint16 or uint32 (`wide`); the missing-slot marker is the
// type's max value (-1 wrapped).
const serializeSparseSetToBuffer = (set: ReturnType<typeof SparseSet>, where: number, wide: boolean) => {
  const dense = set.dense;
  reserve(where, (dense.length + 1) * (wide ? 4 : 2));
  const view = scratchView!;
  if (wide) {
    view.setUint32(where, dense.length);
    where += 4;
    for (let i = 0; i < dense.length; i++) {
      view.setUint32(where, dense[i] ?? -1);
      where += 4;
    }
  } else {
    view.setUint16(where, dense.length);
    where += 2;
    for (let i = 0; i < dense.length; i++) {
      view.setUint16(where, dense[i] ?? -1);
      where += 2;
    }
  }
  return where;
};

const serializeString = (str: string, where: number) => {
  reserve(where, 2 + str.length);
  scratchView!.setUint16(where, str.length);
  where += 2;
  return writeLatin1(scratchBytes!, where, str);
};

const serializeNumberObject = (obj: Record<number, number>, where: number) => {
  const keys = Object.keys(obj);
  reserve(where, 2 + keys.length * 12);
  const view = scratchView!;
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

const serializeNumberArray = (arr: number[], where: number) => {
  reserve(where, 2 + arr.length * 8);
  const view = scratchView!;
  view.setUint16(where, arr.length);
  where += 2;
  for (let i = 0; i < arr.length; i++) {
    view.setFloat64(where, arr[i]);
    where += 8;
  }
  return where;
};

const serializeUintArray = (arr: number[], where: number, wide: boolean) => {
  reserve(where, (arr.length + 1) * (wide ? 4 : 2));
  const view = scratchView!;
  if (wide) {
    view.setUint32(where, arr.length);
    where += 4;
    for (let i = 0; i < arr.length; i++) {
      view.setUint32(where, arr[i]);
      where += 4;
    }
  } else {
    view.setUint16(where, arr.length);
    where += 2;
    for (let i = 0; i < arr.length; i++) {
      view.setUint16(where, arr[i]);
      where += 2;
    }
  }
  return where;
};

const serializeQueryToBuffer = (query: Query, where: number, wide: boolean) => {
  where = serializeSparseSetToBuffer(query, where, wide);
  where = serializeSparseSetToBuffer(query.toRemove, where, wide);
  where = serializeString(query.queryKey, where);
  where = serializeNumberObject(query.masks, where);
  where = serializeNumberArray(query.generations, where);

  return where;
};

// Reusable scratch buffer: allocated once (and grown on demand) instead of a fresh
// `maxBytes` allocation per call. The returned buffer is always a trimmed copy.
let scratchBuffer: ArrayBuffer | null = null;
let scratchView: DataView | null = null;
let scratchBytes: Uint8Array | null = null;

const setScratch = (buffer: ArrayBuffer) => {
  scratchBuffer = buffer;
  scratchView = new DataView(buffer);
  scratchBytes = new Uint8Array(buffer);
};

/** Makes sure the scratch buffer holds at least `bytes` bytes (its first use, or a larger `maxBytes`). */
const getScratch = (bytes: number) => {
  if (!scratchBuffer || scratchBuffer.byteLength < bytes) setScratch(new ArrayBuffer(bytes));
};

/**
 * Makes room for `n` more bytes at `where`, growing the scratch buffer (at least doubling it) and
 * keeping the `where` bytes already written. `maxBytes` is only the starting size, so large worlds
 * never fail for lack of space. Writers re-read scratchView/scratchBytes after calling this.
 */
const reserve = (where: number, n: number) => {
  const need = where + n;
  const buffer = scratchBuffer!;
  if (need <= buffer.byteLength) return;
  let size = Math.max(buffer.byteLength * 2, 1024);
  while (size < need) size *= 2;
  const next = new ArrayBuffer(size);
  new Uint8Array(next).set(new Uint8Array(buffer, 0, where));
  setScratch(next);
};

/** Serializes into the shared scratch buffer and returns the number of bytes written. */
const serializeWorldToScratch = (world: World, maxBytes = 20000000, deltaState?: DeltaState, mode: number = 0) => {
  getScratch(maxBytes);
  // Ids are below `size` and the cursor is at most `size`, so 16 bits suffice (with 0xffff left free
  // as the missing-slot marker) while size fits in 16 bits.
  const wide = world.size > 0xffff || world.entityCursor > 0xffff;

  let where = 0;

  reserve(where, 4);
  scratchView!.setUint16(where, SERIALIZER_VERSION);
  where += 2;

  // mode byte: 0 = full, 1 = delta
  scratchView!.setUint8(where, mode);
  where += 1;

  // index width byte: 2 or 4
  scratchView!.setUint8(where, wide ? 4 : 2);
  where += 1;

  where = serializeSparseSetToBuffer(world.entitySparseSet, where, wide);
  where = serializeUintArray(world.removed, where, wide);

  reserve(where, 2 * 4 + 4 + 4 + 2);
  let view = scratchView!;
  if (wide) {
    view.setUint32(where, world.entityCursor);
    view.setUint32(where + 4, world.size);
    where += 8;
  } else {
    view.setUint16(where, world.entityCursor);
    view.setUint16(where + 2, world.size);
    where += 4;
  }
  view.setUint32(where, world.bitflag);
  where += 4;
  view.setUint32(where, world.frame);
  where += 4;

  view.setUint16(where, world.componentMap.size);
  where += 2;

  world.componentMap.forEach((value, key) => {
    const component = key as typeof Schema;
    where = serializeString(component.type, where);
    reserve(where, 8);
    scratchView!.setUint32(where, value.generationId);
    where += 4;
    scratchView!.setUint32(where, value.bitflag);
    where += 4;
  });

  const queryMap = Array.from(world.queryMap.entries());
  reserve(where, 2);
  scratchView!.setUint16(where, queryMap.length);
  where += 2;
  for (let i = 0; i < queryMap.length; i++) {
    const [key, value] = queryMap[i];
    where = serializeString(key, where);
    where = serializeQueryToBuffer(value, where, wide);
  }

  reserve(where, 2);
  view = scratchView!;
  view.setUint16(where, world.dirtyQueries.size);
  where += 2;

  for (let i = 0; i < queryMap.length; i++) {
    const [key, value] = queryMap[i];
    if (world.dirtyQueries.has(value)) {
      where = serializeString(key, where);
    }
  }

  where = serializeEntities(world, where, deltaState, mode);

  return where;
};

const scratchBytesView = (length: number) => new Uint8Array(scratchBuffer as ArrayBuffer, 0, length);

const serializeWorldToBuffer = (world: World, maxBytes = 20000000, deltaState?: DeltaState, mode: number = 0) => {
  const length = serializeWorldToScratch(world, maxBytes, deltaState, mode);
  return (scratchBuffer as ArrayBuffer).slice(0, length);
};

/**
 * Binary serialization without the trailing copy: returns a view into a shared scratch buffer.
 * The view is only valid until the next serialize call (of any world), so consume it synchronously
 * (send it, hash it, copy it) or use `serializeWorld(SerialMode.BINARY, world)` instead.
 */
export const serializeWorldView = (world: World, maxBytes = 20000000): Uint8Array => {
  return scratchBytesView(serializeWorldToScratch(world, maxBytes));
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
        ...Array.from(world.queryMap.entries()).reduce(
          (queries, [key, value]) => {
            queries[key] = serializeQuery(value);
            return queries;
          },
          {} as Record<string, SerializedQuery>,
        ),
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
    // Encode straight from the scratch view; no intermediate ArrayBuffer copy.
    return Base64.fromUint8Array(serializeWorldView(world));
  }
}

export const createDeltaSerializer = (world: World) => {
  let initialized = false;
  const changedProps = new Map<any, DeltaShadow>();
  const storeEntityCache = new Map<any, Uint8Array>();

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

  const serializeToScratch = (maxBytes: number): number => {
    if (!initialized) {
      initShadows();
      // First call: full serialization (mode 0) but with shadows active so they get synced
      return serializeWorldToScratch(world, maxBytes, { changedProps, storeEntityCache }, 0);
    }
    const dirtyProps = consumeDeltaDirtyTracking(world);
    // Subsequent calls: delta serialization (mode 1)
    return serializeWorldToScratch(world, maxBytes, { changedProps, storeEntityCache, dirtyProps }, 1);
  };

  const serialize = (maxBytes = 20000000): ArrayBuffer => {
    const length = serializeToScratch(maxBytes);
    return (scratchBuffer as ArrayBuffer).slice(0, length);
  };

  /** Like serialize, but returns a view into the shared scratch buffer (valid until the next serialize). */
  const serializeView = (maxBytes = 20000000): Uint8Array => {
    return scratchBytesView(serializeToScratch(maxBytes));
  };

  const reset = () => {
    initialized = false;
    clearDeltaDirtyTracking(world);
  };

  return { serialize, serializeView, reset };
};

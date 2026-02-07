import type { Schema } from "./Schema";
import type { SparseSet } from "./SparseSet";
import type { Store } from "./Storage";
import type { SystemImpl } from "./System";

export type SerializedQuery = {
  queryKey: string;
  generations: number[];
  masks: {
    [key: number]: number;
  };
  dense: number[];
  sparse: number[];
  toRemove: {
    dense: number[];
    sparse: number[];
  };
  entered: {
    dense: number[];
    sparse: number[];
  };
};

export const TYPES = {
  i8: Int8Array,
  ui8: Uint8Array,
  ui8c: Uint8ClampedArray,
  i16: Int16Array,
  ui16: Uint16Array,
  i32: Int32Array,
  ui32: Uint32Array,
  f32: Float32Array,
  f64: Float64Array,
  eid: Uint32Array,
};

export const UNSIGNED_MAX = {
  uint8: 2 ** 8,
  uint16: 2 ** 16,
  uint32: 2 ** 32,
};

export type Constructor<T> = {
  new (...args: any[]): T;
};

export const StringToEnum = <T>(rep: number | string | undefined, enumToCheck: any): T | undefined => {
  if (rep === undefined) {
    return undefined;
  }
  if (typeof rep === "string") {
    for (const [key, value] of Object.entries(enumToCheck)) {
      if (key.toLowerCase() === rep.toLowerCase()) {
        rep = value as number;
        break;
      }
    }
  }
  return rep as unknown as T;
};

export const EnumToString = (rep: number, enumToCheck: any): string | undefined => {
  for (const [key, value] of Object.entries(enumToCheck)) {
    if (value === rep) {
      return key;
    }
  }
  return undefined;
};

export type PrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "int64"
  | "uint64"
  | "float32"
  | "float64"
  | typeof Schema;

export const altNumberTypes = [
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "float32",
  "float64",
];
export const simpleToBitecs = {
  int8: TYPES.i8,
  uint8: TYPES.ui8,
  int16: TYPES.i16,
  uint16: TYPES.ui16,
  int32: TYPES.i32,
  uint32: TYPES.ui32,
  float32: TYPES.f32,
  float64: TYPES.f64,
};

export const simpleToTypeKey: Record<string, string> = {
  number: "f64",
  boolean: "ui8",
  int8: "i8",
  uint8: "ui8",
  int16: "i16",
  uint16: "ui16",
  int32: "i32",
  uint32: "ui32",
  float32: "f32",
  float64: "f64",
};

export enum SerialMode {
  JSON,
  BINARY,
  BASE64,
}

export type SerializedWorld = {
  frame: number;
  entitySparseSet: {
    dense: number[];
    sparse: number[];
  };
  removed: number[];
  componentMap: [
    string,
    {
      generationId: number;
      bitflag: number;
    }
  ][];
  entityCursor: number;
  size: number;
  bitflag: number;
  queryMap: Record<string, SerializedQuery>;
  dirtyQueries: string[];

  entities: {
    entityId: number;
    components: {
      [key: string]: Schema;
    };
  }[];
};

type SchemaStore<T extends Schema> = {
  [K in keyof T]: T[K][];
} & Store;

export type WorldComponent<T extends Schema = any> = {
  type: string;
  generationId: number;
  bitflag: number;
  queries: Query[];
  store: SchemaStore<T>;
  schema: typeof Schema;
  changedQueries: Set<Query>;
  proxies: (T | null)[];
  booleanKeys: Set<string> | null;
};

export interface World {
  <T extends Schema>(schema: Constructor<T>, eid: number): T;
  <T extends Schema>(schema: Constructor<T>): WorldComponent<T>;
  entityCursor: number;
  componentSchemaStore: Map<Store, WorldComponent>;
  componentMap: Map<typeof Schema, WorldComponent>;
  componentList: WorldComponent[];
  size: number;
  bitflag: number;
  entityMasks: Uint32Array[];
  entitySparseSet: ReturnType<typeof SparseSet>;
  removed: number[];
  queryMap: Map<string, Query>;
  queries: Set<Query>;
  dirtyQueries: Set<Query>;
  frame: number;
  systemQueryMap: Map<string, SystemImpl[]>;
  systems: any[];
  drawSystems: any[];
}

export interface ReadOnlyWorld extends World {
  <T extends Schema>(schema: Constructor<T>, eid: number): Readonly<T>;
  <T extends Schema>(schema: Constructor<T>): Readonly<WorldComponent<T>>;
}

export const isQuery = (query: any): query is Query => {
  return query.toRemove !== undefined;
};

export type Query = ReturnType<typeof SparseSet> & {
  toRemove: ReturnType<typeof SparseSet>;
  entered: ReturnType<typeof SparseSet>;
  generations: number[];
  masks: {
    [key: number]: number;
  };
  queryKey: string;
};

export type QueryInstance<T extends World = World> = ((world: T) => number[]) & {
  has: (world: T, eid: number) => boolean;
};

export const TYPES_ENUM = {
  i8: "i8",
  ui8: "ui8",
  ui8c: "ui8c",
  i16: "i16",
  ui16: "ui16",
  i32: "i32",
  ui32: "ui32",
  f32: "f32",
  f64: "f64",
  eid: "eid",
};

export const TYPES_NAMES = {
  i8: "Int8",
  ui8: "Uint8",
  ui8c: "Uint8Clamped",
  i16: "Int16",
  ui16: "Uint16",
  i32: "Int32",
  ui32: "Uint32",
  eid: "Uint32",
  f32: "Float32",
  f64: "Float64",
};

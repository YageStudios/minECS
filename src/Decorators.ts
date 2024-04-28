import Ajv from "ajv";
import { generateSchema, type Schema } from "./Schema";
import { altNumberTypes, simpleToBitecs, type PrimitiveType } from "./Types";
import { defineComponent } from "./Component";

const componentStringSchema = new Map<string, typeof Schema>();

export function Component(nameOrCategory?: string | number, category: number = 0) {
  return function (cls: typeof Schema) {
    let name = cls.name;
    if (nameOrCategory) {
      if (typeof nameOrCategory === "string") {
        name = nameOrCategory;
      } else {
        category = nameOrCategory;
      }
    }

    if (!cls.category) {
      // @ts-ignore
      cls.category = category;
    }

    if (componentStringSchema.has(name)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const existingSchema = componentStringSchema.get(name)!;
      // @ts-ignore
      cls.schema = existingSchema.schema;
      // @ts-ignore
      cls.type = existingSchema.type;
      // @ts-ignore
      cls.validate = existingSchema.validate;
      // @ts-ignore
      cls.index = existingSchema.index;
      cls.createStore = existingSchema.createStore;
      // @ts-ignore
      cls.constructables = existingSchema.constructables;
      // @ts-ignore
      cls.primativesSchema = existingSchema.primativesSchema;

      componentStringSchema.set(name, cls);

      return;
    }

    if (!cls.schema) {
      // @ts-ignore
      cls.schema = false;
      componentStringSchema.set(name, cls);
      // @ts-ignore
      cls.type = name;
      // @ts-ignore
      cls.validate = () => true;
      defineComponent(cls);

      return;
    }

    generateSchema({ constructor: cls } as Schema).setType("type", "string");
    componentStringSchema.set(name, cls);
    // @ts-ignore
    cls.type = name;

    defineComponent(cls);

    try {
      // @ts-ignore
      const validate = ajv.compile(cls.schema);
      // @ts-ignore
      cls.validate = validate;
    } catch (e) {
      console.error(e);
      console.error(cls.schema);
      throw e;
    }
  };
}

const convertToBitecs = (value: string) => {
  // @ts-ignore
  return simpleToBitecs[value];
};
const ajv = new Ajv({ useDefaults: true, strict: false, allErrors: true });

const isRecord = (value: any): value is Record<string | number, string | number> => {
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const numberKeys = keys.filter((key) => !isNaN(Number(key)));
  const stringKeys = keys.filter((key) => isNaN(Number(key)));
  return numberKeys.length === stringKeys.length;
};

export function type(
  type:
    | "Entity"
    | "EntityArray"
    | PrimitiveType
    | "object"
    | typeof Schema
    | any[]
    | Record<string | number, string | number>
    | {
        set: PrimitiveType;
      }
) {
  return function (target: any, key: string) {
    if (typeof key === "string" && key.startsWith("_")) {
      key = key.substring(1);
    }
    const schema = generateSchema(target);

    if (isRecord(type)) {
      schema.setType(key, "number");
      schema.setEnum(key, type);
    } else if (type === "Entity" || type === "EntityArray" || (Array.isArray(type) && type[0] === "Entity")) {
      if (type === "Entity") {
        schema.setType(key, "number");
      } else {
        schema.setArrayType(key, "number");
      }
    } else if (Array.isArray(type)) {
      schema.setArrayType(key, type[0]);
    } else if (typeof type === "object" && type?.set) {
      schema.setArrayType(key, type.set);
    } else if (typeof type === "function") {
      schema.setObjectType(key, type);
    } else {
      const minECSType = convertToBitecs(type as string);
      if (minECSType) {
        target.constructor.__minECS = target.constructor.__minECS || {};
        target.constructor.__minECS[key] = convertToBitecs(type as string);
      }
      // @ts-ignore
      schema.setType(key, altNumberTypes.includes(type) ? "number" : type);
    }
  };
}

export function defaultValue(value: any) {
  return function (target: any, key: string) {
    const schema = generateSchema(target);
    if (typeof key === "string" && key.startsWith("_")) {
      key = key.substring(1);
    }
    schema.setDefault(key, value);
    if (typeof key === "string") {
      schema.setRequired(key);
    }
  };
}

export function required() {
  return function (target: any, key: string) {
    generateSchema(target).setRequired(key);
  };
}

export function Enum(enumToCheck: any) {
  return function (target: any, key: string) {
    generateSchema(target).setEnum(key, enumToCheck);
  };
}

export function mapType(type: any) {
  return function (target: any, key: string) {
    generateSchema(target).setMapType(key, type);
  };
}

export function nullable() {
  return function (target: any, key: string) {
    generateSchema(target).setType(key, "null");
  };
}

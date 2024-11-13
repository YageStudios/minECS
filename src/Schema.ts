import type { Store } from "./Storage";
import { altNumberTypes } from "./Types";
import lodash from "lodash";

const { cloneDeep: clone } = lodash;

export class Schema {
  static readonly schema: any;
  static readonly primativesSchema: any;
  static readonly type: string;
  static readonly constructables: { [key: string]: typeof Schema };
  static readonly category: number;
  static readonly validate: any;
  static readonly index: number;
  static readonly id: number;
  static readonly entityTypes: string[];
  static createStore: () => Store;

  constructor() {
    const schema = this.constructor as typeof Schema;
    if (schema.constructables) {
      Object.entries(schema.constructables).forEach(([key, Constructor]: [string, typeof Schema]) => {
        const keyName = key as keyof this;
        if (Array.isArray(this[keyName])) {
          // @ts-ignore
          this[keyName] = this[keyName].map((x) => new Constructor(x));
        } else if (this[keyName] !== undefined) {
          // @ts-ignore
          this[keyName] = new Constructor(this[keyName]);
        }
      });
    }
  }
}

const addType = (properties: any, type: string) => {
  if (properties) {
    if (Array.isArray(properties.type) && !properties.type.includes(type)) {
      properties.type.push(type);
    } else if (properties.type !== type) {
      properties.type = [properties.type, type];
    }
  } else {
    return {
      type: type,
    };
  }
  return properties;
};

export const generateSchema = (target: Schema) => {
  const constructor = target.constructor as typeof Schema;
  if (constructor.schema && constructor.schema.$comment !== constructor.name) {
    // @ts-ignore
    constructor.schema = clone(constructor.schema);
    constructor.schema.$comment = constructor.name;
  } else {
    // @ts-ignore
    constructor.schema = constructor.schema || {
      type: "object",
      additionalProperties: false,
      $comment: constructor.name,
    };
  }
  constructor.schema.properties = constructor.schema.properties || {};
  constructor.schema.required = constructor.schema.required || [];
  // @ts-ignore
  constructor.entityTypes = constructor.entityTypes || [];

  return {
    setEnum: (propertyKey: string, enumToCheck: any) => {
      if (!constructor.schema.properties[propertyKey]) {
        constructor.schema.properties[propertyKey] = {
          type: "number",
        };
      }
      constructor.schema.properties[propertyKey].enum = [];
      constructor.schema.properties[propertyKey].options = {
        enum_titles: [],
      };

      for (const [key, value] of Object.entries(enumToCheck)) {
        if (typeof value === "number") {
          constructor.schema.properties[propertyKey].options.enum_titles.push(key);
          constructor.schema.properties[propertyKey].enum.push(value);
        }
      }
    },
    setDefault: (key: string, value: any) => {
      if (value !== null) {
        constructor.schema.properties[key] = addType(constructor.schema.properties[key], typeof value);
      } else if (!constructor.schema.properties[key]) {
        constructor.schema.properties[key] = {};
      }
      constructor.schema.properties[key].default = value;
    },
    setRequired: (key: string) => {
      if (!constructor.schema.required.includes(key)) {
        constructor.schema.required.push(key);
      }
    },
    setEntityFlag: (key: string) => {
      constructor.entityTypes.push(key);
    },
    setType: (key: string, type: string) => {
      const prevType = constructor.schema.properties[key]?.type;
      let setType: any = altNumberTypes.includes(type) ? "number" : type;

      if (prevType && prevType !== type) {
        if (Array.isArray(prevType)) {
          if (!prevType.includes(type)) {
            setType = prevType.concat(type);
          } else {
            setType = prevType;
          }
        } else {
          if (prevType !== type) {
            setType = [prevType, setType];
          } else {
            setType = prevType;
          }
        }
      }

      constructor.schema.properties[key] = {
        ...(constructor.schema.properties[key] ?? {}),
        type: setType,
      };
    },
    setArrayType: function (key: string, type: string | typeof Schema) {
      if (typeof type !== "string") {
        // @ts-ignore
        constructor.constructables = constructor.constructables || {};
        constructor.constructables[key] = type;
      }

      if (typeof type === "string") {
        constructor.schema.properties[key] = {
          ...(constructor.schema.properties[key] ?? {}),
          type: "array",
          items: {
            type: altNumberTypes.includes(type) ? "number" : type,
          },
        };
      } else {
        constructor.schema.properties[key] = {
          ...(constructor.schema.properties[key] ?? {}),
          type: "array",
          items: {
            type: "object",
            properties: type.schema.properties,
            required: type.schema.required,
            additionalProperties: false,
          },
        };
      }
    },
    setObjectType: (key: string, type: typeof Schema) => {
      // @ts-ignore
      constructor.constructables = constructor.constructables || {};
      constructor.constructables[key] = type;

      constructor.schema.properties[key] = {
        ...(constructor.schema.properties[key] ?? {}),
        type: "object",
        properties: type.schema.properties,
        required: type.schema.required,
        additionalProperties: false,
      };
    },
    setMapType: (key: string, type: string | typeof Schema) => {
      constructor.schema.properties[key] = {
        ...(constructor.schema.properties[key] ?? {}),
        type: "object",
        patternProperties: {
          ".*":
            typeof type === "string"
              ? { type: altNumberTypes.includes(type) ? "number" : type }
              : {
                  type: "object",
                  properties: type.schema.properties,
                  required: type.schema.required,
                  additionalProperties: false,
                },
        },
        properties: undefined,
        required: undefined,
        additionalProperties: false,
      };
      delete constructor.schema.properties[key].properties;
      delete constructor.schema.properties[key].required;
    },
  };
};

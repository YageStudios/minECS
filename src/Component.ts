import type { Store } from "./Storage";
import { $storeFlattened, FauxStore, createStore } from "./Storage";
import type { Schema } from "./Schema";

/****************************************************
 *
 * Components
 *
 ****************************************************/

// const components: Store[] = [];
export const componentKeyMap = new Map<string, typeof Schema>();
export const componentSchemaStore = new Map<Store, typeof Schema>();
export const componentIndex = new Map<string, number>();
export const componentList: Readonly<(typeof Schema)[]> = [];

export const freezeComponentOrder = () => {
  if (componentList.length) return;
  const keys = Array.from(componentKeyMap.keys()).sort((a, b) => a.localeCompare(b));
  keys.forEach((key, index) => {
    componentIndex.set(key, index);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const component = componentKeyMap.get(key)!;
    // @ts-ignore
    component.index = index;
    // @ts-ignore
    componentList.push(component);
  });
};

export const defineComponent = (componentSchema: typeof Schema, size = 100000) => {
  if (componentList.length) {
    throw new Error("minECS - Cannot define a component after the world has been created.");
  }
  componentKeyMap.set(componentSchema.type, componentSchema);

  componentSchema.createStore = () => {
    const schema = componentSchema.primativesSchema;
    const store = createStore(schema, size);
    if (componentSchema.schema) {
      Object.keys(componentSchema.schema.properties).forEach((key) => {
        if (!schema?.[key] && key !== "type") {
          store[key] = FauxStore(key, store);
          store[$storeFlattened].push(store[key]);
        }
      });
    }
    return store;
  };
};

export const getComponentByType = (type: string) => {
  return componentKeyMap.get(type);
};

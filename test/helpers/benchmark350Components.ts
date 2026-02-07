import { Component, defaultValue, type } from "../../src/Decorators";
import { Schema } from "../../src/Schema";

const generatedComponents: (typeof Schema)[] = [];

function makeComponent(name: string, setup: (proto: Record<string, unknown>) => void): typeof Schema {
  class DynamicComponent extends Schema {}
  setup(DynamicComponent.prototype as Record<string, unknown>);
  Component(name)(DynamicComponent as any);
  generatedComponents.push(DynamicComponent as any);
  return DynamicComponent as any;
}

// 100 components: 2-3 number properties (transforms, physics, velocities)
for (let i = 0; i < 100; i++) {
  makeComponent(`Num2_${i}`, (proto) => {
    type("number")(proto, "a");
    defaultValue(0)(proto, "a");
    type("number")(proto, "b");
    defaultValue(0)(proto, "b");
    if (i % 3 === 0) {
      type("number")(proto, "c");
      defaultValue(0)(proto, "c");
    }
  });
}

// 60 components: 4-6 number properties (stats, configs)
for (let i = 0; i < 60; i++) {
  makeComponent(`Num5_${i}`, (proto) => {
    type("number")(proto, "v1");
    defaultValue(0)(proto, "v1");
    type("number")(proto, "v2");
    defaultValue(0)(proto, "v2");
    type("number")(proto, "v3");
    defaultValue(0)(proto, "v3");
    type("number")(proto, "v4");
    defaultValue(0)(proto, "v4");
    if (i % 2 === 0) {
      type("number")(proto, "v5");
      defaultValue(0)(proto, "v5");
      type("number")(proto, "v6");
      defaultValue(0)(proto, "v6");
    }
  });
}

// 40 components: mixed string + number + boolean
for (let i = 0; i < 40; i++) {
  makeComponent(`Mixed_${i}`, (proto) => {
    type("string")(proto, "name");
    defaultValue("")(proto, "name");
    type("number")(proto, "val");
    defaultValue(0)(proto, "val");
    type("boolean")(proto, "active");
    defaultValue(false)(proto, "active");
  });
}

// 50 tag components (no properties)
for (let i = 0; i < 50; i++) {
  makeComponent(`Tag_${i}`, () => {
    return;
  });
}

// 30 components: varied typed layouts
for (let i = 0; i < 30; i++) {
  const types = ["float32", "int32", "uint16", "int8", "float64"] as const;
  const t = types[i % types.length];
  if (i < 10) {
    // Scalar typed fields
    makeComponent(`TypedScalar_${i}`, (proto) => {
      type(t)(proto, "x");
      defaultValue(0)(proto, "x");
      type(t)(proto, "y");
      defaultValue(0)(proto, "y");
    });
  } else if (i < 20) {
    // Fixed-length typed arrays (important for delta shadow coverage)
    makeComponent(`TypedArray_${i}`, (proto) => {
      type([t, 8])(proto, "values");
    });
  } else {
    // Hybrid typed shape: scalar + fixed-length array
    makeComponent(`TypedHybrid_${i}`, (proto) => {
      type(t)(proto, "value");
      defaultValue(0)(proto, "value");
      type([t, 4])(proto, "history");
    });
  }
}

// 40 components: number + string pairs (labels, metadata)
for (let i = 0; i < 40; i++) {
  makeComponent(`Meta_${i}`, (proto) => {
    type("number")(proto, "id");
    defaultValue(0)(proto, "id");
    type("string")(proto, "label");
    defaultValue("")(proto, "label");
  });
}

// 30 components: heavier (8-10 number properties)
for (let i = 0; i < 30; i++) {
  makeComponent(`Heavy_${i}`, (proto) => {
    for (let j = 0; j < 8 + (i % 3); j++) {
      type("number")(proto, `p${j}`);
      defaultValue(0)(proto, `p${j}`);
    }
  });
}

export const benchmark350Components = generatedComponents;
export const benchmark350Count = benchmark350Components.length;

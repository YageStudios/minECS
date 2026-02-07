import { describe, test, expect } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import { createWorld, addEntity, addComponent, sortComponentQueries } from "../src/World";
import { Schema } from "../src/Schema";
import { createStore } from "../src/Storage";
import { freezeComponentOrder, componentList } from "../src/Component";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// Generate 350+ components programmatically
// ============================================================

const allComponents: (typeof Schema)[] = [];

function makeComponent(name: string, setup: (proto: any) => void) {
  class C extends Schema {}
  setup(C.prototype);
  Component(name)(C as any);
  allComponents.push(C as any);
  return C;
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
  makeComponent(`Tag_${i}`, () => {});
}

// 30 components: typed numbers (float32, int32, uint16, etc.)
for (let i = 0; i < 30; i++) {
  const types = ["float32", "int32", "uint16", "int8", "float64"] as const;
  const t = types[i % types.length];
  makeComponent(`Typed_${i}`, (proto) => {
    type(t)(proto, "x");
    defaultValue(0)(proto, "x");
    type(t)(proto, "y");
    defaultValue(0)(proto, "y");
  });
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

// ============================================================
// Benchmark
// ============================================================

interface BenchmarkResult {
  name: string;
  totalMs: number;
  details?: string;
}

const results: BenchmarkResult[] = [];

function benchOnce(name: string, fn: () => void, details?: string) {
  const start = performance.now();
  fn();
  const totalMs = performance.now() - start;
  const result = { name, totalMs: Math.round(totalMs * 1000) / 1000, details };
  results.push(result);
  return result;
}

describe(`Startup Benchmark (${allComponents.length} components)`, () => {
  test("component count", () => {
    expect(allComponents.length).toBeGreaterThanOrEqual(350);
  });

  test("createWorld (default size=1000)", () => {
    const r = benchOnce("createWorld default (1k)", () => {
      createWorld();
    }, `${allComponents.length} components, size=1000`);
    expect(r.totalMs).toBeDefined();
  });

  test("createWorld (size=10000)", () => {
    const r = benchOnce("createWorld 10k", () => {
      createWorld(10000);
    }, `${allComponents.length} components, size=10000`);
    expect(r.totalMs).toBeDefined();
  });

  test("createWorld (size=50000)", () => {
    const r = benchOnce("createWorld 50k", () => {
      createWorld(50000);
    }, `${allComponents.length} components, size=50000`);
    expect(r.totalMs).toBeDefined();
  });

  test("createWorld + 1000 entities + 3 components each", () => {
    const c0 = allComponents[0];
    const c1 = allComponents[1];
    const c2 = allComponents[100];
    const r = benchOnce("createWorld + populate 1k ents", () => {
      const world = createWorld(5000);
      for (let i = 0; i < 1000; i++) {
        const eid = addEntity(world);
        addComponent(world, c0, eid);
        addComponent(world, c1, eid);
        addComponent(world, c2, eid);
      }
    }, `${allComponents.length} components registered, 3 added per entity`);
    expect(r.totalMs).toBeDefined();
  });

  // ============================================================
  // Phase breakdown profiling
  // ============================================================

  test("Profile: freezeComponentOrder", () => {
    // Already frozen from prior createWorld calls, but measure the no-op cost
    const r = benchOnce("freezeComponentOrder (no-op)", () => {
      freezeComponentOrder();
    }, "Already frozen, measures early-return cost");
    expect(r.totalMs).toBeDefined();
  });

  test("Profile: createStore breakdown", () => {
    freezeComponentOrder();
    const size = 1000;

    // Categorize components
    const tagSchemas: (typeof Schema)[] = [];
    const typedSchemas: (typeof Schema)[] = [];
    const mixedSchemas: (typeof Schema)[] = [];

    for (const schema of componentList) {
      const prims = schema.primativesSchema;
      const hasProps = schema.schema && Object.keys(schema.schema.properties || {}).length > 1; // >1 because "type" is always there
      if (!hasProps) {
        tagSchemas.push(schema);
      } else if (prims && Object.keys(prims).length > 0) {
        // Check if ALL non-type properties are typed (pure typed) or mixed
        const propKeys = Object.keys(schema.schema.properties).filter((k) => k !== "type");
        const primKeys = Object.keys(prims);
        if (primKeys.length >= propKeys.length) {
          typedSchemas.push(schema);
        } else {
          mixedSchemas.push(schema);
        }
      } else {
        mixedSchemas.push(schema);
      }
    }

    // Time tag stores
    const tagStart = performance.now();
    for (const schema of tagSchemas) {
      schema.createStore(1000);
    }
    const tagMs = performance.now() - tagStart;
    results.push({
      name: `  createStore: ${tagSchemas.length} tag components`,
      totalMs: Math.round(tagMs * 1000) / 1000,
      details: `${(tagMs / tagSchemas.length * 1000).toFixed(1)}μs/component`,
    });

    // Time pure typed stores (TypedArray only)
    const typedStart = performance.now();
    for (const schema of typedSchemas) {
      schema.createStore(1000);
    }
    const typedMs = performance.now() - typedStart;
    results.push({
      name: `  createStore: ${typedSchemas.length} typed components`,
      totalMs: Math.round(typedMs * 1000) / 1000,
      details: `${(typedMs / typedSchemas.length * 1000).toFixed(1)}μs/component`,
    });

    // Time mixed stores (TypedArray + FauxStore)
    const mixedStart = performance.now();
    for (const schema of mixedSchemas) {
      schema.createStore(1000);
    }
    const mixedMs = performance.now() - mixedStart;
    results.push({
      name: `  createStore: ${mixedSchemas.length} mixed components`,
      totalMs: Math.round(mixedMs * 1000) / 1000,
      details: `${(mixedMs / mixedSchemas.length * 1000).toFixed(1)}μs/component`,
    });

    // Total
    const totalStoreMs = tagMs + typedMs + mixedMs;
    results.push({
      name: `  createStore: TOTAL (${componentList.length})`,
      totalMs: Math.round(totalStoreMs * 1000) / 1000,
      details: `${(totalStoreMs / componentList.length * 1000).toFixed(1)}μs/component avg`,
    });
  });

  test("Profile: sortComponentQueries overhead", () => {
    const world = createWorld(1000);
    const sortStart = performance.now();
    for (const schema of componentList) {
      sortComponentQueries(world, schema);
    }
    const sortMs = performance.now() - sortStart;
    results.push({
      name: `  sortComponentQueries (${componentList.length})`,
      totalMs: Math.round(sortMs * 1000) / 1000,
      details: `${(sortMs / componentList.length * 1000).toFixed(1)}μs/component`,
    });
  });

  test("Profile: registerComponent overhead (by subtraction)", () => {
    // Measure createWorld, subtract createStore total, subtract sortQueries
    // to isolate registerComponent's own overhead (bitflags, maps, etc.)
    const size = 1000;

    // Time just createStore for all components
    const storeStart = performance.now();
    for (const schema of componentList) {
      schema.createStore(1000);
    }
    const storeMs = performance.now() - storeStart;

    // Time full createWorld
    const worldStart = performance.now();
    const world = createWorld(size);
    const worldMs = performance.now() - worldStart;

    // Time sortComponentQueries
    const sortStart = performance.now();
    for (const schema of componentList) {
      sortComponentQueries(world, schema);
    }
    const sortMs = performance.now() - sortStart;

    const registerOverhead = worldMs - storeMs - sortMs;

    results.push({
      name: `  BREAKDOWN for createWorld (${size})`,
      totalMs: Math.round(worldMs * 1000) / 1000,
      details: "total",
    });
    results.push({
      name: `    createStore (all)`,
      totalMs: Math.round(storeMs * 1000) / 1000,
      details: `${((storeMs / worldMs) * 100).toFixed(1)}% of total`,
    });
    results.push({
      name: `    sortComponentQueries`,
      totalMs: Math.round(sortMs * 1000) / 1000,
      details: `${((sortMs / worldMs) * 100).toFixed(1)}% of total`,
    });
    results.push({
      name: `    registerComponent overhead`,
      totalMs: Math.round(registerOverhead * 1000) / 1000,
      details: `${((registerOverhead / worldMs) * 100).toFixed(1)}% (bitflags, maps, world init)`,
    });
  });

  test("Write results", () => {
    const lines = [
      "=".repeat(70),
      `  Startup Benchmark (${allComponents.length} components)`,
      "=".repeat(70),
      "",
    ];
    for (const r of results) {
      lines.push(`  ${r.name.padEnd(45)} ${r.totalMs.toFixed(3).padStart(10)}ms`);
      if (r.details) lines.push(`    -> ${r.details}`);
    }
    lines.push("");

    const output = lines.join("\n");
    console.log(output);
    const outPath = path.resolve(__dirname, "..", "benchmark_startup.txt");
    fs.writeFileSync(outPath, output, "utf-8");
  });
});

import { describe, expect, test } from "vitest";
import { addComponent, addEntity, createWorld } from "../src/World";
import { applyDelta, deserializeWorld } from "../src/Deserialize";
import { createDeltaSerializer, serializeWorld } from "../src/Serialize";
import { Schema } from "../src/Schema";
import { SerialMode, type World } from "../src/Types";
import { benchmark350Components, benchmark350Count } from "./helpers/benchmark350Components";
import * as fs from "fs";
import * as path from "path";

type BenchmarkVariant = "no-delta" | "delta";

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
  bytes?: number;
  details?: string;
  variant: BenchmarkVariant;
}

type DeltaTarget = {
  eid: number;
  schema: typeof Schema;
  key: "values" | "history";
};

const results: BenchmarkResult[] = [];
const COMPLEX_BENCH_TIMEOUT_MS = 60_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function bench(
  name: string,
  iterations: number,
  fn: () => void,
  variant: BenchmarkVariant,
  details?: string,
  bytes?: number
): BenchmarkResult {
  for (let i = 0; i < Math.min(iterations, 20); i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();

  const totalMs = end - start;
  const avgMs = totalMs / iterations;
  const opsPerSec = (iterations / totalMs) * 1000;

  const result: BenchmarkResult = {
    name,
    iterations,
    totalMs: Math.round(totalMs * 1000) / 1000,
    avgMs: Math.round(avgMs * 10000) / 10000,
    opsPerSec: Math.round(opsPerSec),
    bytes,
    details,
    variant,
  };

  results.push(result);
  return result;
}

function pickByPrefix(prefix: string): (typeof Schema)[] {
  return benchmark350Components.filter((c) => c.type.startsWith(prefix));
}

function createComplexWorld(entityCount = 800): { world: World; deltaTargets: DeltaTarget[] } {
  const world = createWorld(entityCount * 3);
  const deltaTargets: DeltaTarget[] = [];

  const num2 = pickByPrefix("Num2_");
  const num5 = pickByPrefix("Num5_");
  const mixed = pickByPrefix("Mixed_");
  const tags = pickByPrefix("Tag_");
  const typedScalar = pickByPrefix("TypedScalar_");
  const typedArray = pickByPrefix("TypedArray_");
  const typedHybrid = pickByPrefix("TypedHybrid_");
  const meta = pickByPrefix("Meta_");
  const heavy = pickByPrefix("Heavy_");

  if (!typedArray.length || !typedHybrid.length || !typedScalar.length) {
    throw new Error("Typed component variants are missing from benchmark350Components");
  }

  for (let i = 0; i < entityCount; i++) {
    const eid = addEntity(world);

    addComponent(world, num2[i % num2.length], eid, { a: i, b: i * 2 } as any);
    addComponent(world, num5[i % num5.length], eid, { v1: i, v2: i + 1, v3: i + 2, v4: i + 3 } as any);
    addComponent(world, mixed[i % mixed.length], eid, { name: `ent_${i}`, val: i * 3, active: i % 2 === 0 } as any);
    addComponent(world, tags[i % tags.length], eid);
    addComponent(world, typedScalar[i % typedScalar.length], eid, { x: i % 127, y: (i * 2) % 127 } as any);

    const typedArraySchema = typedArray[i % typedArray.length];
    addComponent(world, typedArraySchema, eid, { values: Array.from({ length: 8 }, (_, j) => i + j) } as any);
    deltaTargets.push({ eid, schema: typedArraySchema, key: "values" });

    const typedHybridSchema = typedHybrid[i % typedHybrid.length];
    addComponent(world, typedHybridSchema, eid, {
      value: i,
      history: Array.from({ length: 4 }, (_, j) => i + j),
    } as any);
    deltaTargets.push({ eid, schema: typedHybridSchema, key: "history" });

    addComponent(world, meta[i % meta.length], eid, { id: i, label: `label_${i}` } as any);
    addComponent(world, heavy[i % heavy.length], eid);
  }

  return { world, deltaTargets };
}

function mutateDeltaTargets(world: World, deltaTargets: DeltaTarget[], tick: number): void {
  for (let i = 0; i < deltaTargets.length; i += 4) {
    const target = deltaTargets[i];
    const arr = (world as any)(target.schema, target.eid)[target.key] as { length: number; [key: number]: number };
    const index = (i + tick) % arr.length;
    arr[index] = arr[index] + 1;
  }
}

function formatResults(resultsList: BenchmarkResult[]): string {
  const lines: string[] = [];

  lines.push("=".repeat(98));
  lines.push(`  Complex Serialization Benchmark (${benchmark350Count} components)`);
  lines.push("  Date: " + new Date().toISOString());
  lines.push("=".repeat(98));
  lines.push("");

  for (const r of resultsList) {
    const nameStr = r.name.padEnd(52);
    const totalStr = `${r.totalMs.toFixed(3)}ms`.padStart(12);
    const avgStr = `${r.avgMs.toFixed(4)}ms/op`.padStart(16);
    const opsStr = `${r.opsPerSec.toLocaleString()} ops/s`.padStart(18);
    const bytesStr = (r.bytes !== undefined ? formatBytes(r.bytes) : "-").padStart(12);
    lines.push(`  ${nameStr}${totalStr}${avgStr}${opsStr}${bytesStr}`);
    if (r.details) lines.push(`    -> ${r.details}`);
  }

  const noDelta = resultsList.filter((r) => r.variant === "no-delta");
  const delta = resultsList.filter((r) => r.variant === "delta");

  const noDeltaMs = noDelta.reduce((sum, r) => sum + r.totalMs, 0);
  const deltaMs = delta.reduce((sum, r) => sum + r.totalMs, 0);
  const noDeltaBytes = noDelta.reduce((sum, r) => sum + (r.bytes || 0), 0);
  const deltaBytes = delta.reduce((sum, r) => sum + (r.bytes || 0), 0);

  const timeDiffPct = noDeltaMs > 0 ? (((deltaMs - noDeltaMs) / noDeltaMs) * 100).toFixed(1) : "n/a";
  const sizeDiffPct = noDeltaBytes > 0 ? (((deltaBytes - noDeltaBytes) / noDeltaBytes) * 100).toFixed(1) : "n/a";

  lines.push("");
  lines.push("-".repeat(98));
  lines.push("  Total Diff Summary");
  lines.push("-".repeat(98));
  lines.push(
    `  No Delta TOTAL: ${noDeltaMs.toFixed(3)}ms, ${formatBytes(noDeltaBytes)}   |   ` +
      `Delta TOTAL: ${deltaMs.toFixed(3)}ms, ${formatBytes(deltaBytes)}`
  );
  lines.push(`  Diff: ${timeDiffPct}% time, ${sizeDiffPct}% size`);
  lines.push("");

  return lines.join("\n");
}

describe(`Complex Serialization Benchmarks (${benchmark350Count} components)`, () => {
  test("component count", () => {
    expect(benchmark350Count).toBeGreaterThanOrEqual(350);
  });

  test("Serialize/Deserialize with and without delta", () => {
    const { world, deltaTargets } = createComplexWorld(800);

    const fullBuffer = serializeWorld(SerialMode.BINARY, world);
    bench(
      "Complex Serialize [No Delta]",
      3,
      () => {
        serializeWorld(SerialMode.BINARY, world);
      },
      "no-delta",
      `Payload ${formatBytes(fullBuffer.byteLength)}`,
      fullBuffer.byteLength
    );

    const deltaSerializer = createDeltaSerializer(world);
    deltaSerializer.serialize(); // initialize baseline + shadows
    let tick = 0;
    mutateDeltaTargets(world, deltaTargets, ++tick);
    const deltaBuffer = deltaSerializer.serialize();

    bench(
      "Complex Serialize [Delta]",
      3,
      () => {
        mutateDeltaTargets(world, deltaTargets, ++tick);
        deltaSerializer.serialize();
      },
      "delta",
      `Payload ${formatBytes(deltaBuffer.byteLength)}`,
      deltaBuffer.byteLength
    );

    bench(
      "Complex Deserialize [No Delta]",
      3,
      () => {
        const target = createWorld(4000);
        deserializeWorld(fullBuffer, target);
      },
      "no-delta",
      `Payload ${formatBytes(fullBuffer.byteLength)}`,
      fullBuffer.byteLength
    );

    const deltaTargetWorld = createWorld(4000);
    deserializeWorld(fullBuffer, deltaTargetWorld);

    bench(
      "Complex Deserialize [Delta Apply]",
      10,
      () => {
        applyDelta(deltaBuffer, deltaTargetWorld);
      },
      "delta",
      `Payload ${formatBytes(deltaBuffer.byteLength)}`,
      deltaBuffer.byteLength
    );

    expect(deltaBuffer.byteLength).toBeLessThan(fullBuffer.byteLength);
  }, COMPLEX_BENCH_TIMEOUT_MS);

  test("Write results", () => {
    const output = formatResults(results);
    console.log(output);
    const outPath = path.resolve(__dirname, "..", "benchmark_serialization_complex.txt");
    fs.writeFileSync(outPath, output, "utf-8");
  });
});

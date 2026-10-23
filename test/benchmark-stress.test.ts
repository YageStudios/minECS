/**
 * Large-world stress run. Opt-in because it allocates a few GB:
 *
 *   npm run stress                                  (4,000,000 entities)
 *   MINECS_STRESS_N=250000 npx vitest run test/benchmark-stress.test.ts
 *
 * Results go to benchmark_stress.txt.
 */
import { describe, expect, test } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { System, SystemImpl } from "../src/System";
import { addComponent, addEntity, createWorld, removeEntity, stepWorld } from "../src/World";
import { createDeltaSerializer, serializeWorld } from "../src/Serialize";
import { applyDelta, deserializeWorld } from "../src/Deserialize";
import { defineQuery } from "../src/Query";
import { SerialMode, type World } from "../src/Types";
import * as fs from "fs";
import * as path from "path";

@Component()
class StressPos extends Schema {
  @type("number")
  x: number;

  @type("number")
  y: number;
}

@Component()
class StressVel extends Schema {
  @type("float32")
  @defaultValue(1)
  vx: number;

  @type("float32")
  @defaultValue(-1)
  vy: number;
}

@Component()
class StressTag extends Schema {}

@Component()
class StressName extends Schema {
  @type("string")
  name: string;
}

@System(StressPos, StressVel)
class StressMove extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    const p = world(StressPos, eid);
    const v = world(StressVel, eid);
    p.x += v.vx;
    p.y += v.vy;
  };
}

const N = Number(process.env.MINECS_STRESS_N ?? 0);
const lines: string[] = [];
const time = <T>(label: string, fn: () => T, extra?: (r: T) => string): T => {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  const line = `  ${label.padEnd(44)} ${ms.toFixed(1).padStart(10)}ms${extra ? "   " + extra(result) : ""}`;
  lines.push(line);
  console.log(line);
  return result;
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

describe.skipIf(!N)(`Stress (${N.toLocaleString()} entities)`, () => {
  test("build, step, serialize, deserialize, delta", () => {
    const moveQuery = defineQuery([StressPos, StressVel]);
    const world = time("createWorld", () => createWorld(N));
    time("addEntity + components", () => {
      for (let i = 0; i < N; i++) {
        const eid = addEntity(world);
        addComponent(world, StressPos, eid, { x: i, y: -i });
        if (i % 2) addComponent(world, StressVel, eid);
        if (i % 7 === 0) addComponent(world, StressTag, eid);
        if (i % 1000 === 0) addComponent(world, StressName, eid, { name: `e${i}` });
      }
    });
    expect(world.entitySparseSet.dense.length).toBe(N);
    time(
      "first query",
      () => moveQuery(world).length,
      (n) => `${n.toLocaleString()} matches`,
    );
    time("stepWorld x1 (system over half the world)", () => stepWorld(world));
    time("stepWorld x5", () => {
      for (let i = 0; i < 5; i++) stepWorld(world);
    });
    const last = N - 1 - ((N - 1) % 2 === 1 ? 0 : 1); // last odd eid, which has StressVel
    expect(world(StressPos, last).x).toBe(last + 6);

    const full = time(
      "serialize binary (full)",
      () => serializeWorld(SerialMode.BINARY, world),
      (b) => mb(b.byteLength),
    );
    const copy = time("deserialize binary (new world)", () => deserializeWorld(full));
    expect(copy.size).toBe(N);
    expect(copy.entitySparseSet.dense.length).toBe(N);
    expect(copy(StressPos, last).x).toBe(last + 6);
    expect(copy(StressName, 0).name).toBe("e0");
    expect(moveQuery(copy).length).toBe(moveQuery(world).length);

    const delta = createDeltaSerializer(world);
    time(
      "delta serializer first (full) frame",
      () => delta.serialize(),
      (b) => mb(b.byteLength),
    );
    time("remove 1000 entities", () => {
      for (let i = 0; i < 1000; i++) removeEntity(world, i * 3);
    });
    stepWorld(world);
    const frame = time(
      "delta frame after a step",
      () => delta.serialize(),
      (b) => mb(b.byteLength),
    );
    time("apply delta", () => applyDelta(frame, copy));
    expect(copy.entitySparseSet.dense.length).toBe(N - 1000);
    expect(copy(StressPos, last).x).toBe(world(StressPos, last).x);

    const out = [
      "=".repeat(80),
      `  minECS stress (${N.toLocaleString()} entities)`,
      `  Date: ${new Date().toISOString()}`,
      "=".repeat(80),
      ...lines,
      "",
    ].join("\n");
    fs.writeFileSync(path.resolve(__dirname, "../benchmark_stress.txt"), out, "utf-8");
  });
});

import { describe, test, expect } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import {
  createWorld,
  addEntity,
  entityExists,
  addComponent,
  hasComponent,
  removeComponent,
  removeEntity,
  stepWorld,
} from "../src/World";
import { Schema } from "../src/Schema";
import { defineQuery } from "../src/Query";
import { serializeWorld } from "../src/Serialize";
import { deserializeWorld } from "../src/Deserialize";
import { SystemImpl, System } from "../src/System";
import { SerialMode } from "../src/Types";
import type { World } from "../src/Types";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// Component Definitions
// ============================================================

@Component()
class BenchPosition extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(0)
  y: number;
}

@Component()
class BenchVelocity extends Schema {
  @type("number")
  @defaultValue(0)
  vx: number;

  @type("number")
  @defaultValue(0)
  vy: number;
}

@Component()
class BenchHealth extends Schema {
  @type("number")
  @defaultValue(100)
  hp: number;

  @type("number")
  @defaultValue(100)
  maxHp: number;
}

@Component()
class BenchTag extends Schema {}

@Component()
class BenchData extends Schema {
  @type("string")
  @defaultValue("")
  name: string;

  @type("number")
  @defaultValue(0)
  score: number;

  @type("boolean")
  @defaultValue(false)
  active: boolean;
}

// ============================================================
// System Definitions
// ============================================================

@System(BenchPosition, BenchVelocity)
class BenchMovementSystem extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(BenchPosition, eid).x += world(BenchVelocity, eid).vx;
    world(BenchPosition, eid).y += world(BenchVelocity, eid).vy;
  };
}

@System(BenchHealth)
class BenchHealthSystem extends SystemImpl {
  static depth = 1;
  run = (world: World, eid: number) => {
    const hp = world(BenchHealth, eid).hp;
    if (hp < world(BenchHealth, eid).maxHp) {
      world(BenchHealth, eid).hp = hp + 1;
    }
  };
}

// ============================================================
// Benchmark Utilities
// ============================================================

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
  details?: string;
}

const results: BenchmarkResult[] = [];

function bench(name: string, iterations: number, fn: () => void, details?: string): BenchmarkResult {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 100); i++) {
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
    details,
  };

  results.push(result);
  return result;
}

function benchOnce(name: string, fn: () => void, details?: string): BenchmarkResult {
  // no warmup for single-run benchmarks
  const start = performance.now();
  fn();
  const end = performance.now();

  const totalMs = end - start;

  const result: BenchmarkResult = {
    name,
    iterations: 1,
    totalMs: Math.round(totalMs * 1000) / 1000,
    avgMs: Math.round(totalMs * 1000) / 1000,
    opsPerSec: Math.round((1 / totalMs) * 1000),
    details,
  };

  results.push(result);
  return result;
}

function formatResults(resultsList: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("=".repeat(90));
  lines.push("  minECS Performance Benchmark Results");
  lines.push("  Date: " + new Date().toISOString());
  lines.push("=".repeat(90));
  lines.push("");

  let currentCategory = "";

  for (const r of resultsList) {
    const category = r.name.split(":")[0]?.trim() || "";
    if (category !== currentCategory) {
      currentCategory = category;
      lines.push("-".repeat(90));
      lines.push(`  ${currentCategory}`);
      lines.push("-".repeat(90));
    }

    const nameStr = r.name.padEnd(50);
    const totalStr = `${r.totalMs.toFixed(3)}ms`.padStart(12);
    const avgStr = `${r.avgMs.toFixed(4)}ms/op`.padStart(16);
    const opsStr = `${r.opsPerSec.toLocaleString()} ops/s`.padStart(18);
    lines.push(`  ${nameStr}${totalStr}${avgStr}${opsStr}`);
    if (r.details) {
      lines.push(`    -> ${r.details}`);
    }
  }

  lines.push("");
  lines.push("=".repeat(90));
  lines.push(`  Total benchmarks: ${resultsList.length}`);
  lines.push("=".repeat(90));

  return lines.join("\n");
}

// ============================================================
// Benchmarks
// ============================================================

describe("Performance Benchmarks", () => {

  // ----------------------------------------------------------
  // 1. Entity Creation
  // ----------------------------------------------------------
  describe("Entity Creation", () => {
    test("Entity: Create 10,000 entities", () => {
      benchOnce("Entity: Create 10,000 entities", () => {
        const world = createWorld(20000);
        for (let i = 0; i < 10000; i++) {
          addEntity(world);
        }
      }, "Measures raw addEntity throughput");
    });

    test("Entity: Create 50,000 entities", () => {
      benchOnce("Entity: Create 50,000 entities", () => {
        const world = createWorld(60000);
        for (let i = 0; i < 50000; i++) {
          addEntity(world);
        }
      }, "Stress test entity creation at scale");
    });
  });

  // ----------------------------------------------------------
  // 2. Entity Removal
  // ----------------------------------------------------------
  describe("Entity Removal", () => {
    test("Entity: Remove 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        eids.push(addEntity(world));
      }

      benchOnce("Entity: Remove 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          removeEntity(world, eids[i]);
        }
      }, "Measures removeEntity throughput");
    });

    test("Entity: Remove 10,000 entities with components", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
        eids.push(eid);
      }

      benchOnce("Entity: Remove 10,000 entities w/ components", () => {
        for (let i = 0; i < eids.length; i++) {
          removeEntity(world, eids[i]);
        }
      }, "Entities have 2 components each");
    });
  });

  // ----------------------------------------------------------
  // 3. Entity Recycling
  // ----------------------------------------------------------
  describe("Entity Recycling", () => {
    test("Entity: Recycle 5,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        eids.push(addEntity(world));
      }
      // Remove first half to fill the removed pool
      for (let i = 0; i < 5000; i++) {
        removeEntity(world, eids[i]);
      }

      benchOnce("Entity: Recycle 5,000 entities", () => {
        for (let i = 0; i < 5000; i++) {
          addEntity(world);
        }
      }, "Re-use entity IDs from removed pool");
    });
  });

  // ----------------------------------------------------------
  // 4. Component Operations
  // ----------------------------------------------------------
  describe("Component Operations", () => {
    test("Component: Add to 10,000 entities (1 component)", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        eids.push(addEntity(world));
      }

      benchOnce("Component: Add 1 comp to 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          addComponent(world, BenchPosition, eids[i], { x: i, y: i });
        }
      }, "Single component addComponent with overrides");
    });

    test("Component: Add to 10,000 entities (3 components)", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        eids.push(addEntity(world));
      }

      benchOnce("Component: Add 3 comps to 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          addComponent(world, BenchPosition, eids[i], { x: i, y: i });
          addComponent(world, BenchVelocity, eids[i], { vx: 1, vy: -1 });
          addComponent(world, BenchHealth, eids[i], { hp: 50 });
        }
      }, "3 components per entity with overrides");
    });

    test("Component: Remove from 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
        eids.push(eid);
      }

      benchOnce("Component: Remove 1 comp from 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          removeComponent(world, BenchPosition, eids[i]);
        }
      }, "Remove Position from entities that also have Velocity");
    });
  });

  // ----------------------------------------------------------
  // 5. Component Data Access (Proxy)
  // ----------------------------------------------------------
  describe("Component Data Access", () => {
    test("Proxy: Read 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        eids.push(eid);
      }

      let sum = 0;
      benchOnce("Proxy: Read 10,000 entities (x + y)", () => {
        for (let i = 0; i < eids.length; i++) {
          sum += world(BenchPosition, eids[i]).x;
          sum += world(BenchPosition, eids[i]).y;
        }
      }, "Read 2 properties per entity via proxy");
      expect(sum).toBeGreaterThan(0);
    });

    test("Proxy: Write 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        eids.push(eid);
      }

      benchOnce("Proxy: Write 10,000 entities (x, y)", () => {
        for (let i = 0; i < eids.length; i++) {
          world(BenchPosition, eids[i]).x = i * 3;
          world(BenchPosition, eids[i]).y = i * 4;
        }
      }, "Write 2 properties per entity via proxy");
    });

    test("Proxy: Repeated access 100 iterations x 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
        eids.push(eid);
      }

      let sum = 0;
      bench("Proxy: Read+Write 10k ents (per iter)", 100, () => {
        for (let i = 0; i < eids.length; i++) {
          const pos = world(BenchPosition, eids[i]);
          const vel = world(BenchVelocity, eids[i]);
          pos.x += vel.vx;
          pos.y += vel.vy;
          sum += pos.x;
        }
      }, "Simulates a simple movement update");
      expect(sum).not.toBe(0);
    });
  });

  // ----------------------------------------------------------
  // 6. Query Operations
  // ----------------------------------------------------------
  describe("Query Operations", () => {
    test("Query: Define and populate with 10,000 entities", () => {
      const world = createWorld(20000);
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
      }

      const posVelQuery = defineQuery([BenchPosition, BenchVelocity]);

      benchOnce("Query: Initial query 10,000 matching ents", () => {
        const ents = posVelQuery(world);
        expect(ents.length).toBe(10000);
      }, "First call creates and populates query");
    });

    test("Query: Iterate 10,000 entities 100 times", () => {
      const world = createWorld(20000);
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
      }

      const posVelQuery = defineQuery([BenchPosition, BenchVelocity]);
      posVelQuery(world); // initial populate

      let count = 0;
      bench("Query: Iterate 10k ents (per iter)", 100, () => {
        const ents = posVelQuery(world);
        for (let i = 0; i < ents.length; i++) {
          count++;
        }
      }, "Repeated iteration of a cached query");
      expect(count).toBe(10000 * (100 + 100)); // warmup + benchmark
    });

    test("Query: has() check 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        if (i % 2 === 0) addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
        eids.push(eid);
      }

      const posVelQuery = defineQuery([BenchPosition, BenchVelocity]);
      posVelQuery(world);

      let matches = 0;
      benchOnce("Query: has() check on 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          if (posVelQuery.has(world, eids[i])) matches++;
        }
      }, "Check membership for half-matching set");
      expect(matches).toBe(5000);
    });

    test("Query: hasComponent check 10,000 entities", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        eids.push(eid);
      }

      let matches = 0;
      benchOnce("Query: hasComponent check 10,000 entities", () => {
        for (let i = 0; i < eids.length; i++) {
          if (hasComponent(world, BenchPosition, eids[i])) matches++;
        }
      }, "Bitflag-based component check");
      expect(matches).toBe(10000);
    });
  });

  // ----------------------------------------------------------
  // 7. System Stepping
  // ----------------------------------------------------------
  describe("System Stepping", () => {
    test("System: stepWorld with 10,000 entities (2 systems)", () => {
      const world = createWorld(20000);
      for (let i = 0; i < 10000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: 0, y: 0 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 2 });
        addComponent(world, BenchHealth, eid, { hp: 50, maxHp: 100 });
      }

      bench("System: stepWorld 10k ents, 2 systems", 100, () => {
        stepWorld(world);
      }, "Movement + Health systems");
    });

    test("System: stepWorld with 1,000 entities (2 systems)", () => {
      const world = createWorld(5000);
      for (let i = 0; i < 1000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: 0, y: 0 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 2 });
        addComponent(world, BenchHealth, eid, { hp: 50, maxHp: 100 });
      }

      bench("System: stepWorld 1k ents, 2 systems", 1000, () => {
        stepWorld(world);
      }, "Smaller world for per-frame cost");
    });
  });

  // ----------------------------------------------------------
  // 8. Serialization
  // ----------------------------------------------------------
  describe("Serialization", () => {
    test("Serialize: JSON 1,000 entities", () => {
      const world = createWorld(5000);
      for (let i = 0; i < 1000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
      }

      bench("Serialize: JSON 1,000 entities", 10, () => {
        serializeWorld(SerialMode.JSON, world);
      }, "Full world JSON serialization");
    });

    test("Serialize: Binary 1,000 entities", () => {
      const world = createWorld(5000);
      for (let i = 0; i < 1000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
      }

      bench("Serialize: Binary 1,000 entities", 10, () => {
        serializeWorld(SerialMode.BINARY, world);
      }, "Full world binary serialization");
    });

    test("Serialize: Binary 5,000 entities", () => {
      const world = createWorld(10000);
      for (let i = 0; i < 5000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
      }

      benchOnce("Serialize: Binary 5,000 entities", () => {
        serializeWorld(SerialMode.BINARY, world);
      }, "Larger binary serialization");
    });
  });

  // ----------------------------------------------------------
  // 9. Deserialization
  // ----------------------------------------------------------
  describe("Deserialization", () => {
    test("Deserialize: Binary 1,000 entities", () => {
      const world = createWorld(5000);
      for (let i = 0; i < 1000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i * 2 });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
      }
      const buffer = serializeWorld(SerialMode.BINARY, world);

      bench("Deserialize: Binary 1,000 entities", 10, () => {
        const newWorld = createWorld(5000);
        deserializeWorld(buffer, newWorld);
      }, "Full world binary deserialization");
    });
  });

  // ----------------------------------------------------------
  // 10. Mixed Workload (Realistic Game Loop)
  // ----------------------------------------------------------
  describe("Mixed Workload", () => {
    test("Mixed: 100 frames with spawn/despawn/step", () => {
      const world = createWorld(20000);
      // Pre-populate
      for (let i = 0; i < 5000; i++) {
        const eid = addEntity(world);
        addComponent(world, BenchPosition, eid, { x: i, y: i });
        addComponent(world, BenchVelocity, eid, { vx: 1, vy: 1 });
        addComponent(world, BenchHealth, eid, { hp: 100, maxHp: 100 });
      }

      let spawned: number[] = [];

      benchOnce("Mixed: 100 frames (spawn/despawn/step)", () => {
        for (let frame = 0; frame < 100; frame++) {
          // Spawn 50 new entities per frame
          for (let j = 0; j < 50; j++) {
            const eid = addEntity(world);
            addComponent(world, BenchPosition, eid, { x: frame, y: j });
            addComponent(world, BenchVelocity, eid, { vx: 1, vy: -1 });
            spawned.push(eid);
          }

          // Remove 30 old entities per frame
          for (let j = 0; j < 30 && spawned.length > 0; j++) {
            const eid = spawned.shift()!;
            removeEntity(world, eid);
          }

          // Step systems
          stepWorld(world);
        }
      }, "5000 initial + 50 spawns - 30 removals per frame");
    });
  });

  // ----------------------------------------------------------
  // 11. SparseSet Micro-benchmarks
  // ----------------------------------------------------------
  describe("SparseSet Operations", () => {
    test("SparseSet: entityExists 10,000 checks", () => {
      const world = createWorld(20000);
      const eids: number[] = [];
      for (let i = 0; i < 10000; i++) {
        eids.push(addEntity(world));
      }

      let count = 0;
      bench("SparseSet: entityExists 10k checks", 100, () => {
        for (let i = 0; i < eids.length; i++) {
          if (entityExists(world, eids[i])) count++;
        }
      }, "SparseSet.has() via entityExists");
      expect(count).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------
  // 12. World Creation
  // ----------------------------------------------------------
  describe("World Creation", () => {
    test("World: createWorld (default size)", () => {
      bench("World: createWorld (default size)", 100, () => {
        createWorld();
      }, "World initialization with default 1000 entities");
    });

    test("World: createWorld (size=50000)", () => {
      bench("World: createWorld (size=50000)", 10, () => {
        createWorld(50000);
      }, "World initialization with 50k entity capacity");
    });
  });

  // ----------------------------------------------------------
  // Write results to file
  // ----------------------------------------------------------
  test("Write results to output file", () => {
    const outputFile = process.env.BENCH_OUTPUT || "benchmark_results.txt";
    const outputPath = path.resolve(__dirname, "..", outputFile);
    const formatted = formatResults(results);
    fs.writeFileSync(outputPath, formatted, "utf-8");
    console.log(`\nBenchmark results written to: ${outputPath}`);
    console.log(formatted);
  });
});

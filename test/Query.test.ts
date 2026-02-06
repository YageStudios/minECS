import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import {
  createWorld,
  addEntity,
  addComponent,
  removeComponent,
  removeEntity,
} from "../src/World";
import { defineQuery } from "../src/Query";

@Component()
class QA extends Schema {}

@Component()
class QB extends Schema {}

@Component()
class QC extends Schema {}

@Component()
class QData extends Schema {
  @type("number")
  @defaultValue(0)
  n: number;
}

describe("defineQuery", () => {
  test("returns cached instance for same components", () => {
    const q1 = defineQuery([QA, QB]);
    const q2 = defineQuery([QA, QB]);
    expect(q1).toBe(q2);
  });

  test("component order does not matter", () => {
    const q1 = defineQuery([QA, QB]);
    const q2 = defineQuery([QB, QA]);
    expect(q1).toBe(q2);
  });
});

describe("query filtering", () => {
  test("only returns entities matching all components", () => {
    const world = createWorld();
    const e1 = addEntity(world);
    const e2 = addEntity(world);
    const e3 = addEntity(world);

    addComponent(world, QA, e1);
    addComponent(world, QB, e1);

    addComponent(world, QA, e2);
    addComponent(world, QB, e2);
    addComponent(world, QC, e2);

    addComponent(world, QA, e3); // missing QB

    const q = defineQuery([QA, QB]);
    const ents = q(world);

    expect(ents).toContain(e1);
    expect(ents).toContain(e2);
    expect(ents).not.toContain(e3);
  });

  test("query updates when component is removed", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, QA, eid);
    addComponent(world, QB, eid);

    const q = defineQuery([QA, QB]);
    expect(q(world)).toContain(eid);

    removeComponent(world, QB, eid);
    expect(q(world)).not.toContain(eid);
  });

  test("query updates when entity is removed", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, QA, eid);

    const q = defineQuery([QA]);
    expect(q(world)).toContain(eid);

    removeEntity(world, eid);
    expect(q(world)).not.toContain(eid);
  });
});

describe("query.has", () => {
  test("returns true for matching entity", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, QA, eid);

    const q = defineQuery([QA]);
    q(world); // initialize
    expect(q.has(world, eid)).toBe(true);
  });

  test("returns false for non-matching entity", () => {
    const world = createWorld();
    const eid = addEntity(world);

    const q = defineQuery([QA]);
    q(world);
    expect(q.has(world, eid)).toBe(false);
  });

  test("returns false for uninitialized query", () => {
    const world = createWorld();
    const q = defineQuery([QA, QB, QC]);
    // Don't call q(world), so query not created for this world
    expect(q.has(world, 0)).toBe(false);
  });
});

describe("query populates existing entities", () => {
  test("entities added before query definition are included", () => {
    const world = createWorld();
    const eid = addEntity(world);
    addComponent(world, QData, eid, { n: 5 });

    // Define query after entity exists
    const q = defineQuery([QData]);
    const ents = q(world);
    expect(ents).toContain(eid);
  });
});

describe("multiple queries on overlapping components", () => {
  test("adding component updates all matching queries", () => {
    const world = createWorld();
    const qA = defineQuery([QA]);
    const qAB = defineQuery([QA, QB]);
    const qABC = defineQuery([QA, QB, QC]);

    const eid = addEntity(world);
    addComponent(world, QA, eid);
    addComponent(world, QB, eid);

    expect(qA(world)).toContain(eid);
    expect(qAB(world)).toContain(eid);
    expect(qABC(world)).not.toContain(eid);

    addComponent(world, QC, eid);
    expect(qABC(world)).toContain(eid);

    removeComponent(world, QB, eid);
    expect(qA(world)).toContain(eid);
    expect(qAB(world)).not.toContain(eid);
    expect(qABC(world)).not.toContain(eid);
  });
});

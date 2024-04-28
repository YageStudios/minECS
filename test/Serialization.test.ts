import { expect, test } from "vitest";
import { Component, defaultValue, nullable, type } from "../src/Decorators";
import type { World } from "../src/Types";
import { SerialMode } from "../src/Types";
import { System, SystemImpl, run } from "../src/System";
import { Schema } from "../src/Schema";
import { deserializeWorld } from "../src/Deserialize";
import { serializeWorld } from "../src/Serialize";
import { createWorld, addEntity, addComponent } from "../src/World";

@Component()
class Position extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(30)
  y: number;
}

@Component()
class Complex extends Schema {
  @type(Position)
  position: Position;

  @type("string")
  @defaultValue("hello")
  message: string;

  @type(["number"])
  numbers: number[];

  @type("boolean")
  @defaultValue(true)
  flag: boolean;

  @type("object")
  obj: any;

  @type("string")
  @nullable()
  nullableString: string | null;
}

@Component()
class NestedComplex extends Schema {
  @type(Complex)
  complex: Complex;

  @type([Complex])
  complexes: Complex[];
}

const worldTestState = [
  [
    Position,
    {
      x: 5,
      y: 30,
    },
    Complex,
    {
      position: {
        x: 35,
        y: 530,
      },
      message: "helloa",
      numbers: [1, 2, 3, 4],
      flag: false,
      obj: { a: 3 },
      nullableString: null,
    },
    NestedComplex,
    {
      complex: {
        position: {
          x: 5,
          y: 30,
        },
        message: "hello",
        numbers: [1, 2, 3],
        flag: true,
        obj: { a: 1 },
        nullableString: null,
      },
      complexes: [
        {
          position: {
            x: 5,
            y: 30,
          },
          message: "hello",
          numbers: [1, 2, 3],
          flag: true,
          obj: { a: 1 },
          nullableString: null,
        },
        {
          position: {
            x: 5,
            y: 30,
          },
          message: "hello",
          numbers: [1, 2, 3],
          flag: true,
          obj: { a: 1 },
          nullableString: null,
        },
      ],
    },
  ],
];

const createTestWorld = () => {
  const world = createWorld();
  worldTestState.forEach((componentStates) => {
    const entity = addEntity(world);
    for (let i = 0; i < componentStates.length; i += 2) {
      const component = componentStates[i] as typeof Schema;
      const state = componentStates[i + 1] as any;
      addComponent(world, component, entity, state);
    }
  });
  return world;
};

const compareToTestState = (world: World) => {
  worldTestState.forEach((componentStates, entityId) => {
    const entity = entityId;
    for (let i = 0; i < componentStates.length; i += 2) {
      const component = componentStates[i] as typeof Schema;
      const state = componentStates[i + 1] as any;
      expect({ ...world(component, entity) }).toEqual({ ...state, type: component.name });
    }
  });
};

test("testWorld works", () => {
  const world = createTestWorld();
  compareToTestState(world);
});

test("JSON serialization runs", () => {
  const world = createTestWorld();
  const json = serializeWorld(SerialMode.JSON, world);

  const cloneWorld = createWorld();
  deserializeWorld(json, cloneWorld);
  compareToTestState(cloneWorld);
});

test("Buffer runs", () => {
  const world = createTestWorld();
  const buffer = serializeWorld(SerialMode.BINARY, world);

  const cloneWorld = createWorld();
  deserializeWorld(buffer, cloneWorld);

  compareToTestState(cloneWorld);
});

test("deserializeFromBuffer returns identical states to deserializeFromJSON", () => {
  const world = createTestWorld();
  const buffer = serializeWorld(SerialMode.BINARY, world);
  const json = serializeWorld(SerialMode.JSON, world);

  const cloneWorld = createWorld();
  deserializeWorld(buffer, cloneWorld);
  const cloneWorldJson = serializeWorld(SerialMode.JSON, cloneWorld);

  expect(cloneWorldJson).toEqual(json);
  compareToTestState(cloneWorld);
});

@Component()
class TestComponent extends Schema {
  @type("number")
  @defaultValue(5)
  x: number;
}

@System(TestComponent)
class TestSystem extends SystemImpl {
  init = (world: World, eid: number) => {
    world(TestComponent, eid).x += 1;
  };
  run = (world: World, eid: number) => {
    world(TestComponent, eid).x += 1;
  };
}

const runSystemTest = (serialization: SerialMode.BINARY | SerialMode.JSON) => () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, TestComponent, entity);

  run(world);
  const snapshot = serializeWorld(serialization as any, world);

  const cloneWorld = createWorld();
  deserializeWorld(snapshot, cloneWorld);

  const nextEntity = addEntity(cloneWorld);
  addComponent(cloneWorld, TestComponent, nextEntity);

  expect(cloneWorld(TestComponent, entity).x).toEqual(7);
  expect(cloneWorld(TestComponent, nextEntity).x).toEqual(6);
  run(cloneWorld);
  expect(cloneWorld(TestComponent, entity).x).toEqual(8);
  expect(cloneWorld(TestComponent, nextEntity).x).toEqual(7);
};

test("run system maintained for buffer", runSystemTest(SerialMode.BINARY));

test("run system maintained for JSON", runSystemTest(SerialMode.JSON));

test("base64 serialization runs", () => {
  const world = createTestWorld();

  const base64 = serializeWorld(SerialMode.BASE64, world);

  const cloneWorld = deserializeWorld(base64);
  compareToTestState(cloneWorld);
});

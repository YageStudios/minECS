import { expect, test } from "vitest";
import { SystemImpl, System, run } from "../src/System";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import type { World } from "../src/Types";
import { createWorld, addEntity, addComponent, getSystem } from "../src/World";

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
class Velocity extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(0)
  y: number;
}

@Component()
class Listing extends Schema {}

@System(Position, Listing)
export class PositionSystem extends SystemImpl {
  depth = 0;
  run = (world: World, eid: number) => {
    world(Position, eid).x += 1;
  };
}

@System(Listing)
export class ListingSystem extends SystemImpl {
  depth = 0;
  run = (world: World, eid: number) => {
    world(Position, eid).y += 1;
  };
}

@System(Position, Velocity)
export class VelocitySystem extends SystemImpl {
  depth = 1;
  run = (world: World, eid: number) => {
    world(Position, eid).x += world(Velocity, eid).x;
    world(Position, eid).y += world(Velocity, eid).y;
  };
}

test("defineSystem", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Position, entity, { x: 10, y: 20 });
  addComponent(world, Listing, entity);

  const movingEntity = addEntity(world);
  addComponent(world, Position, movingEntity, { x: 10, y: 20 });
  addComponent(world, Velocity, movingEntity, { x: 1, y: 2 });

  run(world);
  expect(world(Position, entity).x).toEqual(11);
  expect(world(Position, entity).y).toEqual(21);
  expect(world(Position, movingEntity).x).toEqual(11);
  expect(world(Position, movingEntity).y).toEqual(22);
  run(world);
  expect(world(Position, entity).x).toEqual(12);
  expect(world(Position, entity).y).toEqual(22);
  expect(world(Position, movingEntity).x).toEqual(12);
  expect(world(Position, movingEntity).y).toEqual(24);
});

@Component()
class Late extends Schema {}

@Component()
class Early extends Schema {}

@Component()
class Order extends Schema {
  @type(["number"])
  @defaultValue([])
  order: number[];
}

@System(Order)
class OrderSystem extends SystemImpl {
  static depth = 1;
  init = (world: World, eid: number) => {
    world(Order, eid).order = [0];
  };
}

@System(Late, Order)
export class LateSystem extends SystemImpl {
  static depth = 2;
  run = (world: World, eid: number) => {
    world(Order, eid).order.push(3);
  };
}

@System(Early, Order)
export class EarlySystem extends SystemImpl {
  static depth = 0;
  run = (world: World, eid: number) => {
    world(Order, eid).order.push(1);
  };
}

test("defineSystem order", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Order, entity);
  addComponent(world, Early, entity);
  addComponent(world, Late, entity);

  run(world);
  expect(world(Order, entity).order).toEqual([0, 1, 3]);
  run(world);
  expect(world(Order, entity).order).toEqual([0, 1, 3, 1, 3]);
});

@Component()
class Manual extends Schema {
  @type("boolean")
  @defaultValue(false)
  bool: boolean;
}

@System(Manual)
export class ManualSystem extends SystemImpl {
  static depth = -1;
  run = (world: World, eid: number) => {
    world(Manual, eid).bool = !world(Manual, eid).bool;
  };
}

test("manual run", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Manual, entity);

  run(world);
  expect(world(Manual, entity).bool).toEqual(false);
  getSystem(world, ManualSystem).runAll(world);
  expect(world(Manual, entity).bool).toEqual(true);
  getSystem(world, ManualSystem).run?.(world, entity);
  expect(world(Manual, entity).bool).toEqual(false);
});

@Component()
class InitOrder extends Schema {
  @type(["number"])
  @defaultValue([])
  order: number[];
}

@Component()
class InitOrderA extends Schema {}

@Component()
class InitOrderZ extends Schema {}

@Component()
class InitOrder3 extends Schema {}

@System(InitOrder, InitOrderZ, InitOrder3)
class InitOrder3System extends SystemImpl {
  init = (world: World, eid: number) => {
    world(InitOrder, eid).order.push(3);
  };
}

@System(InitOrder, InitOrderA)
class InitOrderASystem extends SystemImpl {
  init = (world: World, eid: number) => {
    world(InitOrder, eid).order.push(-1);
  };
}

@System(InitOrder, InitOrderZ)
class InitOrder2System extends SystemImpl {
  init = (world: World, eid: number) => {
    world(InitOrder, eid).order.push(2);
  };
}

@System(InitOrder)
class InitOrderSystem extends SystemImpl {
  init = (world: World, eid: number) => {
    world(InitOrder, eid).order.push(1);
  };
}

test("init order", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, InitOrder3, entity);
  addComponent(world, InitOrderZ, entity);
  addComponent(world, InitOrderA, entity);
  addComponent(world, InitOrder, entity);

  run(world);
  expect(world(InitOrder, entity).order).toEqual([1, -1, 2, 3]);
});

import { expect, test } from "vitest";
import { Component, defaultValue, type } from "../src/Decorators";
import {
  createWorld,
  addEntity,
  entityExists,
  addComponent,
  hasComponent,
  removeComponent,
  removeEntity,
} from "../src/World";
import { Schema } from "../src/Schema";

@Component()
class Position extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(30)
  y: number;
}

test("Create a new World", () => {
  expect(createWorld()).toBeDefined();
});

test("Register Schema", () => {
  const world = createWorld();
  expect(world(Position)).toBeDefined();
});

test("Register Entity", () => {
  const world = createWorld();
  const entity = addEntity(world);
  expect(entity).toBeDefined();
  expect(entityExists(world, entity)).toBeTruthy();
});

test("Add Component", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Position, entity, { x: 5 });
  expect(hasComponent(world, Position, entity)).toBeTruthy();
  expect({ ...world(Position, entity) }).toEqual({ x: 5, y: 30, type: "Position" });
});

test("Modify Component", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Position, entity, { x: 5 });
  world(Position, entity).x = 10;
  expect({ ...world(Position, entity) }).toEqual({ x: 10, y: 30, type: "Position" });
});

test("Remove Component", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Position, entity, { x: 5 });
  removeComponent(world, Position, entity);
  expect(hasComponent(world, Position, entity)).toBeFalsy();
});

test("Throws on invalid component", () => {
  const world = createWorld();
  const entity = addEntity(world);
  // @ts-ignore - Testing invalid component
  expect(() => addComponent(world, Position, entity, { x: "blah" })).toThrow();
});

test("Remove Entity", () => {
  const world = createWorld();
  const entity = addEntity(world);
  addComponent(world, Position, entity, { x: 5 });
  removeEntity(world, entity);
  expect(entityExists(world, entity)).toBeFalsy();
  expect(hasComponent(world, Position, entity)).toBeFalsy();
});

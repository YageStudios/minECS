import { describe, expect, test } from "vitest";
import { Component, type, defaultValue } from "../src/Decorators";
import { Schema } from "../src/Schema";
import { getComponentByType, defineComponent } from "../src/Component";
import { createWorld } from "../src/World";

// Define a component so componentKeyMap is populated in this test file
@Component()
class CompTestPos extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;
}

describe("getComponentByType", () => {
  test("returns schema for registered component type", () => {
    createWorld();
    const result = getComponentByType("CompTestPos");
    expect(result).toBeDefined();
    expect(result!.type).toBe("CompTestPos");
  });

  test("returns undefined for unknown type", () => {
    const result = getComponentByType("NonExistentComponent");
    expect(result).toBeUndefined();
  });
});

describe("defineComponent after freeze", () => {
  test("throws when defining component after world creation", () => {
    createWorld(); // ensures freeze happened
    const fakeSchema = { type: "PostFreeze", createStore: () => ({}) } as any;
    expect(() => defineComponent(fakeSchema)).toThrow("Cannot define a component after the world has been created");
  });
});

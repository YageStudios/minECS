import { describe, expect, test } from "vitest";
import { StringToEnum, EnumToString, isQuery } from "../src/Types";

enum Color {
  Red = 0,
  Green = 1,
  Blue = 2,
}

describe("StringToEnum", () => {
  test("converts string key to enum value (case insensitive)", () => {
    expect(StringToEnum<Color>("red", Color)).toBe(Color.Red);
    expect(StringToEnum<Color>("GREEN", Color)).toBe(Color.Green);
  });

  test("passes numeric value through unchanged", () => {
    expect(StringToEnum<Color>(2, Color)).toBe(2);
  });

  test("returns undefined for undefined input", () => {
    expect(StringToEnum<Color>(undefined, Color)).toBeUndefined();
  });
});

describe("EnumToString", () => {
  test("converts enum value to key string", () => {
    expect(EnumToString(Color.Blue, Color)).toBe("Blue");
  });

  test("returns undefined for unknown value", () => {
    expect(EnumToString(999, Color)).toBeUndefined();
  });
});

describe("isQuery", () => {
  test("returns true for object with toRemove", () => {
    expect(isQuery({ toRemove: [] })).toBe(true);
  });

  test("returns false for plain object", () => {
    expect(isQuery({})).toBe(false);
  });
});

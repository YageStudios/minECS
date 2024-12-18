import type { Schema } from "./Schema";
import type { QueryInstance, ReadOnlyWorld, World } from "./Types";

export function System(categoryOrSchema: number | typeof Schema, ...schemas: (typeof Schema)[]) {
  return function (cls: typeof SystemImpl<any> | typeof DrawSystemImpl<any>) {
    if (typeof categoryOrSchema === "number") {
      cls.category = categoryOrSchema;
      defineSystem(schemas, cls);
    } else {
      defineSystem([categoryOrSchema, ...schemas], cls);
    }
  };
}

export class SystemImpl<T extends World = World> {
  static depth: number = 0;
  static category: number = 0;
  static queryKey: string = "";

  query: QueryInstance<T>;
  constructor(query: QueryInstance<T>) {
    this.query = query;
  }

  init?(world: T, eid: number): void;
  cleanup?(world: T, eid: number): void;
  destroy?(world: T): void;

  run?(world: T, eid: number): void;

  runAll(world: T): void {
    if (this.run) {
      const ents = this.query(world);
      for (let i = 0; i < ents.length; i++) {
        this.run(world, ents[i]);
      }
    }
  }
}

export class DrawSystemImpl<T extends ReadOnlyWorld = ReadOnlyWorld> extends SystemImpl<T> {}

const isDrawSystem = (system: typeof SystemImpl | typeof DrawSystemImpl): system is typeof DrawSystemImpl => {
  return system.prototype instanceof DrawSystemImpl;
};

const systems = new Map<string, [(typeof SystemImpl)[], (typeof Schema)[]]>();

export const systemRunList: [typeof SystemImpl, (typeof Schema)[]][] = [];
export const drawSystemRunList: [typeof DrawSystemImpl, (typeof Schema)[]][] = [];
export const systemManualList: [typeof SystemImpl, (typeof Schema)[]][] = [];

export const defineSystem = (components: (typeof Schema)[], system: typeof SystemImpl | typeof DrawSystemImpl) => {
  const key = components
    .map(({ type }) => type)
    .sort()
    .join("|");

  if (systems.has(key)) {
    const [currentSystems] = systems.get(key)!;
    systems.set(key, [[...currentSystems, system as typeof SystemImpl], components]);
  } else {
    systems.set(key, [[system as typeof SystemImpl], components]);
  }
  system.queryKey = key;

  systemRunList.length = 0;
  const sortedSystems = (
    Array.from(systems.entries())
      .map(([key, [systems, components]]) => {
        return systems.map((system) => [
          key,
          (system as typeof DrawSystemImpl | typeof SystemImpl).depth ?? 0,
          [system, components],
        ]);
      })
      .flat(1) as [string, number, [typeof SystemImpl | typeof DrawSystemImpl, (typeof Schema)[]]][]
  ).sort((a, b) => {
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return a[0].localeCompare(b[0]);
  });
  systemManualList.length = 0;
  drawSystemRunList.length = 0;
  systemRunList.length = 0;

  sortedSystems.forEach(([, depth, [system, components]]) => {
    if (depth < 0) {
      systemManualList.push([system, components]);
    } else if (isDrawSystem(system)) {
      drawSystemRunList.push([system, components]);
    } else {
      systemRunList.push([system, components]);
    }
  });
};

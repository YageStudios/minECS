# minECS: Typed State Entity Component System

Welcome to minECS, a fully serializable entity component system designed for type safety and efficient state management. Originally forked from bitECS, minECS utilizes schema classes to enhance the structure and reliability of your game's data.

## Defining Components

In minECS, components are easily defined using the `Schema` class and the `@Component` decorator. These components automatically register when you import them into your project. Here are examples of how to define components for position and velocity:

```ts
@Component()
class Position extends Schema {
  @type("number")
  @defaultValue(0)
  x: number;

  @type("number")
  @defaultValue(0)
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
```

## Systems

Systems in minECS can operate manually or within the engine. Use the `@System` decorator to specify which components a system requires. Systems are dynamically recreated for each world instance to facilitate specific interactions:

```ts
@System(Position, Velocity)
class MovementSystem extends SystemImpl {
  run = (world: World, entity: number) => {
    const position = world(Position, entity);
    const velocity = world(Velocity, entity);

    position.x += velocity.x;
    position.y += velocity.y;
  };
}
```

## Managing Worlds

Worlds manage the complete state of your game, letting you add and remove entities and components:

```ts
const world = createWorld();
const entity = addEntity(world);

addComponent(world, Position, entity);
addComponent(world, Velocity, entity, {
  x: 30,
  y: 30,
});

console.log({ ...world(Position, entity) }); // { x: 0, y: 0, type: "Position" }

run(world);

console.log({ ...world(Position, entity) }); //  { x: 30, y: 30, type: "Position" }
```

## Serialization

minECS supports multiple serialization formats: JSON, Binary, and base64. This feature allows you to save and restore game states easily:

```ts
const json = serializeWorld(SerialMode.JSON, world);
const buffer = serializeWorld(SerialMode.BINARY, world);
const base64 = serializeWorld(SerialMode.BASE64, world);

const newWorldFromJSON = deserializeWorld(json);
const newWorldFromBinary = deserializeWorld(buffer);
const newWorldFromBase64 = deserializeWorld(base64);
```

## Additional Features and Systems

In addition to the core functionalities, minECS offers a suite of advanced features to provide more control and flexibility in game development. These include system execution controls, manual and automated system runs, system initialization and cleanup, advanced component types, and detailed entity management. Explore these features to fully leverage the power of minECS in your projects.

### System Execution Control with Depth

In minECS, the `depth` property of a system determines the order and automatic execution behavior. Systems with different depth values are executed in ascending order, where lower numbers run first.

```ts
@System(...)
class SomeSystem extends SystemImpl {
  static depth = 0;  // Lower numbers run first, executed automatically
}
```

**Manual Execution Only**: If a system is assigned a depth less than `0` it will not run automatically during the standard `run` cycle. Instead, it must be run manually. This is useful for systems that require explicit control or should only execute under specific conditions:

```ts
@System(...)
class ManualOnlySystem extends SystemImpl {
  static depth = -1;  // This system will only run when manually triggered

  run = (world: World, eid: number) => {
    // Implementation details
  };
}
```

To run a system manually, you can use the `run` or `runAll` methods of the system instance, providing flexibility in how and when certain parts of your game logic are executed:

```ts
const world = createWorld();
const system = getSystem(world, ManualOnlySystem);
system.runAll(world); // Runs the system manually for all entities
system.run(world, entity); // Runs the system manually for a specific entity
```

Adding this information helps clarify the operational nuances of system execution in minECS, ensuring users understand how to leverage system depth for both automatic and manual execution scenarios.

### System Initialization

Systems can have an initialization function that runs once when a system is created for a world, or when a new entity that matches the system's criteria is added:

```ts
@System(...)
class SomeInitializationSystem extends SystemImpl {
  init = (world: World, eid: number) => {
    // Initialization code here
  };
}
```

### System Cleanup

Systems can define a cleanup function that executes when a component is removed or an entity is deleted. This helps in managing state cleanup reliably:

```ts
@System(...)
class SomeCleanupSystem extends SystemImpl {
  cleanup = (world: World, eid: number) => {
    // Cleanup code here
  };
}
```

### Advanced Component Types

Enhance your components with nested structures, nullable options, and various data types for more complex scenarios:

```ts
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
```

### Entity and Component Management

The library provides comprehensive functions to manage entities and components dynamically:

```ts
const world = createWorld();
const entity = addEntity(world);
addComponent(world, SomeComponent, entity);
removeComponent(world, SomeComponent, entity);
removeEntity(world, entity); // Cleans up all components associated with the entity
```

These functions give you full control over the entities and components in the system, ensuring that you can dynamically adjust the game world as needed.

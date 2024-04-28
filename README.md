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

## Advanced Component Types

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

Explore and contribute to minECS, a system built for developers who need a straightforward, robust solution for game state management. Start integrating minECS into your game development workflow today!

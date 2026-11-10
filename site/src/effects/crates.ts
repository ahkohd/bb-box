import Matter from "matter-js";

const { Bodies, Body, Composite, Engine, Events, Sleeping, Vertices } = Matter;

export interface Landing {
  pageX: number;
  speed: number;
}

export interface Crates {
  setActive: (active: boolean) => void;
}

interface Stage {
  width: number;
  shelfY: number;
  shelfLeft: number;
  shelfRight: number;
  floorY: number;
}

interface Crate {
  body: Matter.Body;
  element: HTMLElement;
  width: number;
  height: number;
  bashedAt: number;
  look: CrateLook;
  homeX: number;
  burning: boolean;
  rain: boolean;
}

export interface Burning {
  pageX: number;
  width: number;
  seconds: number;
}

interface Sized {
  element: HTMLElement;
  width: number;
  height: number;
  look: CrateLook;
}

type CrateSize = "small" | "medium" | "large";

interface CrateLook {
  size: CrateSize;
  label?: string;
  accent?: boolean;
}

interface Pile {
  across: number;
  rows: CrateLook[][];
}

const small = (label?: string): CrateLook => ({ size: "small", label });
const medium = (label?: string): CrateLook => ({ size: "medium", label });
const large = (label?: string): CrateLook => ({ size: "large", label });

const piles: Pile[] = [
  {
    across: 0.72,
    rows: [
      [large("linux"), medium("qemu"), large("windows"), small(), medium("mac")],
      [large("proxmox"), large("android"), small(), medium("vm")],
      [medium("ios"), { size: "medium", label: "box", accent: true }, small()],
      [large("docker"), small()],
      [medium("gpu")],
    ],
  },
  {
    across: 0.42,
    rows: [[medium("lxc"), small("msb"), large("sandbox")], [medium(), small("vm")], [small()]],
  },
  {
    across: 0.95,
    rows: [[small(), medium("tart")], [small()]],
  },
];

const stepMs = 1000 / 60;
const most = { stepsPerFrame: 4, push: 18, lift: 9, spin: 0.32 };
const gravityScale = 0.0016;
const knockOffSpeed = 0.35;
const bashCooldownMs = 180;
const settleSteps = 90;
const shelfThickness = 60;
const crateGap = 2;
const floorLabel = "floor";
const rain = {
  everyMs: 1100,
  most: 10,
  looks: [small(), medium(), large(), medium("vm"), small("vm"), medium("mac"), large("linux"), large("windows"), medium("ios"), large("android"), medium("gpu"), large("docker"), medium("lxc"), medium("qemu"), small("msb"), medium("tart"), { size: "medium", label: "box", accent: true } as CrateLook],
};
const burn = { catchMs: 700, seconds: 2.6, respawnMs: 3500, respawnRetryMs: 1000, respawnDropPx: 180, respawnMarginPx: 60, respawnScatterPx: 24 };
const landingSpeed = 2.5;
const pileGap = 12;

const category = { crate: 0x1, shelf: 0x2, ground: 0x4 };
const onTheShelf = category.crate | category.shelf | category.ground;
const knockedOff = category.crate | category.ground;

const clamp = (least: number, value: number, greatest: number) => Math.min(greatest, Math.max(least, value));

function crateElement(look: CrateLook): HTMLElement {
  const element = document.createElement("div");
  element.className = ["crate", `crate-${look.size}`, look.accent ? "crate-accent" : ""].filter(Boolean).join(" ");
  if (look.label) {
    const label = document.createElement("span");
    label.className = "crate-label";
    label.textContent = look.label;
    element.append(label);
  }
  return element;
}

function measureStage(shelf: Element, floor: Element): Stage {
  const shelfBox = shelf.getBoundingClientRect();
  const floorBox = floor.getBoundingClientRect();
  return {
    width: document.documentElement.clientWidth,
    shelfY: shelfBox.top + scrollY + shelfBox.height / 2,
    shelfLeft: shelfBox.left + scrollX,
    shelfRight: shelfBox.right + scrollX,
    floorY: floorBox.top + scrollY,
  };
}

function staticBodies(stage: Stage): Matter.Body[] {
  const still = { isStatic: true, friction: 0.8 };
  const shelfWidth = stage.shelfRight - stage.shelfLeft;
  const wallHeight = stage.floorY * 2 + 2000;
  return [
    Bodies.rectangle(stage.shelfLeft + shelfWidth / 2, stage.shelfY + shelfThickness / 2, shelfWidth, shelfThickness, { ...still, collisionFilter: { category: category.shelf } }),
    Bodies.rectangle(stage.width / 2, stage.floorY + 50, stage.width * 3, 100, { ...still, label: floorLabel, collisionFilter: { category: category.ground } }),
    Bodies.rectangle(-50, stage.floorY / 2, 100, wallHeight, { ...still, collisionFilter: { category: category.ground } }),
    Bodies.rectangle(stage.width + 50, stage.floorY / 2, 100, wallHeight, { ...still, collisionFilter: { category: category.ground } }),
  ];
}

function crateBody(x: number, y: number, width: number, height: number): Matter.Body {
  return Bodies.rectangle(x, y, width, height, {
    friction: 0.6,
    frictionAir: 0.004,
    restitution: 0.15,
    density: 0.002,
    sleepThreshold: 30,
    chamfer: { radius: 1 },
    collisionFilter: { category: category.crate, mask: onTheShelf },
  });
}

export function stackCrates(layer: HTMLElement, shelf: Element, floor: Element, active: boolean, onLanding: (landing: Landing) => void, onBurning: (burning: Burning) => void): Crates {
  const engine = Engine.create({ enableSleeping: true, gravity: { x: 0, y: 1, scale: gravityScale } });
  let generation = 0;
  Events.on(engine, "collisionStart", ({ pairs }) => {
    for (const { bodyA, bodyB } of pairs) {
      const body = bodyA.label === floorLabel ? bodyB : bodyB.label === floorLabel ? bodyA : undefined;
      if (!body) continue;
      if (body.speed >= landingSpeed) onLanding({ pageX: body.position.x, speed: body.speed });
      const crate = crates.find((one) => one.body === body);
      if (crate && !crate.burning) ignite(crate);
    }
  });

  function ignite(crate: Crate): void {
    crate.burning = true;
    const lit = generation;
    setTimeout(() => {
      if (lit !== generation || !crates.includes(crate)) return;
      crate.element.style.setProperty("--tilt", `${crate.body.angle}rad`);
      crate.element.style.setProperty("--burn-seconds", `${burn.seconds}s`);
      crate.element.classList.add("crate-burning");
      onBurning({ pageX: crate.body.position.x, width: crate.width, seconds: burn.seconds });
      setTimeout(() => burnUp(crate, lit), burn.seconds * 1000);
    }, burn.catchMs);
  }

  function burnUp(crate: Crate, lit: number): void {
    if (lit !== generation) return;
    Composite.remove(engine.world, crate.body);
    crate.element.remove();
    crates = crates.filter((one) => one !== crate);
    if (!crate.rain) setTimeout(() => respawn(crate, lit), burn.respawnMs);
  }

  function dropZoneInView(): boolean {
    const top = stage.shelfY - burn.respawnDropPx - burn.respawnMarginPx;
    const bottom = stage.shelfY + burn.respawnMarginPx;
    return bottom > scrollY && top < scrollY + innerHeight;
  }

  function respawn(burnt: Crate, lit: number): void {
    if (lit !== generation) return;
    if (dropZoneInView()) {
      setTimeout(() => respawn(burnt, lit), burn.respawnRetryMs);
      return;
    }
    const element = crateElement(burnt.look);
    layer.append(element);
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const homeX = burnt.homeX + (Math.random() - 0.5) * burn.respawnScatterPx;
    const body = crateBody(homeX, stage.shelfY - burn.respawnDropPx, width, height);
    Body.setAngle(body, (Math.random() - 0.5) * 0.6);
    const fresh: Crate = { body, element, width, height, bashedAt: 0, look: burnt.look, homeX: burnt.homeX, burning: false, rain: false };
    crates.push(fresh);
    Composite.add(engine.world, body);
    draw();
    wake();
  }
  let stage = measureStage(shelf, floor);
  let crates: Crate[] = [];
  let frame = 0;
  let previous: number | undefined;
  let owed = 0;
  let lastPointer: { x: number; y: number; time: number } | undefined;

  function stack(pile: Pile, taken: Array<[number, number]>): Crate[] {
    const looks = pile.rows.map((row) =>
      row.map((look) => {
        const element = crateElement(look);
        layer.append(element);
        return { element, width: element.offsetWidth, height: element.offsetHeight, look };
      }),
    );
    const rowWidth = (row: Sized[]) => row.reduce((sum, crate) => sum + crate.width, 0) + crateGap * (row.length - 1);
    const widest = Math.max(...looks.map(rowWidth));
    const centre = Math.min(stage.shelfLeft + (stage.shelfRight - stage.shelfLeft) * pile.across, stage.shelfRight - widest / 2 - 16);
    const span: [number, number] = [centre - widest / 2 - pileGap, centre + widest / 2 + pileGap];
    if (taken.some(([from, to]) => span[0] < to && span[1] > from)) {
      looks.flat().forEach(({ element }) => element.remove());
      return [];
    }
    taken.push(span);
    let rowBottom = stage.shelfY;
    return looks.flatMap((row) => {
      let left = centre - rowWidth(row) / 2;
      const height = Math.max(...row.map((crate) => crate.height));
      const placed = row.map(({ element, width, height, look }) => {
        const homeX = left + width / 2;
        const body = crateBody(homeX, rowBottom - height / 2, width, height);
        left += width + crateGap;
        return { body, element, width, height, bashedAt: 0, look, homeX, burning: false, rain: false };
      });
      rowBottom -= height;
      return placed;
    });
  }

  function build(): void {
    generation++;
    Composite.clear(engine.world, false);
    layer.replaceChildren();
    layer.style.height = `${stage.floorY + 2}px`;
    Composite.add(engine.world, staticBodies(stage));
    const taken: Array<[number, number]> = [];
    crates = piles.flatMap((pile) => stack(pile, taken));
    Composite.add(engine.world, crates.map((crate) => crate.body));
    for (let step = 0; step < settleSteps; step++) Engine.update(engine, stepMs);
    draw();
  }

  function draw(): void {
    for (const crate of crates) {
      const { x, y } = crate.body.position;
      crate.element.style.transform = `translate(${x - crate.element.offsetWidth / 2}px, ${y - crate.element.offsetHeight / 2}px) rotate(${crate.body.angle}rad)`;
    }
  }

  function returnStrays(): void {
    for (const crate of crates) {
      const { x, y } = crate.body.position;
      if (y < stage.floorY + 200 && x > -100 && x < stage.width + 100) continue;
      Body.setPosition(crate.body, { x: clamp(crate.width, x, stage.width - crate.width), y: stage.floorY - crate.height });
      Body.setVelocity(crate.body, { x: 0, y: 0 });
    }
  }

  function tick(now: number): void {
    frame = 0;
    owed = Math.min(owed + (previous === undefined ? stepMs : now - previous), stepMs * most.stepsPerFrame);
    previous = now;
    while (owed >= stepMs) {
      Engine.update(engine, stepMs);
      owed -= stepMs;
    }
    returnStrays();
    draw();
    if (crates.every((crate) => crate.body.isSleeping)) {
      previous = undefined;
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function wake(): void {
    if (active && !frame) frame = requestAnimationFrame(tick);
  }

  function bash(crate: Crate, at: { x: number; y: number }, perMs: { x: number; y: number }, now: number): void {
    const body = crate.body;
    const speed = Math.hypot(perMs.x, perMs.y);
    const push = { x: clamp(-most.push, perMs.x * stepMs, most.push), y: clamp(-most.push, perMs.y * stepMs, most.push) };
    crate.bashedAt = now;
    Sleeping.set(body, false);
    if (speed >= knockOffSpeed) {
      body.collisionFilter.mask = knockedOff;
      Body.setVelocity(body, { x: push.x, y: clamp(-most.lift, Math.min(push.y, 0) - 2 - speed * 1.5, -2) });
    } else {
      Body.setVelocity(body, { x: body.velocity.x + push.x * 0.5, y: body.velocity.y + Math.min(push.y, 0) * 0.5 });
    }
    const lever = { x: at.x - body.position.x, y: at.y - body.position.y };
    const twist = ((lever.x * push.y - lever.y * push.x) / (crate.width * crate.height)) * 2;
    Body.setAngularVelocity(body, clamp(-most.spin, body.angularVelocity + twist, most.spin));
    wake();
  }

  function onPointerMove(event: PointerEvent): void {
    const pointer = { x: event.pageX, y: event.pageY, time: event.timeStamp };
    const from = lastPointer;
    lastPointer = pointer;
    if (!active || !from || pointer.time - from.time > 100) return;
    const move = { x: pointer.x - from.x, y: pointer.y - from.y };
    const distance = Math.hypot(move.x, move.y);
    if (distance === 0) return;
    const elapsed = Math.max(1, pointer.time - from.time);
    const perMs = { x: move.x / elapsed, y: move.y / elapsed };
    const samples = Math.ceil(distance / 4);
    for (const crate of crates) {
      if (pointer.time - crate.bashedAt < bashCooldownMs) continue;
      for (let sample = 0; sample <= samples; sample++) {
        const at = { x: from.x + (move.x * sample) / samples, y: from.y + (move.y * sample) / samples };
        if (!Vertices.contains(crate.body.vertices, at)) continue;
        bash(crate, at, perMs, pointer.time);
        break;
      }
    }
  }

  function followLayout(): void {
    const next = measureStage(shelf, floor);
    if (Math.abs(next.width - stage.width) > 1) {
      stage = next;
      build();
      return;
    }
    const shelfShift = next.shelfY - stage.shelfY;
    const floorShift = next.floorY - stage.floorY;
    if (shelfShift === 0 && floorShift === 0) return;
    const halfway = (stage.shelfY + stage.floorY) / 2;
    for (const crate of crates) {
      const shift = crate.body.position.y > halfway ? floorShift : shelfShift;
      Body.translate(crate.body, { x: 0, y: shift });
    }
    Composite.remove(engine.world, Composite.allBodies(engine.world).filter((body) => body.isStatic));
    Composite.add(engine.world, staticBodies(next));
    stage = next;
    layer.style.height = `${stage.floorY + 2}px`;
    draw();
    for (const crate of crates) Sleeping.set(crate.body, false);
    wake();
  }

  let floorInView = false;
  let rainTimer = 0;

  function rainOne(): void {
    rainTimer = 0;
    if (!active || !floorInView) return;
    if (crates.filter((crate) => crate.rain).length < rain.most) {
      const look = rain.looks[Math.floor(Math.random() * rain.looks.length)]!;
      const element = crateElement(look);
      layer.append(element);
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const x = clamp(width, stage.width * (0.04 + Math.random() * 0.92), stage.width - width);
      const body = crateBody(x, scrollY - height, width, height);
      body.collisionFilter.mask = knockedOff;
      Body.setAngle(body, (Math.random() - 0.5) * Math.PI);
      Body.setVelocity(body, { x: (Math.random() - 0.5) * 3, y: 2 + Math.random() * 3 });
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.2);
      crates.push({ body, element, width, height, bashedAt: 0, look, homeX: x, burning: false, rain: true });
      Composite.add(engine.world, body);
      draw();
      wake();
    }
    keepRaining();
  }

  function keepRaining(): void {
    if (rainTimer || !active || !floorInView) return;
    rainTimer = window.setTimeout(rainOne, rain.everyMs * (0.6 + Math.random() * 0.8));
  }

  build();
  new IntersectionObserver(([entry]) => {
    floorInView = entry!.isIntersecting;
    keepRaining();
  }).observe(floor);
  addEventListener("pointermove", onPointerMove, { passive: true });
  new ResizeObserver(followLayout).observe(document.body);

  return {
    setActive(next: boolean) {
      active = next;
      layer.hidden = !active;
      if (!active && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        previous = undefined;
      }
      wake();
      keepRaining();
    },
  };
}

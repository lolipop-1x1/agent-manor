import * as THREE from "three";
import { getAgentTeaPose, getTeaMotion, teaCupPosition, TEA_CYCLE_DURATION, TEA_LAYOUT } from "./tea-motion";

type GeometryKind = "box" | "cylinder" | "joint" | "ring" | "cup";
type Palette = "ivory" | "porcelain" | "navy" | "screen" | "eye" | "blue" | "silver" | "gold" | "wood" | "woodLight" | "woodDark" | "orange" | "sage" | "linen" | "tea" | "leaf" | "steam";

const up = new THREE.Vector3(0, 1, 0);

// 可动零件只保留变换节点，同材质与几何合为实例批次。
function createParts(root: THREE.Group) {
  const colors: Record<Palette, number> = {
    ivory: 0xeee9dd, porcelain: 0xfffcf1, navy: 0x243b54, screen: 0x112531,
    eye: 0x72d2ff, blue: 0x397bd0, silver: 0x7d8b91, gold: 0xc9a163,
    wood: 0xa67342, woodLight: 0xbd8b55, woodDark: 0x724d32, orange: 0xcf8457,
    sage: 0x829b85, linen: 0xd8caa8, tea: 0x9a6329, leaf: 0x6d8c66, steam: 0xf7f4e8,
  };
  const materials = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, new THREE.MeshStandardMaterial({
    color,
    roughness: name === "silver" || name === "gold" ? .42 : .78,
    metalness: name === "silver" || name === "gold" ? .4 : .02,
    ...(name === "eye" ? { emissive: color, emissiveIntensity: .45 } : {}),
    ...(name === "steam" ? { transparent: true, opacity: .18, depthWrite: false } : {}),
  })])) as Record<Palette, THREE.MeshStandardMaterial>;
  const geometries: Record<GeometryKind, THREE.BufferGeometry> = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    joint: new THREE.SphereGeometry(1, 8, 6),
    ring: new THREE.TorusGeometry(1, .17, 6, 12),
    cup: new THREE.LatheGeometry([
      new THREE.Vector2(0, 0), new THREE.Vector2(.092, 0), new THREE.Vector2(.129, .14),
      new THREE.Vector2(.11, .14), new THREE.Vector2(.079, .026), new THREE.Vector2(0, .026),
    ], 12),
  };
  const buckets = new Map<string, { geometry: GeometryKind; color: Palette; nodes: THREE.Object3D[]; mesh?: THREE.InstancedMesh }>();
  const matrix = new THREE.Matrix4();
  const inverse = new THREE.Matrix4();
  function part(parent: THREE.Object3D, kind: GeometryKind, color: Palette, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const node = new THREE.Object3D();
    node.position.set(x, y, z);
    node.scale.set(sx, sy, sz);
    parent.add(node);
    const key = `${kind}:${color}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { geometry: kind, color, nodes: [] }; buckets.set(key, bucket); }
    bucket.nodes.push(node);
    return node;
  }
  return {
    part,
    compile() {
      for (const bucket of buckets.values()) {
        const mesh = new THREE.InstancedMesh(geometries[bucket.geometry], materials[bucket.color], bucket.nodes.length);
        mesh.name = `tea-${bucket.geometry}-${bucket.color}`;
        mesh.castShadow = bucket.color !== "steam" && bucket.color !== "eye";
        mesh.receiveShadow = bucket.color !== "steam";
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        root.add(mesh);
        bucket.mesh = mesh;
      }
    },
    update() {
      root.updateWorldMatrix(true, true);
      inverse.copy(root.matrixWorld).invert();
      for (const bucket of buckets.values()) {
        if (!bucket.mesh) continue;
        bucket.nodes.forEach((node, index) => bucket.mesh!.setMatrixAt(index, matrix.multiplyMatrices(inverse, node.matrixWorld)));
        bucket.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

type Parts = ReturnType<typeof createParts>;

function addGroup(parent: THREE.Object3D, name: string, x = 0, y = 0, z = 0) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

function segment(node: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, width: number, depth = width) {
  node.position.copy(from).add(to).multiplyScalar(.5);
  node.scale.set(width, from.distanceTo(to), depth);
  node.quaternion.setFromUnitVectors(up, new THREE.Vector3().subVectors(to, from).normalize());
}

function createLimb(parts: Parts, parent: THREE.Object3D, start: THREE.Vector3, color: Palette, upperLength: number, lowerLength: number, bend: THREE.Vector3, width = .17) {
  const upper = parts.part(parent, "box", color, 0, 0, 0, width, upperLength, width);
  const lower = parts.part(parent, "box", "ivory", 0, 0, 0, width * .85, lowerLength, width * .85);
  parts.part(parent, "joint", "silver", start.x, start.y, start.z, width * .67, width * .67, width * .67);
  const elbow = parts.part(parent, "joint", "silver", 0, 0, 0, width * .61, width * .61, width * .61);
  const wrist = parts.part(parent, "joint", "silver", 0, 0, 0, width * .52, width * .52, width * .52);
  const end = addGroup(parent, "mechanical-hand");
  parts.part(end, "box", "ivory", 0, 0, .025, width * .9, width * .8, width);
  parts.part(end, "box", "silver", -width * .32, -.015, .10, width * .2, width * .55, width * .5);
  parts.part(end, "box", "silver", width * .32, -.015, .10, width * .2, width * .55, width * .5);
  const direction = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const joint = new THREE.Vector3();
  const target = new THREE.Vector3();
  return {
    end,
    pose(destination: THREE.Vector3) {
      direction.subVectors(destination, start);
      const length = Math.max(.0001, direction.length());
      const distance = Math.min(length, upperLength + lowerLength - .001);
      direction.divideScalar(length);
      target.copy(start).addScaledVector(direction, distance);
      normal.copy(bend).addScaledVector(direction, -bend.dot(direction)).normalize();
      const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
      const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
      joint.copy(start).addScaledVector(direction, along).addScaledVector(normal, height);
      segment(upper, start, joint, width, width * .9);
      segment(lower, joint, target, width * .8);
      elbow.position.copy(joint);
      wrist.position.copy(target);
      end.position.copy(target);
    },
  };
}

function createHead(parts: Parts, parent: THREE.Object3D, y: number, accent: Palette, butler: boolean) {
  const head = addGroup(parent, "robot-head", 0, y, 0);
  parts.part(head, "box", "ivory", 0, 0, 0, .68, .54, .61);
  parts.part(head, "box", "porcelain", 0, .284, 0, .61, .06, .56);
  parts.part(head, "box", "linen", 0, -.275, 0, .60, .035, .55);
  parts.part(head, "box", "screen", 0, .015, .311, .50, .23, .026);
  const eyes = addGroup(head, "pixel-eyes", 0, .03, .332);
  for (const x of [-.118, .118]) {
    parts.part(eyes, "box", "blue", x, 0, 0, .087, .104, .015);
    parts.part(eyes, "box", "eye", x + .011, .013, .009, .035, .057, .01);
  }
  parts.part(head, "box", "silver", 0, -.176, .315, .105, .025, .018);
  for (const side of [-1, 1]) {
    parts.part(head, "box", "silver", side * .35, -.02, -.02, .055, .19, .25);
    parts.part(head, "box", accent, side * .38, -.02, -.02, .026, .11, .13);
  }
  if (!butler) {
    parts.part(head, "cylinder", "silver", .21, .34, -.13, .021, .09, .021);
    parts.part(head, "box", accent, .21, .397, -.13, .064, .048, .064);
  }
  return { head, eyes };
}

function createRobot(parts: Parts, parent: THREE.Object3D, accent: Palette, butler = false) {
  const robot = addGroup(parent, butler ? "butler" : "agent");
  const bodyY = butler ? 1.45 : 1.20;
  const headY = butler ? 2.06 : 1.81;
  const shoulderY = bodyY + .19;
  parts.part(robot, "box", accent, 0, bodyY, 0, .60, .56, .43);
  parts.part(robot, "box", butler ? "porcelain" : "linen", 0, bodyY + .015, .224, .30, .35, .035);
  parts.part(robot, "box", "navy", 0, bodyY - .325, -.015, .45, .09, .35);
  parts.part(robot, "box", accent, 0, bodyY - .43, -.015, .51, .15, .37);
  parts.part(robot, "cylinder", "silver", 0, bodyY + .345, 0, .095, .14, .095);
  for (const side of [-1, 1]) parts.part(robot, "box", accent, side * .347, shoulderY, 0, .14, .24, .31);
  const { head, eyes } = createHead(parts, robot, headY, accent, butler);
  if (butler) {
    for (const side of [-1, 1]) {
      const tie = parts.part(robot, "box", "blue", side * .09, bodyY + .19, .275, .145, .11, .07);
      tie.rotation.z = side * .5;
      const lapel = parts.part(robot, "box", "navy", side * .16, bodyY + .005, .259, .09, .32, .065);
      lapel.rotation.z = side * -.42;
    }
    parts.part(robot, "box", "eye", 0, bodyY + .19, .31, .07, .085, .035);
    for (const y of [bodyY - .04, bodyY - .15]) parts.part(robot, "cylinder", "gold", 0, y, .265, .022, .028, .022).rotation.x = Math.PI / 2;
  } else {
    parts.part(robot, "box", accent, 0, bodyY + .055, .251, .19, .10, .023);
    for (const x of [-.05, 0, .05]) parts.part(robot, "box", "navy", x, bodyY - .135, .252, .026, .04, .015);
  }
  const leftArm = createLimb(parts, robot, new THREE.Vector3(-.36, shoulderY, .02), accent, .45, .47, new THREE.Vector3(-.6, -1, 0));
  const rightArm = createLimb(parts, robot, new THREE.Vector3(.36, shoulderY, .02), accent, .45, .47, new THREE.Vector3(.6, -1, 0));
  return { robot, head, eyes, leftArm, rightArm };
}

function createChair(parts: Parts, parent: THREE.Object3D) {
  for (const x of [-.40, .40]) for (const z of [-.34, .34]) parts.part(parent, "box", "woodDark", x, .335, z, .11, .67, .11);
  parts.part(parent, "box", "wood", 0, .675, 0, .91, .105, .81);
  parts.part(parent, "box", "navy", 0, .745, .015, .76, .095, .68);
  for (const x of [-.40, .40]) {
    parts.part(parent, "box", "wood", x, 1.15, -.345, .11, .90, .11);
    parts.part(parent, "box", "woodLight", x, 1.15, .03, .13, .09, .86);
    parts.part(parent, "box", "wood", x, .94, .35, .085, .40, .085);
    parts.part(parent, "box", "gold", x, 1.15, .475, .10, .055, .035);
  }
  parts.part(parent, "box", "woodLight", 0, 1.57, -.345, .90, .105, .115);
  for (const x of [-.25, 0, .25]) parts.part(parent, "box", "wood", x, 1.25, -.35, .13, .62, .08);
}

function createCup(parts: Parts, parent: THREE.Object3D) {
  const cup = addGroup(parent, "tea-cup");
  parts.part(cup, "cup", "porcelain", 0, 0, 0, 1, 1, 1);
  parts.part(cup, "cylinder", "tea", 0, .111, 0, .103, .008, .103);
  const handle = parts.part(cup, "ring", "porcelain", .146, .08, 0, .060, .070, .060);
  handle.rotation.y = Math.PI / 2;
  const lip = parts.part(cup, "ring", "gold", 0, .14, 0, .116, .116, .025);
  lip.rotation.x = Math.PI / 2;
  return cup;
}

function createTable(parts: Parts, parent: THREE.Object3D) {
  parts.part(parent, "cylinder", "woodDark", 0, .19, 0, .56, .20, .56);
  parts.part(parent, "cylinder", "wood", 0, .58, 0, .23, .76, .23);
  parts.part(parent, "cylinder", "woodLight", 0, 1.025, 0, TEA_LAYOUT.tableRadius, .13, TEA_LAYOUT.tableRadius);
  parts.part(parent, "cylinder", "gold", 0, 1.092, 0, TEA_LAYOUT.tableRadius, .018, TEA_LAYOUT.tableRadius);
  parts.part(parent, "cylinder", "wood", 0, 1.116, 0, TEA_LAYOUT.tableRadius - .02, .028, TEA_LAYOUT.tableRadius - .02);
  for (const z of [-1.25, -.94, -.63, -.32, 0, .32, .63, .94, 1.25]) {
    const width = 2 * Math.sqrt((TEA_LAYOUT.tableRadius - .055) ** 2 - z ** 2);
    parts.part(parent, "box", "woodLight", 0, 1.133, z, width, .004, .014);
  }
  parts.part(parent, "cylinder", "porcelain", 0, 1.25, 0, .155, .235, .155);
  parts.part(parent, "cylinder", "gold", 0, 1.355, 0, .162, .045, .162);
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.4;
    const x = Math.sin(angle) * .19;
    const z = Math.cos(angle) * .19;
    const stem = parts.part(parent, "box", "leaf", x * .5, 1.43, z * .5, .022, .25, .022);
    stem.rotation.z = x * -1.3;
    const leaf = parts.part(parent, "box", "leaf", x, 1.45, z, .10, .17, .08);
    leaf.rotation.set(.3, angle, .35);
    parts.part(parent, "box", i % 2 ? "ivory" : "porcelain", x, 1.58 + i % 3 * .035, z, .095, .085, .095);
    parts.part(parent, "box", "gold", x, 1.63 + i % 3 * .035, z, .04, .02, .04);
  }
}

function createTeapot(parts: Parts, parent: THREE.Object3D) {
  const pot = addGroup(parent, "teapot");
  parts.part(pot, "cylinder", "porcelain", 0, -.04, .21, .19, .27, .19);
  parts.part(pot, "cylinder", "ivory", 0, -.19, .21, .145, .045, .145);
  parts.part(pot, "cylinder", "porcelain", 0, .108, .21, .15, .055, .15);
  parts.part(pot, "box", "gold", 0, .16, .21, .08, .06, .08);
  const handle = parts.part(pot, "ring", "ivory", 0, -.015, -.015, .125, .125, .125);
  handle.rotation.y = Math.PI / 2;
  const spout = parts.part(pot, "cylinder", "porcelain", 0, 0, 0, .05, .2, .05);
  segment(spout, new THREE.Vector3(0, -.055, .34), new THREE.Vector3(0, .095, .49), .052);
  parts.part(pot, "cylinder", "gold", 0, .095, .49, .056, .025, .056);
  return pot;
}

export function createTeaScene(): { group: THREE.Group; update(time: number): void; cycleDuration: number } {
  const group = new THREE.Group();
  group.name = "tea-courtyard";
  const parts = createParts(group);
  createTable(parts, group);
  const accents: Palette[] = ["orange", "sage", "blue", "linen"];
  const guests = accents.map((accent, index) => {
    const angle = index * Math.PI / 2;
    const seat = addGroup(group, `agent-seat-${index}`, Math.sin(angle) * TEA_LAYOUT.agentRadius, 0, Math.cos(angle) * TEA_LAYOUT.agentRadius);
    seat.rotation.y = angle + Math.PI;
    createChair(parts, seat);
    const robot = createRobot(parts, seat, accent);
    for (const side of [-1, 1]) {
      parts.part(robot.robot, "box", accent, side * .18, .75, .15, .22, .22, .46);
      parts.part(robot.robot, "joint", "silver", side * .18, .62, .33, .105, .105, .105);
      parts.part(robot.robot, "box", "ivory", side * .18, .40, .33, .16, .40, .16);
      parts.part(robot.robot, "box", "navy", side * .18, .10, .405, .23, .20, .35);
    }
    const cup = createCup(parts, seat);
    parts.part(seat, "cylinder", "porcelain", TEA_LAYOUT.cupX, 1.14, TEA_LAYOUT.cupZ, .187, .022, .187);
    const napkin = parts.part(seat, "box", "linen", .40, 1.137, .83, .25, .012, .25);
    napkin.rotation.y = .35;
    const steam = [0, 1, 2].map(() => parts.part(cup, "joint", "steam", 0, .3, 0, .025, .08, .025));
    return { ...robot, cup, steam };
  });

  const butler = createRobot(parts, group, "navy", true);
  const legs = [-1, 1].map(side => {
    const limb = createLimb(parts, butler.robot, new THREE.Vector3(side * .19, 1.025, -.015), "navy", .46, .46, new THREE.Vector3(0, 0, 1), .20);
    parts.part(limb.end, "box", "navy", 0, -.015, .075, .26, .19, .39);
    parts.part(limb.end, "box", "silver", 0, -.105, .075, .27, .025, .40);
    return limb;
  });
  const pot = createTeapot(parts, butler.rightArm.end);
  const tray = addGroup(butler.leftArm.end, "serving-tray", 0, .09, .09);
  parts.part(tray, "cylinder", "gold", 0, 0, 0, .26, .035, .26);
  parts.part(tray, "cylinder", "silver", 0, .018, 0, .23, .015, .23);
  parts.part(tray, "cylinder", "porcelain", -.11, .08, 0, .085, .11, .085);
  parts.part(tray, "cylinder", "gold", -.11, .146, 0, .09, .021, .09);
  const stream = parts.part(group, "cylinder", "tea", 0, 0, 0, 0, 0, 0);
  stream.name = "tea-stream";
  const restHand = new THREE.Vector3(.30, 1.30, .29);
  const hand = new THREE.Vector3();
  const target = new THREE.Vector3();
  const cupLocal = new THREE.Vector3();
  const lipLocal = new THREE.Vector3(0, .095, .49);
  const lipWorld = new THREE.Vector3();
  const streamEnd = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const tiltRotation = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const guestHand = new THREE.Vector3();
  parts.compile();

  function update(time: number) {
    const motion = getTeaMotion(time);
    guests.forEach((guest, index) => {
      const pose = getAgentTeaPose(time, index);
      guest.cup.position.set(
        THREE.MathUtils.lerp(TEA_LAYOUT.cupX, -.18, pose.lift),
        THREE.MathUtils.lerp(TEA_LAYOUT.cupY, 1.71, pose.lift),
        THREE.MathUtils.lerp(TEA_LAYOUT.cupZ, .51, pose.lift),
      );
      guest.cup.rotation.x = -.24 * pose.lift;
      guestHand.set(.145, .07, -.025).applyEuler(guest.cup.rotation).add(guest.cup.position);
      guest.leftArm.pose(guestHand);
      guest.rightArm.pose(target.set(.37, 1.18, .72));
      guest.head.rotation.set(pose.nod - pose.lift * .04, -.32 * pose.attention + Math.sin(time * .3 + index * 1.5) * .025, 0);
      const blink = (time + index * 2.7) % 6.9;
      guest.eyes.scale.y = blink > 6.72 ? .2 : 1;
      guest.steam.forEach((puff, number) => {
        const progress = ((time * .45 + number / 3 + index * .15) % 1 + 1) % 1;
        puff.position.set(Math.sin(progress * 5 + index) * .035, .21 + progress * .29, Math.cos(progress * 4) * .025);
        const size = Math.sin(progress * Math.PI);
        puff.scale.set(.023 * size, .055 * size, .023 * size);
      });
    });

    butler.robot.position.set(motion.x, 0, motion.z);
    butler.robot.rotation.y = motion.heading;
    butler.head.rotation.set(motion.nod + motion.lift * .07, 0, 0);
    butler.eyes.scale.y = time % 7.7 > 7.52 ? .2 : 1;
    legs.forEach((leg, index) => {
      const gait = Math.sin(motion.walkDistance * 8.2 + index * Math.PI);
      const side = index ? 1 : -1;
      leg.pose(target.set(side * .19, .1175 + Math.max(0, gait) * .16 * motion.walkWeight, gait * .21 * motion.walkWeight));
    });
    butler.leftArm.pose(target.set(-.44, 1.16, .34));
    const cup = teaCupPosition(motion.guestIndex);
    const cosine = Math.cos(motion.heading);
    const sine = Math.sin(motion.heading);
    const dx = cup.x - motion.x;
    const dz = cup.z - motion.z;
    cupLocal.set(dx * cosine - dz * sine, TEA_LAYOUT.cupY + .32, dx * sine + dz * cosine);
    tiltRotation.setFromAxisAngle(xAxis, motion.tilt * .55);
    target.copy(lipLocal).applyQuaternion(tiltRotation);
    hand.copy(cupLocal).sub(target).lerp(restHand, 1 - motion.lift);
    butler.rightArm.pose(hand);
    pot.quaternion.copy(tiltRotation);

    if (motion.pour > 0) {
      group.updateWorldMatrix(true, true);
      inverse.copy(group.matrixWorld).invert();
      lipWorld.copy(lipLocal).applyMatrix4(pot.matrixWorld).applyMatrix4(inverse);
      streamEnd.set(cup.x, TEA_LAYOUT.cupY + .12, cup.z);
      segment(stream, lipWorld, streamEnd, .013 * motion.pour);
    } else stream.scale.set(0, 0, 0);
    parts.update();
  }

  update(9.6);
  return { group, update, cycleDuration: TEA_CYCLE_DURATION };
}

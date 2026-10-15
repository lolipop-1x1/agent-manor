import * as THREE from 'three';

export type EstateFeature = 'overview' | 'sessions' | 'code-map' | 'resources';

type Surface = 'stone' | 'roof' | 'foliage' | 'wood' | 'metal' | 'glass' | 'earth' | 'water' | 'light';
type Block = { matrix: THREE.Matrix4; color: THREE.Color };

const palette = {
  stone: 0xe7d8b9,
  stoneLight: 0xf6ebd3,
  stoneShade: 0xcebc99,
  paving: 0xe0d2b4,
  roof: 0x526d82,
  roofLight: 0x658397,
  roofDark: 0x3d5669,
  leaf: 0x5f7841,
  leafLight: 0x88a45b,
  leafDark: 0x3e5d37,
  grass: 0xa1ac76,
  grassLight: 0xaebc87,
  wood: 0x876847,
  bronze: 0x756043,
  iron: 0x354443,
  glass: 0x46616b,
  blue: 0x3267d2,
  flower: 0xf7edd7,
};

/** 静态方块按材质实例化，建筑细节的数量不再决定绘制调用数量。 */
function blockBuilder(group: THREE.Group) {
  const batches = new Map<Surface, Block[]>();
  const dummy = new THREE.Object3D();

  function box(
    x: number, y: number, z: number,
    width: number, height: number, depth: number,
    color: number, surface: Surface = 'stone',
    rotationY = 0, rotationZ = 0,
  ) {
    dummy.position.set(x, y, z);
    dummy.scale.set(width, height, depth);
    dummy.rotation.set(0, rotationY, rotationZ);
    dummy.updateMatrix();
    const blocks = batches.get(surface) ?? [];
    blocks.push({ matrix: dummy.matrix.clone(), color: new THREE.Color(color) });
    batches.set(surface, blocks);
  }

  function finish() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    for (const [surface, blocks] of batches) {
      const material = new THREE.MeshStandardMaterial({
        roughness: surface === 'glass' || surface === 'water' ? 0.27 : 0.88,
        metalness: surface === 'metal' ? 0.45 : 0,
        ...(surface === 'light' ? { emissive: 0xffd28a, emissiveIntensity: 0.75 } : {}),
      });
      const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
      mesh.name = `estate-${surface}`;
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]!;
        mesh.setMatrixAt(index, block.matrix);
        mesh.setColorAt(index, block.color);
      }
      mesh.castShadow = surface !== 'light' && surface !== 'water';
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  return { box, finish };
}

export function createEstate(): {
  group: THREE.Group;
  hotspots: { object: THREE.Object3D; feature: EstateFeature }[];
  update(time: number): void;
} {
  const group = new THREE.Group();
  group.name = 'agent-manor-estate';
  const { box, finish } = blockBuilder(group);
  const hotspots: { object: THREE.Object3D; feature: EstateFeature }[] = [];
  let seed = 27;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function hotspot(feature: EstateFeature, x: number, y: number, z: number, width: number, height: number, depth: number) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    mesh.name = `estate-hotspot-${feature}`;
    mesh.position.set(x, y, z);
    mesh.userData.feature = feature;
    group.add(mesh);
    hotspots.push({ object: mesh, feature });
  }

  function cornice(x: number, y: number, z: number, width: number, depth: number) {
    box(x, y - 0.13, z, width + 0.1, 0.1, depth + 0.1, palette.stoneShade);
    box(x, y, z, width + 0.38, 0.16, depth + 0.38, palette.stoneLight);
    box(x, y + 0.12, z, width + 0.52, 0.1, depth + 0.52, palette.stone);
  }

  function window(x: number, y: number, z: number, width = 0.78, height = 1.5, angle = 0) {
    function part(dx: number, dy: number, dz: number, w: number, h: number, d: number, color: number, surface: Surface = 'stone') {
      box(x + dx * Math.cos(angle) + dz * Math.sin(angle), y + dy,
        z - dx * Math.sin(angle) + dz * Math.cos(angle), w, h, d, color, surface, angle);
    }
    part(0, 0, 0, width + 0.16, height + 0.15, 0.1, palette.stoneShade);
    part(0, 0, 0.062, width, height, 0.06, palette.glass, 'glass');
    part(-width / 2 - 0.035, 0, 0.1, 0.1, height + 0.18, 0.15, palette.stoneLight);
    part(width / 2 + 0.035, 0, 0.1, 0.1, height + 0.18, 0.15, palette.stoneLight);
    part(0, height / 2 + 0.08, 0.1, width + 0.26, 0.13, 0.18, palette.stoneLight);
    part(0, -height / 2 - 0.08, 0.17, width + 0.3, 0.14, 0.3, palette.stoneLight);
    part(0, 0, 0.13, 0.055, height, 0.07, palette.stoneLight);
    part(0, 0.03, 0.13, width, 0.055, 0.07, palette.stoneLight);
    part(0, height * 0.29, 0.13, width, 0.045, 0.07, palette.stoneLight);
    part(-width * 0.35, -height * 0.2, 0.1, width * 0.16, height * 0.55, 0.06, 0xbda579, 'wood');
  }

  function roof(x: number, y: number, z: number, width: number, depth: number, levels: number) {
    // 每层保留可见的瓦片边缘，内部使用整块，避免遮挡区域堆积几何。
    for (let level = 0; level < levels; level += 1) {
      const w = width - level * 0.47;
      const d = depth - level * 0.47;
      const yy = y + level * 0.24;
      box(x, yy, z, w - 0.02, 0.26, d - 0.02, palette.roof, 'roof');
      const nx = Math.ceil(w / 0.49);
      const nz = Math.ceil(d / 0.49);
      for (let ix = 0; ix < nx; ix += 1) {
        const xx = x - w / 2 + (ix + 0.5) * w / nx;
        for (const side of [-1, 1]) {
          box(xx, yy + 0.025, z + side * (d / 2 - 0.15), w / nx - 0.025, 0.26, 0.32,
            random() > 0.5 ? palette.roofLight : palette.roof, 'roof');
        }
      }
      for (let iz = 1; iz < nz - 1; iz += 1) {
        const zz = z - d / 2 + (iz + 0.5) * d / nz;
        for (const side of [-1, 1]) {
          box(x + side * (w / 2 - 0.15), yy + 0.025, zz, 0.32, 0.26, d / nz - 0.025,
            random() > 0.55 ? palette.roofLight : palette.roofDark, 'roof');
        }
      }
    }
    box(x, y + levels * 0.24, z, width - levels * 0.47 + 0.12, 0.14,
      depth - levels * 0.47 + 0.12, palette.roofLight, 'roof');
  }

  function dormer(x: number, y: number, z: number) {
    box(x, y, z, 0.8, 0.92, 0.72, palette.stone);
    window(x, y, z + 0.37, 0.42, 0.65);
    box(x, y + 0.54, z, 1.02, 0.13, 0.95, palette.stoneLight);
    roof(x, y + 0.67, z, 1.05, 1.05, 2);
  }

  function chimney(x: number, y: number, z: number) {
    box(x, y, z, 0.51, 1.48, 0.6, palette.stone);
    for (let row = 0; row < 4; row += 1) {
      box(x, y - 0.52 + row * 0.32, z + 0.303, 0.51, 0.022, 0.015, palette.stoneShade);
    }
    box(x, y + 0.69, z, 0.69, 0.17, 0.76, palette.stoneLight);
    box(x, y + 0.87, z, 0.3, 0.22, 0.39, palette.bronze, 'metal');
  }

  function column(x: number, base: number, z: number, height: number, width = 0.32) {
    box(x, base + 0.12, z, width + 0.28, 0.24, width + 0.28, palette.stoneLight);
    box(x, base + height / 2, z, width, height - 0.32, width, palette.stoneLight);
    box(x - width * 0.15, base + height / 2, z + width / 2 + 0.008, 0.035, height - 0.65, 0.02, palette.stoneShade);
    box(x + width * 0.15, base + height / 2, z + width / 2 + 0.008, 0.035, height - 0.65, 0.02, palette.stoneShade);
    box(x, base + height - 0.11, z, width + 0.26, 0.22, width + 0.26, palette.stoneLight);
  }

  function balustrade(x: number, y: number, z: number, length: number, angle = 0) {
    box(x, y, z, length, 0.12, 0.23, palette.stoneLight, 'stone', angle);
    box(x, y + 0.61, z, length + 0.12, 0.14, 0.27, palette.stoneLight, 'stone', angle);
    const count = Math.floor(length / 0.33);
    for (let i = 0; i <= count; i += 1) {
      const offset = (i / count - 0.5) * (length - 0.16);
      const xx = x + offset * Math.cos(angle);
      const zz = z - offset * Math.sin(angle);
      box(xx, y + 0.3, zz, 0.11, 0.5, 0.11, palette.stoneLight);
      box(xx, y + 0.27, zz, 0.17, 0.18, 0.17, palette.stone);
    }
  }

  function lantern(x: number, y: number, z: number, scale = 1) {
    box(x, y - 0.1 * scale, z, 0.12 * scale, 0.55 * scale, 0.12 * scale, palette.iron, 'metal');
    box(x, y + 0.23 * scale, z, 0.27 * scale, 0.4 * scale, 0.27 * scale, 0xffe2a1, 'light');
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(x + sx * 0.155 * scale, y + 0.24 * scale, z + sz * 0.155 * scale,
          0.045 * scale, 0.46 * scale, 0.045 * scale, palette.iron, 'metal');
      }
    }
    box(x, y, z, 0.38 * scale, 0.08 * scale, 0.38 * scale, palette.iron, 'metal');
    box(x, y + 0.49 * scale, z, 0.42 * scale, 0.1 * scale, 0.42 * scale, palette.iron, 'metal');
    box(x, y + 0.59 * scale, z, 0.26 * scale, 0.13 * scale, 0.26 * scale, palette.bronze, 'metal');
    box(x, y + 0.7 * scale, z, 0.09 * scale, 0.11 * scale, 0.09 * scale, palette.bronze, 'metal');
  }

  function pillar(x: number, z: number, height = 1.7) {
    box(x, 0.43, z, 0.78, 0.2, 0.78, palette.stoneShade);
    box(x, 0.35 + height / 2, z, 0.59, height, 0.59, palette.stone);
    for (let y = 0.65; y < height + 0.2; y += 0.38) {
      box(x, y, z + 0.302, 0.59, 0.017, 0.012, palette.stoneShade);
    }
    box(x, height + 0.35, z, 0.81, 0.16, 0.81, palette.stoneLight);
    box(x, height + 0.48, z, 0.65, 0.1, 0.65, palette.stone);
  }

  function hedge(x: number, z: number, width: number, depth: number, height = 0.55) {
    box(x, 0.39 + height / 2, z, width, height, depth, palette.leafDark, 'foliage');
    const nx = Math.max(1, Math.round(width / 0.31));
    const nz = Math.max(1, Math.round(depth / 0.31));
    for (let ix = 0; ix < nx; ix += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        box(x + (ix + 0.5) * width / nx - width / 2, 0.4 + height + random() * 0.08,
          z + (iz + 0.5) * depth / nz - depth / 2,
          width / nx - 0.018, 0.2, depth / nz - 0.018,
          random() > 0.6 ? palette.leafLight : palette.leaf, 'foliage');
      }
    }
  }

  function flower(x: number, z: number, color = palette.flower) {
    const height = 0.58 + random() * 0.16;
    box(x, height, z, 0.046, 0.4, 0.046, palette.leafDark, 'foliage');
    box(x, height + 0.23, z, 0.14, 0.08, 0.14, color);
    box(x, height + 0.27, z, 0.065, 0.065, 0.065, 0xdfb85b);
    box(x + 0.07, height, z, 0.18, 0.055, 0.11, palette.leafLight, 'foliage', 0, 0.22);
  }

  function parterre(x: number, z: number, width: number, depth: number) {
    box(x, 0.39, z, width + 0.2, 0.08, depth + 0.2, palette.stoneShade);
    // 土层收进树篱内部，避免外侧同向表面争用深度。
    box(x, 0.44, z, width - 0.12, 0.11, depth - 0.12, palette.grass, 'earth');
    hedge(x, z - depth / 2 + 0.22, width, 0.44);
    hedge(x, z + depth / 2 - 0.22, width, 0.44);
    hedge(x - width / 2 + 0.22, z, 0.44, depth - 0.88);
    hedge(x + width / 2 - 0.22, z, 0.44, depth - 0.88);
    for (let i = 0; i < Math.floor(width * depth * 2.7); i += 1) {
      flower(x + (random() - 0.5) * Math.max(0.1, width - 1.2), z + (random() - 0.5) * Math.max(0.1, depth - 1.2));
    }
  }

  function topiary(x: number, z: number, scale = 1, base = 0.35) {
    box(x, base + 0.15, z, 0.65 * scale, 0.3, 0.65 * scale, palette.stoneShade);
    box(x, base + 0.38, z, 0.8 * scale, 0.16, 0.8 * scale, palette.stoneLight);
    box(x, base + 0.57, z, 0.18 * scale, 0.48, 0.18 * scale, palette.wood, 'wood');
    for (let level = 0; level < 5; level += 1) {
      const size = (1 - level * 0.155) * scale;
      box(x, base + 0.8 + level * 0.27 * scale, z, size, 0.36 * scale, size,
        level % 2 ? palette.leafLight : palette.leaf, 'foliage');
    }
  }

  function tree(x: number, z: number, scale = 1) {
    box(x, 0.35 + 1.15 * scale, z, 0.3 * scale, 2.3 * scale, 0.3 * scale, palette.wood, 'wood');
    box(x - 0.22 * scale, 1.7 * scale, z, 0.18 * scale, 0.9 * scale, 0.18 * scale, palette.wood, 'wood', 0, -0.55);
    const blocks = [
      [0, 2.85, 0, 1.5, 1.35, 1.3],
      [-0.65, 2.4, 0.17, 0.96, 0.95, 1.02],
      [0.64, 2.65, -0.15, 0.96, 0.94, 1.02],
      [-0.15, 3.6, 0, 0.9, 0.7, 0.95],
      [0.2, 2.57, 0.63, 0.95, 0.94, 0.82],
    ];
    for (const block of blocks) {
      const [dx, dy, dz, w, h, d] = block as [number, number, number, number, number, number];
      box(x + dx * scale, 0.35 + dy * scale, z + dz * scale, w * scale, h * scale, d * scale,
        random() > 0.5 ? palette.leaf : palette.leafLight, 'foliage');
      for (let i = 0; i < 8; i += 1) {
        box(x + (dx + (random() - 0.5) * w) * scale, 0.35 + (dy + (random() - 0.5) * h) * scale,
          z + (dz + (random() - 0.5) * d) * scale,
          0.42 * scale, 0.38 * scale, 0.42 * scale, random() > 0.5 ? palette.leafLight : palette.leafDark, 'foliage');
      }
    }
  }

  // 低矮石基、草坪和铺装共同形成一座完整的微缩庄园。
  box(0, -0.12, 0.5, 28, 0.62, 25.5, 0xb79d73, 'earth');
  box(0, 0.17, 0.5, 28.18, 0.14, 25.68, palette.stoneShade);
  box(0, 0.29, 0.5, 27.9, 0.12, 25.4, palette.grass, 'earth');
  // 铺装高于草坪，砖缝中的底板不与草坪顶面重合。
  box(0, 0.326, 0.5, 25.7, 0.06, 23.3, palette.paving);
  const tileSize = 0.84;
  for (let iz = 0; iz < 27; iz += 1) {
    for (let ix = 0; ix < 30; ix += 1) {
      const x = -12.7 + (ix + 0.5) * tileSize;
      const z = -10.9 + (iz + 0.5) * tileSize;
      if (z < -2.3 && Math.abs(x) < 12.5) continue;
      box(x, 0.35, z, tileSize - 0.016, 0.028, tileSize - 0.016,
        random() > 0.75 ? 0xe6d9bf : palette.paving);
    }
  }

  // 中央主馆：双层立面、贯通柱廊和带领结的三角山花。
  box(0, 0.69, -5.75, 12, 0.68, 6.25, palette.stoneShade);
  box(0, 1.07, -5.75, 12.3, 0.16, 6.45, palette.stoneLight);
  box(0, 3.68, -6, 11.65, 5.25, 5.7, palette.stone);
  cornice(0, 3.8, -6, 11.65, 5.7);
  cornice(0, 6.34, -6, 11.65, 5.7);
  for (const x of [-5.65, -2.03, 2.03, 5.65]) {
    box(x, 3.67, -3.12, 0.3, 5.16, 0.2, palette.stoneLight);
    for (let level = 0; level < 11; level += 1) {
      box(x, 1.36 + level * 0.45, -3.0, 0.38, 0.19, 0.11, palette.stoneLight);
    }
  }
  for (const x of [-4.85, -3.42, 3.42, 4.85]) {
    window(x, 2.43, -3.12, 0.85, 1.66);
    window(x, 5.01, -3.12, 0.85, 1.62);
  }
  for (const side of [-1, 1]) {
    for (const z of [-7.7, -5.8, -4.05]) {
      window(side * 5.83, 5, z, 0.8, 1.58, side * Math.PI / 2);
    }
  }
  box(0, 2.13, -3.08, 1.75, 2.06, 0.12, palette.wood, 'wood');
  for (const side of [-1, 1]) {
    box(side * 0.43, 2.28, -2.99, 0.6, 1.42, 0.045, 0x5d4933, 'wood');
    box(side * 0.42, 2.54, -2.95, 0.44, 0.74, 0.05, palette.glass, 'glass');
    box(side * 0.13, 2.13, -2.89, 0.07, 0.22, 0.065, 0xc9a769, 'metal');
    lantern(side * 1.32, 2.1, -2.7, 0.8);
  }
  window(0, 4.97, -3.1, 1.4, 1.95);
  for (const x of [-2.06, -1.16, 1.16, 2.06]) column(x, 1.13, -2.3, 5.17, 0.34);
  box(0, 3.93, -2.5, 4.83, 0.22, 1.44, palette.stoneLight);
  balustrade(0, 4.07, -1.84, 4.65);
  box(0, 6.43, -2.42, 5.2, 0.33, 1.48, palette.stoneLight);
  roof(0, 6.55, -6.15, 12.28, 6.55, 8);

  const pedimentShape = new THREE.Shape();
  pedimentShape.moveTo(-2.65, 0);
  pedimentShape.lineTo(2.65, 0);
  pedimentShape.lineTo(0, 1.7);
  pedimentShape.closePath();
  const pediment = new THREE.Mesh(
    new THREE.ExtrudeGeometry(pedimentShape, { depth: 0.25, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: palette.stone, roughness: 0.85 }),
  );
  pediment.position.set(0, 6.57, -2.86);
  pediment.castShadow = true;
  pediment.receiveShadow = true;
  group.add(pediment);
  const slope = Math.atan2(1.7, 2.65);
  box(-1.33, 7.49, -2.53, 3.27, 0.16, 0.4, palette.stoneLight, 'stone', 0, slope);
  box(1.33, 7.49, -2.53, 3.27, 0.16, 0.4, palette.stoneLight, 'stone', 0, -slope);
  box(0, 6.7, -2.5, 5.5, 0.17, 0.45, palette.stoneLight);
  for (const side of [-1, 1]) {
    const tie = new THREE.Shape();
    tie.moveTo(side * 0.035, 0);
    tie.lineTo(side * 0.44, 0.29);
    tie.lineTo(side * 0.44, -0.29);
    tie.closePath();
    const bow = new THREE.Mesh(
      new THREE.ExtrudeGeometry(tie, { depth: 0.1, bevelEnabled: false }),
      new THREE.MeshStandardMaterial({ color: palette.blue, roughness: 0.55 }),
    );
    bow.position.set(0, 7.25, -2.53);
    bow.castShadow = true;
    group.add(bow);
  }
  box(0, 7.25, -2.42, 0.12, 0.21, 0.1, palette.blue, 'roof');
  for (const x of [-4.45, -2.9, 2.9, 4.45]) dormer(x, 7.15, -3.43);
  for (const x of [-4.9, 4.9]) chimney(x, 8.19, -7.5);

  // 两翼向前展开，塔楼与连接廊让建筑群围合庭院。
  for (const side of [-1, 1]) {
    const x = side * 9.55;
    box(x, 0.64, -5.5, 6.32, 0.59, 5.75, palette.stoneShade);
    box(x, 2.96, -5.5, 6.03, 4.25, 5.55, palette.stone);
    cornice(x, 0.99, -5.5, 6.03, 5.55);
    cornice(x, 3.04, -5.5, 6.03, 5.55);
    cornice(x, 5.13, -5.5, 6.03, 5.55);
    for (const dx of [-2, -0.67, 0.67, 2]) {
      window(x + dx, 1.99, -2.71, 0.7, 1.27);
      window(x + dx, 4.08, -2.71, 0.7, 1.27);
    }
    for (const z of [-7.25, -5.5, -3.76]) {
      window(x + side * 3.03, 2.05, z, 0.7, 1.3, side * Math.PI / 2);
      window(x + side * 3.03, 4.08, z, 0.7, 1.3, side * Math.PI / 2);
    }
    // 瓦片下缘高于檐口顶面，保留真实的几何间隔。
    roof(x, 5.44, -5.5, 6.61, 6.05, 7);
    for (const dx of [-1.65, 1.65]) dormer(x + dx, 5.99, -2.91);
    chimney(x + side * 1.85, 6.95, -6.6);

    const towerX = side * 11.05;
    box(towerX, 0.64, -1.4, 3.04, 0.59, 3.03, palette.stoneShade);
    box(towerX, 2.71, -1.4, 2.84, 3.8, 2.82, palette.stone);
    cornice(towerX, 2.76, -1.4, 2.84, 2.82);
    cornice(towerX, 4.65, -1.4, 2.84, 2.82);
    for (const dx of [-0.61, 0.61]) {
      window(towerX + dx, 1.89, 0.025, 0.61, 1.2);
      window(towerX + dx, 3.77, 0.025, 0.61, 1.2);
    }
    window(towerX + side * 1.43, 3.77, -1.4, 0.85, 1.3, side * Math.PI / 2);
    roof(towerX, 4.9, -1.4, 3.4, 3.38, 6);
    box(towerX, 6.47, -1.4, 0.38, 0.28, 0.38, palette.stoneLight);
    box(towerX, 6.71, -1.4, 0.14, 0.27, 0.14, 0xc09b54, 'metal');

    box(side * 7.7, 1.02, -1.9, 3.64, 0.18, 1.86, palette.stoneLight);
    box(side * 7.7, 3.33, -1.9, 3.67, 0.2, 1.85, palette.stoneLight);
    for (let i = 0; i < 4; i += 1) column(side * (6.35 + i * 0.91), 1.1, -1.14, 2.17, 0.22);
    roof(side * 7.7, 3.55, -1.9, 3.98, 2.0, 3);
    balustrade(side * 4.36, 1.13, -2.45, 3.7);
    topiary(side * 5.53, -1.94, 0.88, 1.07);
  }

  for (let i = 0; i < 7; i += 1) {
    box(0, 0.35 + (i + 0.5) * 0.11, 0.06 - i * 0.37, 4.65, 0.11, 0.46,
      i % 2 ? palette.stone : palette.stoneLight);
  }
  for (const side of [-1, 1]) {
    box(side * 2.66, 0.62, -0.9, 0.48, 0.55, 2.78, palette.stoneShade);
    box(side * 2.66, 0.94, -0.9, 0.68, 0.14, 2.95, palette.stoneLight);
    pillar(side * 2.67, 0.45, 0.78);
    lantern(side * 2.67, 1.76, 0.45, 0.86);
  }

  // 园林遵循中轴秩序，东侧留出完整茶庭供管家绕行。
  parterre(-7.15, 8.91, 6.15, 2.0);
  parterre(-3.1, 4.6, 1.45, 4.6);
  parterre(-10.9, 4.6, 1.4, 4.6);
  parterre(-6.99, 0.58, 5.12, 1.75);
  parterre(6.1, -0.05, 4.82, 1.3);
  parterre(11.39, 5.45, 1.2, 7.76);
  parterre(5.9, 10.62, 7.7, 1.0);
  for (const [x, z, scale] of [
    [-11.9, -9.65, 0.93], [-6.8, -10, 1.0], [6.8, -10, 1.0], [11.9, -9.65, 0.93],
    [-12.1, 2.1, 0.87], [-12.1, 7.2, 0.95], [12.15, 3.2, 0.86], [12.15, 8.25, 0.88],
  ]) tree(x!, z!, scale!);
  for (const [x, z, scale] of [
    [-4.22, 0.83, 0.82], [4.22, 0.83, 0.82], [-9.22, 9.06, 0.65], [-5.17, 9.06, 0.65],
    [-10.85, 2.66, 0.72], [-10.85, 6.52, 0.72], [11.42, 2.8, 0.65], [11.42, 8.9, 0.65],
  ]) topiary(x!, z!, scale!);

  function fence(x: number, z: number, length: number, angle = 0, height = 1.09, plinth = true) {
    if (plinth) box(x, 0.52, z, length, 0.29, 0.35, palette.stone, 'stone', angle);
    const count = Math.floor(length / 0.27);
    for (let i = 0; i <= count; i += 1) {
      const offset = (i / count - 0.5) * length;
      const xx = x + Math.cos(angle) * offset;
      const zz = z - Math.sin(angle) * offset;
      box(xx, 0.79 + height / 2, zz, 0.047, height, 0.047, palette.iron, 'metal');
      box(xx, 0.82 + height, zz, 0.092, 0.12, 0.092, palette.iron, 'metal', 0, Math.PI / 4);
    }
    box(x, 1.0, z, length, 0.063, 0.063, palette.iron, 'metal', angle);
    box(x, 0.61 + height, z, length, 0.063, 0.063, palette.iron, 'metal', angle);
  }

  // 前侧铁艺大门和石柱形成边界，侧墙保持低矮，不遮挡茶会。
  for (const side of [-1, 1]) {
    for (const x of [2.25, 5.85, 9.45, 12.9]) pillar(side * x, 11.9, x === 2.25 ? 2.14 : 1.53);
    for (const x of [4.05, 7.65, 11.18]) fence(side * x, 11.9, x === 11.18 ? 2.85 : 3.0);
    lantern(side * 2.25, 2.96, 11.9, 1.02);
    for (const z of [-10.65, -7.05, -3.45, 0.15, 3.75, 7.35]) {
      pillar(side * 13.0, z, 1.15);
      box(side * 13, 0.9, z + 1.6, 0.31, 1.08, 2.76, palette.stone);
      box(side * 13, 1.5, z + 1.6, 0.46, 0.13, 2.88, palette.stoneLight);
    }
    box(side * 13, 0.9, 10.12, 0.31, 1.08, 2.76, palette.stone);
    box(side * 13, 1.5, 10.12, 0.46, 0.13, 2.88, palette.stoneLight);
    // 门扇向里打开，主路径从视觉上保持可进入。
    const angle = side * -0.87;
    const gateX = side * 1.68;
    const gateZ = 11.13;
    fence(gateX, gateZ, 1.95, angle, 1.78, false);
    box(gateX, 2.13, gateZ, 1.94, 0.1, 0.11, palette.bronze, 'metal', angle);
  }
  box(0, 0.2, 12.61, 5.25, 0.2, 1.2, palette.stoneLight);
  box(0, 0.04, 13.03, 5.65, 0.13, 0.64, palette.stone);
  box(0, 1.0, -11.35, 25.55, 1.2, 0.35, palette.stone);
  box(0, 1.67, -11.35, 25.75, 0.15, 0.53, palette.stoneLight);

  // 八角喷泉使用分层石碗和少量水珠，动画仅依赖外部传入时间。
  const fountainX = -6;
  const fountainZ = 4;
  const fountain = new THREE.Group();
  fountain.position.set(fountainX, 0.35, fountainZ);
  fountain.name = 'estate-fountain';
  group.add(fountain);
  const basinMaterial = new THREE.MeshStandardMaterial({ color: palette.stoneLight, roughness: 0.85 });
  const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x7faeae, roughness: 0.25, metalness: 0.12 });
  function basin(radius: number, y: number, height: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 8), material);
    mesh.position.y = y;
    mesh.rotation.y = Math.PI / 8;
    mesh.castShadow = material === basinMaterial;
    mesh.receiveShadow = true;
    fountain.add(mesh);
  }
  basin(1.99, 0.1, 0.2, basinMaterial);
  basin(1.82, 0.27, 0.2, basinMaterial);
  basin(1.64, 0.38, 0.025, waterMaterial);
  for (let i = 0; i < 8; i += 1) {
    const angle = i * Math.PI / 4;
    box(fountainX + Math.sin(angle) * 1.83, 0.83, fountainZ + Math.cos(angle) * 1.83,
      1.42, 0.32, 0.2, palette.stoneLight, 'stone', angle);
  }
  box(fountainX, 0.88, fountainZ, 0.72, 0.7, 0.72, palette.stone);
  box(fountainX, 1.26, fountainZ, 0.95, 0.16, 0.95, palette.stoneLight);
  box(fountainX, 1.58, fountainZ, 0.4, 0.7, 0.4, palette.stoneLight);
  basin(0.91, 1.57, 0.16, basinMaterial);
  basin(0.73, 1.665, 0.03, waterMaterial);
  box(fountainX, 2.28, fountainZ, 0.22, 0.57, 0.22, palette.stoneLight);
  basin(0.42, 2.12, 0.12, basinMaterial);
  basin(0.3, 2.19, 0.025, waterMaterial);
  const drops = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb0d7d1, roughness: 0.21, metalness: 0.1 }),
    48,
  );
  drops.name = 'fountain-water-drops';
  drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  drops.frustumCulled = false;
  fountain.add(drops);
  const waterDummy = new THREE.Object3D();

  hotspot('overview', 0, 4.6, -5.5, 11.6, 8, 6.6);
  hotspot('sessions', -9.4, 3.9, -5.7, 6.3, 6.5, 5.9);
  hotspot('code-map', -11.04, 3.2, -1.1, 3.3, 5.8, 3.2);
  hotspot('resources', 9.75, 3.5, -4.65, 6.2, 6.3, 8.1);
  finish();

  function update(time: number) {
    for (let i = 0; i < 48; i += 1) {
      const angle = Math.floor(i / 6) * Math.PI / 4;
      const phase = ((time * 0.61 + (i % 6) / 6) % 1 + 1) % 1;
      const radius = 0.19 + phase * 1.32;
      waterDummy.position.set(Math.sin(angle) * radius, 2.23 + phase * 0.75 - phase * phase * 2.56, Math.cos(angle) * radius);
      waterDummy.scale.set(0.042, 0.075 + phase * 0.05, 0.042);
      waterDummy.rotation.set(0, angle, 0);
      waterDummy.updateMatrix();
      drops.setMatrixAt(i, waterDummy.matrix);
    }
    drops.instanceMatrix.needsUpdate = true;
  }
  update(0);

  return { group, hotspots, update };
}

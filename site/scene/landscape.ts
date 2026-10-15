import * as THREE from "three";

/** 围墙外的同一片领地：车道接大门，树林和远坡随镜头一起转动。 */
export function createLandscape(): THREE.Group {
  const group = new THREE.Group();
  group.name = "manor-landscape";
  const blocks: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
  const dummy = new THREE.Object3D();
  let seed = 91;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  function box(x: number, y: number, z: number, w: number, h: number, d: number, color: number) {
    dummy.position.set(x, y, z);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    blocks.push({ matrix: dummy.matrix.clone(), color: new THREE.Color(color) });
  }

  const meadow = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: 0xa9b78c, roughness: 1 }),
  );
  meadow.name = "estate-meadow";
  meadow.rotation.x = -Math.PI / 2;
  meadow.position.y = -.47;
  meadow.receiveShadow = true;
  group.add(meadow);

  // 单条连续曲面避免拼接路块的共面重叠，入口处缓缓抬升到台阶。
  const drive = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -.02, 13.35),
    new THREE.Vector3(0, -.37, 18),
    new THREE.Vector3(-3, -.37, 25),
    new THREE.Vector3(-11, -.37, 33),
    new THREE.Vector3(-23, -.37, 42),
    new THREE.Vector3(-36, -.37, 55),
  ]);
  function ribbon(width: number, lift: number, color: number) {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const point = drive.getPoint(i / 80), tangent = drive.getTangent(i / 80);
      const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize().multiplyScalar(width / 2);
      for (const sign of [-1, 1]) positions.push(point.x + side.x * sign, point.y + lift, point.z + side.z * sign);
      if (i < 80) { const j = i * 2; indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    mesh.name = "estate-arrival-drive";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  ribbon(5.65, 0, 0xb7b49a);
  ribbon(4.9, .025, 0xd8ccb1);

  const leaves = [0x667e4d, 0x778e59, 0x8a9d69, 0x93a573];
  function tree(x: number, z: number, scale: number) {
    const base = -.46, trunk = 2.25 * scale;
    box(x, base + trunk / 2, z, .31 * scale, trunk, .31 * scale, 0x807257);
    const crown = [
      [0, 3.05, 0, 1.95, 1.55, 1.8],
      [-.8, 2.55, .16, 1.28, 1.22, 1.35],
      [.79, 2.8, -.2, 1.32, 1.32, 1.34],
      [-.12, 4, -.08, 1.35, .78, 1.23],
      [.15, 2.92, .84, 1.36, 1.12, 1.16],
    ];
    for (const [dx, y, dz, w, h, d] of crown) {
      box(x + dx! * scale, base + y! * scale, z + dz! * scale,
        w! * scale, h! * scale, d! * scale, leaves[Math.floor(random() * leaves.length)]!);
      for (let i = 0; i < 4; i++) {
        box(x + (dx! + (random() - .5) * w!) * scale, base + (y! + (random() - .5) * h!) * scale,
          z + (dz! + (random() - .5) * d!) * scale, .46 * scale, .41 * scale, .43 * scale,
          leaves[Math.floor(random() * leaves.length)]!);
      }
    }
  }

  // 近树形成侧景，后方树群围出腹地；入口前方保持开阔。
  for (const [x, z, scale] of [
    [-18, -13, 1.15], [-20, -5, 1.3], [-19, 5, 1.1], [-21, 14, 1.2],
    [19, -14, 1.25], [20, -4, 1.15], [19, 7, 1.1], [22, 16, 1.25],
    [-8, 20, .9], [8, 21, 1], [-10, 28, 1.05], [5, 29, 1.1],
    [-19, 34, 1.1], [-7, 39, 1.15],
  ]) tree(x!, z!, scale!);
  for (let i = 0; i < 25; i++) {
    const x = -35 + i * 2.9;
    tree(x, -21 - random() * 12, .92 + random() * .65);
  }
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? -1 : 1;
    tree(side * (29 + random() * 10), -9 + Math.floor(i / 2) * 8, 1 + random() * .45);
  }

  for (const [x, z] of [[-4, 17], [4, 17], [-6, 24], [1, 27]]) {
    box(x!, .52, z!, .09, 1.95, .09, 0x4b5d51);
    box(x!, 1.58, z!, .27, .32, .27, 0xf0d9a2);
    box(x!, 1.79, z!, .4, .1, .4, 0x4b5d51);
  }
  const woodland = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: .95 }), blocks.length);
  woodland.name = "estate-woodland";
  blocks.forEach((block, index) => {
    woodland.setMatrixAt(index, block.matrix);
    woodland.setColorAt(index, block.color);
  });
  woodland.castShadow = true;
  woodland.receiveShadow = true;
  woodland.computeBoundingSphere();
  group.add(woodland);

  const hillGeometry = new THREE.IcosahedronGeometry(1, 1);
  const hillMaterial = new THREE.MeshStandardMaterial({ color: 0x9eaf88, roughness: 1 });
  for (const [x, z, width, height, depth] of [[-25, -43, 24, 4, 12], [8, -48, 26, 5.2, 16], [40, -35, 22, 3.7, 15]]) {
    const hill = new THREE.Mesh(hillGeometry, hillMaterial);
    hill.position.set(x!, -1.8, z!);
    hill.scale.set(width!, height!, depth!);
    hill.name = "estate-distant-slope";
    group.add(hill);
  }
  return group;
}

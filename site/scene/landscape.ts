import * as THREE from "three";

/** 湖畔花园与主楼共用镜头和时间，暂停后没有独立运行的动画。 */
export function createLandscape(): { group: THREE.Group; update(time: number): void } {
  const group = new THREE.Group();
  group.name = "manor-landscape";
  type Block = { matrix: THREE.Matrix4; color: THREE.Color };
  const blocks: Block[] = [], panes: Block[] = [], petals: Block[] = [];
  const dummy = new THREE.Object3D();
  const stone = 0xcbbd9e, cream = 0xeee6cd, wood = 0x9c7951, darkWood = 0x685b42;
  const leaf = 0x758658, lavender = 0xa296b7, rose = 0xc9a5aa;
  let seed = 91;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  function box(x: number, y: number, z: number, w: number, h: number, d: number, color: number,
    ry = 0, rz = 0, batch = blocks) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, ry, rz);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    batch.push({ matrix: dummy.matrix.clone(), color: new THREE.Color(color) });
  }
  function beam(a: THREE.Vector3, b: THREE.Vector3, width: number, color: number) {
    dummy.position.copy(a).add(b).multiplyScalar(.5);
    dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    dummy.scale.set(width, a.distanceTo(b), width);
    dummy.updateMatrix();
    blocks.push({ matrix: dummy.matrix.clone(), color: new THREE.Color(color) });
  }
  function batch(name: string, entries: Block[], material: THREE.Material, geometry: THREE.BufferGeometry) {
    const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
    mesh.name = name;
    entries.forEach((entry, index) => { mesh.setMatrixAt(index, entry.matrix); mesh.setColorAt(index, entry.color); });
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.transparent;
    mesh.computeBoundingSphere();
    group.add(mesh);
    return mesh;
  }
  function surface(name: string, points: THREE.Vector2[], y: number, color: number) {
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(points));
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    mesh.name = name;
    mesh.position.y = y;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  const meadow = new THREE.Mesh(new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: 0xb2bd91, roughness: 1 }));
  meadow.name = "estate-meadow";
  meadow.rotation.x = -Math.PI / 2;
  meadow.position.y = -.47;
  meadow.receiveShadow = true;
  group.add(meadow);

  // 连续路面共享控制点；面层和路肩有真实高度差，避免旋转时争用深度。
  let pathLevel = -.38;
  function path(points: number[][], width: number, name: string, entrance = false) {
    const level = pathLevel;
    pathLevel += .004;
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z], i) => new THREE.Vector3(x!, entrance && i === 0 ? -.02 : level, z!)));
    for (const [size, lift, color] of [[width + .28, 0, 0xb6ad91], [width, .025, 0xd9cfb7]]) {
      const positions: number[] = [], indices: number[] = [];
      for (let i = 0; i <= 96; i++) {
        const point = curve.getPoint(i / 96), tangent = curve.getTangent(i / 96);
        const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize().multiplyScalar(size! / 2);
        for (const sign of [-1, 1]) positions.push(point.x + side.x * sign, point.y + lift!, point.z + side.z * sign);
        if (i < 96) { const j = i * 2; indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: color!, roughness: 1 }));
      mesh.name = name;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  path([[0, 13.35], [0, 18], [-3, 25], [-11, 33], [-23, 42], [-36, 55]], 4.9, "estate-arrival-drive", true);
  path([[2.6, 18], [6.8, 18.2], [9.6, 15.4], [12.5, 15.4], [12.5, 16.8]], 1.35, "garden-bridge-approach");
  path([[12.5, 25.5], [12.5, 26.5], [16, 28], [24, 27], [27, 22], [25, 16], [18.8, 11], [18.8, 2], [19, -2.45]], 1.25, "garden-lakeside-walk");
  path([[4, 15.6], [11, 14.7], [16, 12.5], [18.8, 10.7]], 1.3, "garden-terrace-walk");

  // 池岸是不规则闭合曲线，向内依次为石岸、水面；没有叠放透明平面。
  const pondX = 18, pondZ = 21;
  const shore = new THREE.CatmullRomCurve3([
    [-6, -2], [-2.5, -4.4], [3, -4.6], [6.5, -2.2], [6.8, 1.1], [3, 4.1], [-2, 4.5], [-6.4, 2],
  ].map(([x, z]) => new THREE.Vector3(x!, 0, z!)), true, "catmullrom", .35);
  const outline = shore.getPoints(96);
  const contour = (scale: number) => outline.map(p => new THREE.Vector2(pondX + p.x * scale, -(pondZ + p.z * scale)));
  surface("pond-bank", contour(1.08), -.405, 0xb8b393);
  const water = surface("garden-pond", contour(.985), -.285, 0x5b9f9b);
  const waterMaterial = water.material as THREE.MeshStandardMaterial;
  waterMaterial.roughness = .32;
  waterMaterial.metalness = .12;
  const waterTime = { value: 0 };
  // 细小波光沿水面移动，沿用标准材质的阴影、雾和色调映射。
  waterMaterial.onBeforeCompile = shader => {
    shader.uniforms.gardenTime = waterTime;
    shader.vertexShader = `varying vec2 gardenPosition;\n${shader.vertexShader}`
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ngardenPosition = position.xz;");
    shader.fragmentShader = `uniform float gardenTime; varying vec2 gardenPosition;\n${shader.fragmentShader}`
      .replace("#include <color_fragment>", `#include <color_fragment>
        float wave = sin(gardenPosition.x * .7 + gardenPosition.y * 3.5 + sin(gardenPosition.x * .4 - gardenTime * .2) * 1.4 + gardenTime * .55);
        float broken = smoothstep(.5, .95, sin(gardenPosition.x * 1.8 - gardenPosition.y * .3 - gardenTime * .22));
        float light = smoothstep(.94, 1.0, wave) * broken;
        diffuseColor.rgb += vec3(.025, .05, .05) * light;
        diffuseColor.rgb *= .97 + .03 * sin(gardenPosition.y * .8 + gardenTime * .25);`);
  };
  waterMaterial.customProgramCacheKey = () => "manor-pond-ripples-v1";
  for (let i = 0; i < 86; i++) {
    const p = shore.getPoint(i / 86), tangent = shore.getTangent(i / 86);
    box(pondX + p.x, -.28 + random() * .025, pondZ + p.z, .58 + random() * .12, .32, .42 + random() * .12,
      [0xc1b69b, 0xd2c6aa, 0xb7b19b][i % 3]!, Math.atan2(-tangent.z, tangent.x));
  }
  const rippleGeometry = new THREE.RingGeometry(.96, 1, 48);
  rippleGeometry.rotateX(-Math.PI / 2);
  const ripples = [[16.8, 21.8], [21.5, 19.4], [20.8, 23.5]].map(([x, z], i) => {
    const mesh = new THREE.Mesh(rippleGeometry, new THREE.MeshBasicMaterial({ color: 0xd2e5ce, transparent: true, opacity: .13, depthWrite: false }));
    mesh.name = `pond-ripple-${i}`;
    mesh.position.set(x!, -.272, z!);
    group.add(mesh);
    return mesh;
  });
  // 睡莲叶使用扁平六边体，花朵和芦苇延续体素模型的尺度。
  const lilyGeometry = new THREE.CylinderGeometry(1, 1, 1, 7);
  const lilies: Block[] = [];
  for (const [x, z] of [[20.7, 23.6], [21.4, 23.9], [20.1, 24], [22.6, 18.9], [22.9, 19.5], [16, 18.2]]) {
    box(x!, -.255, z!, .3 + random() * .12, .045, .29 + random() * .13, 0x708c53, random() * 3, 0, lilies);
    if (random() > .4) {
      box(x!, -.18, z!, .12, .10, .12, 0xe5c8c4, .4, 0, petals);
      box(x!, -.12, z!, .05, .05, .05, 0xe7cf93, 0, 0, petals);
    }
  }
  batch("pond-lily-pads", lilies, new THREE.MeshStandardMaterial({ roughness: .85 }), lilyGeometry);
  for (let i = 0; i < 55; i++) {
    const t = .10 + random() * .48, p = shore.getPoint(t), scale = 1.035 + random() * .08;
    const x = pondX + p.x * scale, z = pondZ + p.z * scale, height = .34 + random() * .5;
    box(x, -.35 + height / 2, z, .035, height, .035, 0x7e8954, 0, (random() - .5) * .16);
    if (i % 3 === 0) box(x, -.32 + height, z, .07, .18, .07, 0x998164);
  }

  // 小桥逐块铺设拱形桥面；栏杆顺着桥拱连接，桥脚落在两岸。
  for (const [z, direction] of [[16.7, -1], [25.7, 1]]) {
    box(12.5, -.325, z!, 1.95, .30, .5, stone);
    box(12.5, -.315, z! + direction! * .35, 1.95, .31, .45, stone);
    box(12.5, -.37, z! + direction! * .75, 1.95, .20, .4, stone);
  }
  for (let i = 0; i <= 30; i++) {
    const z = 16.7 + i * .3, y = -.12 + Math.sin(i / 30 * Math.PI) * .58;
    box(12.5, y, z, 1.85, .13, .275, i % 3 ? wood : 0xaa885e);
    for (const x of [11.74, 13.26]) box(x, y - .14, z, .13, .18, .32, darkWood);
  }
  for (const x of [11.54, 13.46]) {
    let last: THREE.Vector3 | null = null;
    for (let i = 0; i <= 6; i++) {
      const z = 16.7 + i * 1.5, y = -.12 + Math.sin(i / 6 * Math.PI) * .58;
      box(x, y + .47, z, .11, 1.06, .11, darkWood);
      box(x, y + 1.02, z, .17, .08, .17, 0xbe9d70);
      const next = new THREE.Vector3(x, y + .91, z);
      if (last) {
        beam(last, next, .10, wood);
        beam(last.clone().add(new THREE.Vector3(0, -.43, 0)), next.clone().add(new THREE.Vector3(0, -.43, 0)), .07, wood);
      }
      last = next;
    }
  }

  function planter(x: number, z: number, width: number, depth: number, color: number, density = 28) {
    box(x, -.28, z, width + .16, .38, depth + .16, stone);
    box(x, -.12, z, width, .12, depth, 0x756b4a);
    for (let i = 0; i < density; i++) {
      const px = x + (random() - .5) * (width - .2), pz = z + (random() - .5) * (depth - .2), h = .22 + random() * .18;
      box(px, .02 + h / 2, pz, .07, h, .07, leaf);
      box(px, .03 + h, pz, .15, .12, .14, i % 5 ? color : 0xe9dfc5, random(), 0, petals);
      box(px + .08, .08 + h / 2, pz, .16, .06, .09, 0x8b9b65, .5);
    }
  }
  function pot(x: number, y: number, z: number, size: number) {
    box(x, y, z, size * .8, size * .7, size * .8, 0xb59271);
    box(x, y + size * .36, z, size, size * .14, size, 0xc3a07c);
    box(x, y + size * .44, z, size * .7, .06, size * .7, 0x746849);
    for (let i = 0; i < 3; i++) box(x + (i - 1) * size * .21, y + size * (.75 + i * .08), z,
      size * .26, size * .64, size * .28, [leaf, 0x91a371, 0x82945e][i]! , i * .7, (i - 1) * .2);
  }

  // 温室：石基座、独立窗格、屋脊饰件与可见的种植台。
  const gx = 19, gz = -6.8, halfW = 2.7, halfD = 3.8, eave = 2.65, ridge = 4.25;
  box(gx, -.27, gz, 6.1, .34, 8.2, stone);
  box(gx, -.075, gz, 5.6, .08, 7.8, 0xd7ceb5);
  box(gx, -.29, gz + 4.4, 2.05, .36, .55, cream);
  box(gx, -.355, gz + 4.9, 2.2, .23, .5, stone);
  for (const x of [-halfW, halfW]) {
    box(gx + x, .17, gz, .18, .4, 7.7, cream);
    for (let i = 0; i <= 8; i++) {
      const z = gz - halfD + i * .95;
      box(gx + x, 1.42, z, .09, 2.58, .09, cream);
      if (i < 8) box(gx + x, 1.5, z + .475, .035, 2.13, .84, 0xc1e0d6, 0, 0, panes);
    }
    for (const y of [.39, 1.4, eave]) box(gx + x, y, gz, .13, .09, 7.7, cream);
    for (let i = 0; i <= 8; i++) {
      const z = gz - halfD + i * .95;
      beam(new THREE.Vector3(gx + x, eave, z), new THREE.Vector3(gx, ridge, z), .085, cream);
    }
    const angle = Math.atan2(ridge - eave, halfW) * (x < 0 ? 1 : -1);
    const length = Math.hypot(halfW, ridge - eave);
    for (let i = 0; i < 8; i++) box(gx + x / 2, (ridge + eave) / 2, gz - halfD + .475 + i * .95,
      length - .10, .025, .84, 0xb8dbd1, 0, angle, panes);
    box(gx + x * .5, (ridge + eave) / 2 + .035, gz, .07, .07, 7.7, cream);
  }
  const gableVertices: number[] = [];
  for (const side of [-1, 1]) {
    const z = gz + halfD * side;
    for (let i = -3; i <= 3; i++) {
      const x = gx + i * .85;
      if (side !== 1 || i !== 0) box(x, 1.37, z, .075, 2.65, .075, cream);
      const top = ridge - Math.abs(i * .85) / halfW * (ridge - eave);
      box(x, (top + eave) / 2, z, .065, Math.max(.07, top - eave), .065, cream);
      if (i < 3 && !(side === 1 && (i === -1 || i === 0))) box(x + .425, 1.46, z, .76, 2.27, .025, 0xc1e0d6, 0, 0, panes);
      if (i < 3) {
        const left = x + .045, right = x + .805;
        const topLeft = ridge - Math.abs(left - gx) / halfW * (ridge - eave) - .06;
        const topRight = ridge - Math.abs(right - gx) / halfW * (ridge - eave) - .06;
        const vertices = [[left, eave + .07, z], [right, eave + .07, z], [right, topRight, z], [left, topLeft, z]];
        for (const index of side > 0 ? [0, 1, 2, 0, 2, 3] : [2, 1, 0, 3, 2, 0]) gableVertices.push(...vertices[index]!);
      }
    }
    box(gx, eave, z, 5.5, .12, .13, cream);
    if (side === -1) box(gx, .18, z, 5.5, .38, .2, cream);
  }
  box(gx, ridge + .06, gz, .16, .14, 7.95, cream);
  for (let i = 0; i < 12; i++) box(gx, ridge + .2, gz - 3.55 + i * .65, .08, .25, .08, cream);
  // 前门沿竖直铰链打开，屋内留出中央通道。
  const hinge = new THREE.Vector3(gx - .82, 0, gz + halfD), doorAngle = -.58;
  const doorPoint = (x: number, y: number) => new THREE.Vector3(x, y, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), doorAngle).add(hinge);
  for (const x of [0, 1.64]) {
    const p = doorPoint(x, 1.32); box(p.x, p.y, p.z, .09, 2.58, .09, cream, doorAngle);
  }
  for (const y of [.06, 1.3, 2.6]) {
    const p = doorPoint(.82, y); box(p.x, p.y, p.z, 1.7, .09, .09, cream, doorAngle);
  }
  const doorGlass = doorPoint(.82, 1.33);
  box(doorGlass.x, doorGlass.y, doorGlass.z, 1.52, 2.44, .025, 0xc1e0d6, doorAngle, 0, panes);
  const handle = doorPoint(1.43, 1.2); box(handle.x, handle.y, handle.z + .065, .04, .24, .07, darkWood);
  for (const side of [-1, 1]) {
    const x = gx + side * 1.65;
    box(x, .76, gz, 1.15, .13, 6.2, wood);
    for (const z of [-2.6, 0, 2.6]) box(x, .32, gz + z, .09, .78, .09, darkWood);
    for (let i = 0; i < 9; i++) pot(x, .99, gz - 2.6 + i * .64, .34 + random() * .09);
  }
  for (const x of [gx - 2.6, gx + 2.6]) pot(x, -.02, gz + 4.25, .65);
  planter(gx + 4.2, gz - 2.2, 1.3, 3.2, lavender, 35);
  planter(gx + 4.2, gz + 1.7, 1.3, 3.2, rose, 35);

  // 藤架沿游园路展开，攀援植物留出入口和下方视线。
  const px = 18.8, pz = 7.6;
  for (const x of [-2.2, 2.2]) for (const z of [-1.6, 1.6]) {
    box(px + x, -.19, pz + z, .46, .42, .46, stone);
    box(px + x, 1.3, pz + z, .16, 2.95, .16, cream);
    box(px + x, 2.75, pz + z, .3, .14, .3, cream);
    for (let i = 0; i < 9; i++) box(px + x + Math.sin(i) * .14, .15 + i * .29, pz + z + Math.cos(i) * .11,
      .28, .25, .28, i % 2 ? leaf : 0x91a273, i);
  }
  for (const z of [-1.6, 1.6]) box(px, 2.8, pz + z, 5.2, .18, .17, cream);
  for (let i = 0; i <= 10; i++) {
    const x = px - 2.3 + i * .46;
    box(x, 2.99, pz, .12, .18, 4.1, cream);
    if (i % 2 === 0) for (let j = 0; j < 4; j++) {
      box(x + .06, 3.13 + random() * .07, pz - 1.6 + j * 1.05, .65, .21, .58, leaf);
      box(x, 2.77, pz - 1.7 + j * 1.06, .13, .44 + random() * .25, .14, lavender, 0, 0, petals);
    }
  }
  function bench(x: number, z: number, rotation = 0) {
    const part = (dx: number, y: number, dz: number, w: number, h: number, d: number, color: number) => {
      box(x + Math.cos(rotation) * dx + Math.sin(rotation) * dz, y,
        z - Math.sin(rotation) * dx + Math.cos(rotation) * dz, w, h, d, color, rotation);
    };
    for (const dx of [-.7, .7]) {
      part(dx, -.05, 0, .12, .72, .13, darkWood);
      part(dx, .35, -.3, .10, 1.3, .1, darkWood);
      part(dx, .6, .03, .1, .08, .7, wood);
    }
    for (let i = 0; i < 4; i++) part(0, .27, -.25 + i * .17, 1.85, .07, .14, wood);
    for (let i = 0; i < 3; i++) part(0, .54 + i * .19, -.3, 1.85, .13, .07, wood);
  }
  bench(px + 1.35, pz, Math.PI / 2);
  bench(23.7, 27.4, -.45);
  planter(px - 2.7, pz, .75, 2.7, rose, 26);
  planter(px + 2.7, pz, .75, 2.7, lavender, 26);

  // 入口石台、花境与修剪树形成抵达轴线，蓝领结铭牌沿用品牌形状。
  for (const side of [-1, 1]) {
    const x = side * 4.4;
    box(x, -.12, 16.3, 1.1, .7, .85, stone);
    box(x, .27, 16.3, 1.24, .12, .98, cream);
    box(x, .6, 16.3, .48, .56, .48, leaf, .14);
    box(x, 1.02, 16.3, .34, .33, .34, 0x91a16c, .14);
    planter(side * 5.25, 20.9, 1.4, 4, lavender, 44);
  }
  box(-6.6, .08, 16, 2.2, .9, .42, cream);
  box(-6.6, .12, 16.235, 1.8, .55, .055, 0x536c70);
  const bow = new THREE.Shape();
  bow.moveTo(-.3, -.16); bow.lineTo(-.3, .16); bow.lineTo(0, .04); bow.lineTo(.3, .16); bow.lineTo(.3, -.16); bow.lineTo(0, -.04); bow.closePath();
  const bowMesh = new THREE.Mesh(new THREE.ShapeGeometry(bow), new THREE.MeshStandardMaterial({ color: 0xcbd8e1, roughness: .6 }));
  bowMesh.name = "arrival-bowtie-plaque";
  bowMesh.position.set(-6.6, .12, 16.27);
  group.add(bowMesh);

  const leaves = [0x697d50, 0x7e925c, 0x93a46d, 0x9aab79];
  function tree(x: number, z: number, scale: number, narrow = false) {
    const base = -.46, trunk = 2.25 * scale;
    box(x, base + trunk / 2, z, .3 * scale, trunk, .3 * scale, 0x807257);
    if (narrow) {
      for (let i = 0; i < 5; i++) box(x, base + (1.45 + i * .65) * scale, z,
        (1.45 - i * .21) * scale, .85 * scale, (1.35 - i * .2) * scale, leaves[i % 4]!, .17);
      return;
    }
    for (const [dx, y, dz, w, h, d] of [[0, 3.05, 0, 1.95, 1.55, 1.8], [-.8, 2.55, .16, 1.28, 1.22, 1.35],
      [.79, 2.8, -.2, 1.32, 1.32, 1.34], [-.12, 4, -.08, 1.35, .78, 1.23], [.15, 2.92, .84, 1.36, 1.12, 1.16]]) {
      box(x + dx! * scale, base + y! * scale, z + dz! * scale, w! * scale, h! * scale, d! * scale, leaves[Math.floor(random() * 4)]!);
      for (let i = 0; i < 4; i++) box(x + (dx! + (random() - .5) * w!) * scale, base + (y! + (random() - .5) * h!) * scale,
        z + (dz! + (random() - .5) * d!) * scale, .46 * scale, .41 * scale, .43 * scale, leaves[Math.floor(random() * 4)]!);
    }
  }
  // 林带集中在远处和左侧，池塘与建筑之间留出开阔草坪。
  for (const [x, z, scale, narrow] of [
    [-20, -12, 1.3, 0], [-23, -8, .95, 1], [-21, -3, 1.15, 0], [-25, 1, 1.3, 0], [-22, 5, .9, 1],
    [-20, 12, 1.1, 0], [-22, 16, .8, 0], [-27, 18, 1.1, 0], [-25, 27, 1, 0], [-20, 30, .8, 1],
    [-6, -21, 1.1, 0], [-12, -23, 1.25, 0], [-17, -20, .95, 1], [-3, -25, 1.1, 1],
    [5, -23, 1.3, 0], [10, -26, 1.1, 0], [15, -21, .95, 1], [23, -21, 1.25, 0], [27, -17, .85, 1],
    [29, -10, 1.25, 0], [31, -4, 1.1, 0], [32, 5, 1.2, 0], [30, 9, .9, 1],
    [32, 30, 1.15, 0], [29, 33, .85, 0], [-9, 31, .9, 0], [-14, 35, 1.1, 0],
  ]) tree(x!, z!, scale!, Boolean(narrow));
  for (const [cx, cz] of [[-17, 8], [29, 15], [9, -18], [-12, 26]]) {
    for (let i = 0; i < 8; i++) {
      const x = cx! + (random() - .5) * 2.8, z = cz! + (random() - .5) * 2.3;
      const height = .4 + random() * .12;
      box(x, -.47 + height / 2, z, .45 + random() * .35, height, .5, 0x9ba582, random());
    }
  }
  for (const [x, z] of [[-3.8, 18], [3.8, 18], [-6, 27], [15.5, 15.2], [23, 29], [25.8, 12.6], [16, -1]]) {
    box(x!, .48, z!, .085, 1.9, .085, 0x4b5d51);
    box(x!, 1.5, z!, .23, .28, .23, 0xe9d7af);
    box(x!, 1.68, z!, .34, .08, .34, 0x4b5d51);
  }
  const cube = new THREE.BoxGeometry(1, 1, 1);
  batch("garden-masonry-woodland-and-joinery", blocks, new THREE.MeshStandardMaterial({ roughness: .93 }), cube);
  const flowers = batch("garden-flowers-and-wisteria", petals, new THREE.MeshStandardMaterial({ roughness: .9 }), cube);
  const glass = batch("greenhouse-glass", panes,
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: .28, roughness: .22, metalness: .08, depthWrite: false }), cube);
  glass.renderOrder = 1;
  const gableGeometry = new THREE.BufferGeometry();
  gableGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gableVertices, 3));
  gableGeometry.computeVertexNormals();
  const gableGlass = new THREE.Mesh(gableGeometry, new THREE.MeshStandardMaterial({
    color: 0xc1e0d6, transparent: true, opacity: .28, roughness: .22, metalness: .08, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  }));
  gableGlass.name = "greenhouse-gable-glass";
  gableGlass.renderOrder = 1;
  group.add(gableGlass);
  const hillGeometry = new THREE.IcosahedronGeometry(1, 1);
  const hillMaterial = new THREE.MeshStandardMaterial({ color: 0xa7b58d, roughness: 1 });
  for (const [x, z, width, height, depth] of [[-25, -43, 24, 4, 12], [8, -48, 26, 5.2, 16], [40, -35, 22, 3.7, 15]]) {
    const hill = new THREE.Mesh(hillGeometry, hillMaterial);
    hill.position.set(x!, -1.8, z!); hill.scale.set(width!, height!, depth!);
    hill.name = "estate-distant-slope";
    group.add(hill);
  }
  return {
    group,
    update(time) {
      waterTime.value = time;
      ripples.forEach((ripple, i) => {
        const phase = (time * .12 + i / 3) % 1;
        ripple.scale.setScalar(.12 + phase * .92);
        ripple.material.opacity = Math.sin(phase * Math.PI) * .16;
      });
      // 共用绝对时间，花穗轻摆可重放；不累计位移。
      flowers.rotation.z = Math.sin(time * .55) * .0012;
    },
  };
}

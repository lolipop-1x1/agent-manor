import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { createEstate } from "../site/scene/estate.ts";

// 对实际闪点发射视线，避免只检查配置却漏掉实例化模型的重叠表面。
const estate = createEstate();
estate.group.updateMatrixWorld(true);
const origin = new THREE.Vector3(32, 28, 40);
for (const { name, point, eye = origin.toArray() } of [
  { name: "花坛土层与树篱外侧", point: [8.4958, .43827, .6] },
  { name: "相邻树篱叶块", point: [-3.25286, .95492, 6.91] },
  { name: "翼楼檐口与屋瓦", point: [-9.09159, 5.29945, -2.465] },
  { name: "铺装底板与草坪", point: [5.4518, .35, 12.0518], eye: [0, 28, 51] },
  { name: "树冠相邻体块", point: [-12.7178, 2.2782, 2.6655], eye: [0, 28, 51] },
]) {
  test(`${name}不以同向共面重叠产生旋转闪点`, () => {
    const ray = new THREE.Raycaster(new THREE.Vector3(...eye), new THREE.Vector3(...point).sub(new THREE.Vector3(...eye)).normalize());
    const hits = ray.intersectObject(estate.group, true).filter(hit => {
      const mesh = hit.object as THREE.Mesh;
      return !Array.isArray(mesh.material) && mesh.material.visible;
    });
    assert.ok(hits.length >= 2, "视线应穿过真实场景构件");
    const [first, second] = hits;
    assert.ok(second!.distance - first!.distance > .001
      || first!.face!.normal.dot(second!.face!.normal) < .99,
    `${first!.object.name}/${second!.object.name} 同向表面间距仅 ${second!.distance - first!.distance}`);
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { createLandscape } from "../site/scene/landscape.ts";

const landscape = createLandscape();
landscape.group.updateMatrixWorld(true);
const floorAt = (x: number, z: number) => {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 6, z), new THREE.Vector3(0, -1, 0));
  return ray.intersectObject(landscape.group, true).filter(hit => {
    const material = (hit.object as THREE.Mesh).material as THREE.Material;
    return !material.transparent && hit.point.y < .2;
  })[0]?.point.y ?? -Infinity;
};

test("小桥与温室入口通过台阶连接步道，单级高差小于二十厘米", () => {
  for (const points of [
    [[12.5, 15.5], [12.5, 15.95], [12.5, 16.35], [12.5, 16.7]],
    [[19, -1.6], [19, -2], [19, -2.4], [19, -2.8]],
  ]) {
    const heights = points.map(([x, z]) => floorAt(x!, z!));
    assert.ok(heights.every(Number.isFinite), "入口处必须有连续走行面");
    for (let i = 1; i < heights.length; i++) assert.ok(Math.abs(heights[i]! - heights[i - 1]!) <= .2,
      `入口 ${JSON.stringify(points[i])} 高差为 ${heights[i]! - heights[i - 1]!}`);
  }
});

test("湖面、涟漪与花穗共用可重放时间，暂停不会累计漂移", () => {
  const pond = landscape.group.getObjectByName("garden-pond") as THREE.Mesh;
  const material = pond.material as THREE.MeshStandardMaterial;
  const shader = {
    uniforms: {}, vertexShader: "#include <begin_vertex>", fragmentShader: "#include <color_fragment>",
  } as Parameters<typeof material.onBeforeCompile>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  const snapshot = () => ({
    time: shader.uniforms.gardenTime!.value,
    objects: landscape.group.children.map(object => ({ matrix: object.matrix.toArray(),
      opacity: object instanceof THREE.Mesh ? (object.material as THREE.Material).opacity : undefined })),
  });
  landscape.update(9.6); landscape.group.updateMatrixWorld(true);
  const initial = snapshot();
  landscape.update(30); landscape.group.updateMatrixWorld(true);
  assert.notDeepEqual(snapshot(), initial);
  landscape.update(9.6); landscape.group.updateMatrixWorld(true);
  assert.deepEqual(snapshot(), initial);
  landscape.update(9.6); landscape.group.updateMatrixWorld(true);
  assert.deepEqual(snapshot(), initial);
});

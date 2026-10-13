import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { createTeaScene } from "../site/scene/tea.ts";
import { getAgentTeaPose, getTeaMotion, teaCupPosition, TEA_CYCLE_DURATION, TEA_LAYOUT, TEA_SLOT_DURATION } from "../site/scene/tea-motion.ts";

const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} 应接近 ${expected}`);

test("茶会按四个站位循环，管家停稳后倒茶，客人在收壶后举杯", () => {
  const served = new Set<number>();
  for (let time = 0; time < TEA_CYCLE_DURATION; time += .05) {
    const motion = getTeaMotion(time);
    assert.ok(Number.isFinite(motion.heading));
    const radius = Math.hypot(motion.x, motion.z);
    assert.ok(radius >= TEA_LAYOUT.serviceRadius - 1e-6 && radius <= TEA_LAYOUT.walkRadius + 1e-6);
    if (motion.pour > .01) {
      served.add(motion.guestIndex);
      near(motion.walkWeight, 0);
      near(motion.lift, 1);
      near(motion.tilt, 1);
      near(getAgentTeaPose(time, motion.guestIndex).lift, 0);
    }
  }
  assert.deepEqual([...served], [0, 1, 2, 3]);
  for (let index = 0; index < 4; index++) {
    assert.ok(getAgentTeaPose(index * TEA_SLOT_DURATION + 13.3, index).lift > .99);
    near(getTeaMotion(index * TEA_SLOT_DURATION + 13.3).pour, 0);
  }
});

test("完整路线连续，绕行时管家身体留在桌椅之外", () => {
  const boundaryTimes = [.5, 1.8, 2.2, 5.2, 5.6, 7, 7.6, 16];
  for (const boundary of boundaryTimes) {
    const before = getTeaMotion(boundary - 1e-5);
    const after = getTeaMotion(boundary + 1e-5);
    near(before.x, after.x, 1e-3);
    near(before.z, after.z, 1e-3);
    near(Math.sin(before.heading), Math.sin(after.heading), 1e-3);
    near(Math.cos(before.heading), Math.cos(after.heading), 1e-3);
  }
  for (let time = 0; time <= TEA_CYCLE_DURATION; time += .08) {
    const motion = getTeaMotion(time);
    for (let index = 0; index < 4; index++) {
      const angle = index * Math.PI / 2;
      const radial = motion.x * Math.sin(angle) + motion.z * Math.cos(angle) - TEA_LAYOUT.agentRadius;
      const lateral = motion.x * Math.cos(angle) - motion.z * Math.sin(angle);
      const clearance = Math.hypot(Math.max(0, Math.abs(lateral) - .50), Math.max(0, Math.abs(radial) - .48));
      assert.ok(clearance > .36, `站位 ${index} 在 ${time} 秒需要保留身体通路`);
    }
  }
  const start = getTeaMotion(0);
  const end = getTeaMotion(TEA_CYCLE_DURATION);
  assert.deepEqual(start, end);
});

test("茶壶嘴对齐四个杯口，父场景位移旋转后仍保持接触，绝对时间可重放", () => {
  const tea = createTeaScene();
  const parent = new THREE.Group();
  parent.position.set(5.8, .35, 5.7);
  parent.rotation.y = .37;
  parent.add(tea.group);
  const pot = tea.group.getObjectByName("teapot")!;
  const inverse = new THREE.Matrix4();
  for (let index = 0; index < 4; index++) {
    tea.update(index * TEA_SLOT_DURATION + 9.6);
    inverse.copy(tea.group.matrixWorld).invert();
    const lip = new THREE.Vector3(0, .095, .49).applyMatrix4(pot.matrixWorld).applyMatrix4(inverse);
    const cup = teaCupPosition(index);
    near(lip.x, cup.x);
    near(lip.z, cup.z);
    near(lip.y, TEA_LAYOUT.cupY + .32);
  }
  tea.update(9.6);
  const snapshot = tea.group.children.filter(node => node instanceof THREE.InstancedMesh)
    .map(node => Array.from((node as THREE.InstancedMesh).instanceMatrix.array));
  tea.update(28);
  tea.update(9.6);
  const restored = tea.group.children.filter(node => node instanceof THREE.InstancedMesh)
    .map(node => Array.from((node as THREE.InstancedMesh).instanceMatrix.array));
  assert.deepEqual(restored, snapshot);
});

test("实例批次限制绘制调用，茶会完整动作保持在约定场地半径内", () => {
  const tea = createTeaScene();
  const batches = tea.group.children.filter(node => node instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
  assert.ok(batches.length <= 36, "模型零件应复用批次，避免逐零件绘制");
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  for (let time = 0; time < TEA_SLOT_DURATION; time += .16) {
    tea.update(time);
    for (const batch of batches) {
      const positions = batch.geometry.getAttribute("position");
      for (let instance = 0; instance < batch.count; instance++) {
        batch.getMatrixAt(instance, matrix);
        for (let vertex = 0; vertex < positions.count; vertex++) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
          assert.ok(Math.hypot(point.x, point.z) <= 4.1, `${batch.name} 超出茶庭范围`);
        }
      }
    }
  }
});

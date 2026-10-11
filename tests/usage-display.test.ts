import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenMillions } from "../web/features/usage/format.ts";
import { attributionTiles } from "../web/features/usage/treemap.ts";

test("Token 百万展示保持未知与真实零，小额请求不会舍入成零", () => {
  assert.equal(formatTokenMillions("zh-CN", null), "—");
  assert.equal(formatTokenMillions("en", 0), "0.00M");
  assert.equal(formatTokenMillions("zh-CN", 21_074_658_507), "21,074.66M");
  assert.equal(formatTokenMillions("en", 35), "0.000035M");
  assert.equal(formatTokenMillions("en", 1200), "0.0012M");
});

test("矩形面积按已知正值占比，未知和零不伪造面积，各矩形无重叠且填满范围", () => {
  const items = [6, 3, 1, 0, null].map((value, index) => ({ value, key: String(index), text: String(index), title: String(index) }));
  const tiles = attributionTiles(items, 640, 300);
  assert.equal(tiles.length, 3);
  assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + tile.rect.width * tile.rect.height, 0) - 192000) < 1e-6);
  for (const tile of tiles) {
    assert.ok(Math.abs(tile.rect.width * tile.rect.height / 192000 - tile.item.value! / 10) < 1e-10);
    assert.ok(tile.rect.x >= 0 && tile.rect.y >= 0 && tile.rect.x + tile.rect.width <= 640 && tile.rect.y + tile.rect.height <= 300);
    for (const other of tiles) if (tile !== other) {
      const overlap = Math.max(0, Math.min(tile.rect.x + tile.rect.width, other.rect.x + other.rect.width) - Math.max(tile.rect.x, other.rect.x))
        * Math.max(0, Math.min(tile.rect.y + tile.rect.height, other.rect.y + other.rect.height) - Math.max(tile.rect.y, other.rect.y));
      assert.equal(overlap, 0);
    }
  }
  assert.deepEqual(attributionTiles(items.slice(3), 640, 300), []);
});

test("矩形色阶随数值增加，相同数值同色，重排不改变色阶", () => {
  const items = [22.7, 15.5, 12.7, 12.3, 11.9, 11.3, 5.1, 4.4, 4.2, 4.2].map((value, index) => ({ value, key: String(index), text: String(index), title: String(index) }));
  const tiles = attributionTiles(items, 640, 300);
  assert.equal(tiles[0]!.tone, 4);
  for (let index = 1; index < tiles.length; index++) assert.ok(tiles[index - 1]!.tone >= tiles[index]!.tone);
  assert.equal(tiles[8]!.tone, tiles[9]!.tone);
  const reordered = attributionTiles([...items].reverse(), 400, 300);
  for (const tile of tiles) assert.equal(reordered.find(other => other.item.key === tile.item.key)!.tone, tile.tone);
});

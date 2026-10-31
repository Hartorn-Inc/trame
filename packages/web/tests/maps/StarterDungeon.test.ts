import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStarterDungeonScene, filterScenesForRole } from "../../src/maps/domain.ts";

describe("Starter Dungeon generation and role filtering", () => {
  it("creates deterministic Starter Dungeon with forgotten crypt configuration", () => {
    const scene = createStarterDungeonScene("camp-1");
    assert.equal(scene.title, "The Forgotten Crypt");
    assert.equal(scene.widthPx, 2800);
    assert.equal(scene.heightPx, 2100);
    assert.equal(scene.revealedToPlayers, false);
    assert.ok(scene.spawnPoints && scene.spawnPoints.length > 0);
    assert.equal(scene.spawnPoints[0].name, "Crypt Entrance");
    assert.ok(scene.walls.length > 0);
    assert.ok(scene.lights.length >= 3);
    assert.ok(scene.stagedTokens.length >= 3);
  });

  it("masks closed secret doors and hides GmHidden tokens when filtered for player", () => {
    const scene = createStarterDungeonScene("camp-1");
    scene.revealedToPlayers = true;
    const playerScenes = filterScenesForRole([scene], "PLAYER");
    assert.equal(playerScenes.length, 1);
    const playerScene = playerScenes[0];
    assert.ok(playerScene.walls.every((w) => w.wallType !== "SecretDoor"));
    assert.ok(playerScene.stagedTokens.every((t) => t.visibilityChannel !== "GmHidden"));
  });
});

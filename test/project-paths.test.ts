import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSensitiveProjectPath, resolveProjectPath } from "../src/project-paths.js";

describe("project path safety", () => {
  it("allows paths inside the project", () => {
    assert.equal(resolveProjectPath("/project", "src/index.ts"), "/project/src/index.ts");
  });

  it("rejects paths outside the project", () => {
    assert.throws(() => resolveProjectPath("/project", "../outside.txt"), /outside the project/);
  });

  it("blocks secrets in filenames and directories", () => {
    for (const file of [".env", "config/.env.local", "secrets/token.txt", "keys/private-key.pem"]) {
      assert.equal(isSensitiveProjectPath(file), true);
      assert.throws(() => resolveProjectPath("/project", file), /sensitive files/);
    }

    assert.equal(isSensitiveProjectPath(".env.example"), true);
    assert.equal(isSensitiveProjectPath("src/example.ts"), false);
  });
});

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { realpath, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { isSensitiveProjectPath, resolveProjectPath } from "./project-paths.js";

const root = await realpath(process.cwd());
const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const rl = createInterface({ input: stdin, output: stdout });
const client = new OpenAI();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const maxToolOutput = 40_000;

const instructions = `You are CatHub Codex, a helpful coding assistant working in the current project.
The project root is ${root}. Use tools to inspect relevant files before proposing changes.
Never claim a change, test, or pull request succeeded unless its tool reports success.
File edits and test execution require the user's explicit approval. Pull requests are only
created after explicit approval. Do not expose secrets or attempt to read sensitive files.
Prefer small, focused changes and explain what you changed and how it was verified.`;

const tools = [
  {
    type: "function",
    name: "list_files",
    strict: true,
    description: "List project files, excluding dependencies, build output, and sensitive files.",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Project-relative directory; use . for the root." }
      },
      required: ["directory"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_file",
    strict: true,
    description: "Read a text file from the project, excluding sensitive files.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative file path." }
      },
      required: ["file"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "git_diff",
    strict: true,
    description: "Show the current project changes and working-tree status.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
  },
  {
    type: "function",
    name: "run_tests",
    strict: true,
    description: "Run the project's npm test script after asking for user approval.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
  },
  {
    type: "function",
    name: "write_file",
    strict: true,
    description: "Create or replace a project file after displaying a preview and obtaining user approval.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative file path." },
        content: { type: "string", description: "Complete new text content for the file." }
      },
      required: ["file", "content"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "create_pull_request",
    strict: true,
    description: "Create a GitHub pull request with gh after obtaining explicit user approval.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Pull request title." },
        body: { type: "string", description: "Pull request description." }
      },
      required: ["title", "body"],
      additionalProperties: false
    }
  }
] as const;

type ToolArguments = Record<string, unknown>;

function getString(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid tool input: ${key} must be a string.`);
  }
  return value;
}

async function assertInsideProject(target: string, allowMissing = false): Promise<void> {
  let actual: string;
  try {
    actual = await realpath(target);
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    actual = await realpath(path.dirname(target));
  }
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) {
    throw new Error("That path resolves outside the project directory.");
  }
}

function runCommand(command: string, args: string[], cwd = root): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const truncated = output.slice(0, maxToolOutput);
      if (code === 0) {
        resolve(truncated || "(no output)");
      } else {
        reject(new Error(`${command} exited with code ${code}.\n${truncated}`));
      }
    });
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const target = resolveProjectPath(root, directory);
  await assertInsideProject(target);
  const entries = await readdir(target, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(target, entry.name);
    const relative = path.relative(root, fullPath);
    if (isSensitiveProjectPath(relative)) continue;
    if (entry.isDirectory()) {
      results.push(...await listFiles(relative));
    } else if (entry.isFile()) {
      results.push(relative);
    }
    if (results.length >= 500) break;
  }
  return results;
}

async function readProjectFile(file: string): Promise<string> {
  const target = resolveProjectPath(root, file);
  await assertInsideProject(target);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) throw new Error("The requested path is not a file.");
  if (fileStat.size > 200_000) throw new Error("The file is larger than the 200 KB read limit.");
  return readFile(target, "utf8");
}

async function approved(prompt: string): Promise<boolean> {
  const answer = await rl.question(`${prompt} [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

async function writeProjectFile(file: string, content: string): Promise<string> {
  const target = resolveProjectPath(root, file);
  await assertInsideProject(target, true);
  const existing = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const preview = content.split("\n").slice(0, 12).join("\n");
  stdout.write(`\nFile: ${path.relative(root, target)}\n`);
  stdout.write(`Current size: ${existing.length} characters; proposed size: ${content.length} characters\n`);
  stdout.write(`Proposed preview:\n${preview}${content.split("\n").length > 12 ? "\n..." : ""}\n`);
  if (!await approved("Allow this file change?")) return "User declined the file change.";
  await writeFile(target, content, "utf8");
  return `Updated ${path.relative(root, target)}.`;
}

async function runTests(): Promise<string> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (!packageJson.scripts?.test) throw new Error("This project does not define an npm test script.");
  if (!await approved("Run the project's npm test script? It may execute project code.")) {
    return "User declined to run tests.";
  }
  return runCommand("npm", ["test"]);
}

async function createPullRequest(args: ToolArguments): Promise<string> {
  const title = getString(args, "title");
  const body = getString(args, "body");
  stdout.write(`\nProposed pull request:\nTitle: ${title}\n\n${body}\n`);
  if (!await approved("Create this pull request on GitHub?")) {
    return "User declined to create the pull request.";
  }
  return runCommand("gh", ["pr", "create", "--title", title, "--body", body]);
}

async function invokeTool(name: string, args: ToolArguments): Promise<string> {
  switch (name) {
    case "list_files":
      return (await listFiles(getString(args, "directory"))).join("\n") || "(no project files found)";
    case "read_file":
      return readProjectFile(getString(args, "file"));
    case "git_diff": {
      const [status, diff] = await Promise.all([
        runCommand("git", ["status", "--short"]),
        runCommand("git", ["diff", "HEAD", "--"])
      ]);
      return `Status:\n${status}\nDiff:\n${diff}`;
    }
    case "run_tests":
      return runTests();
    case "write_file":
      return writeProjectFile(getString(args, "file"), getString(args, "content"));
    case "create_pull_request":
      return createPullRequest(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY before starting CatHub Codex.");
  }
  stdout.write(`CatHub Codex — ${root}\nModel: ${model}\nType /exit to quit.\n\n`);
  const history: OpenAI.Responses.ResponseInputItem[] = [];

  while (true) {
    const prompt = (await rl.question("You> ")).trim();
    if (prompt === "/exit" || prompt === "/quit") break;
    if (!prompt) continue;

    history.push({ role: "user", content: prompt });
    let response = await client.responses.create({
      model,
      instructions,
      input: history,
      tools: [...tools]
    });

    while (true) {
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length === 0) break;
      history.push(...response.output);
      for (const call of calls) {
        let output: string;
        try {
          output = await invokeTool(call.name, JSON.parse(call.arguments) as ToolArguments);
        } catch (error) {
          output = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        history.push({ type: "function_call_output", call_id: call.call_id, output });
      }
      response = await client.responses.create({
        model,
        instructions,
        input: history,
        tools: [...tools]
      });
    }
    history.push(...response.output);
    stdout.write(`\nCatHub> ${response.output_text || "(no text response)"}\n\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`CatHub Codex stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

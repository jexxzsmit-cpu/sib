import path from "node:path";

const sensitiveFilePattern = /(?:secret|credential|private.?key)/i;
const sensitiveExtensionPattern = /\.(?:pem|key|p12|pfx)$/i;

export function isSensitiveProjectPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  return segments.some((segment) =>
    /^\.env(?:\..*)?$/i.test(segment) ||
    sensitiveFilePattern.test(segment) ||
    sensitiveExtensionPattern.test(segment)
  );
}

export function resolveProjectPath(root: string, input: string): string {
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("That path is outside the project directory.");
  }
  if (isSensitiveProjectPath(path.relative(root, resolved))) {
    throw new Error("Access to sensitive files is blocked.");
  }
  return resolved;
}

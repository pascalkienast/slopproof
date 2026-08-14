const ROOT_PUBLIC_ENV_EXAMPLES = new Set([".env.production.example"]);

export function isSensitiveHistoryPath(path) {
  if (path.endsWith("/.gitkeep")) return false;
  if (ROOT_PUBLIC_ENV_EXAMPLES.has(path) || path.endsWith(".env.example")) {
    return false;
  }

  return (
    /(^|\/)(?:\.secrets|secrets?|backups?|node_modules)(\/|$)/u.test(path) ||
    /\.env(?:\.|$)/u.test(path) ||
    /\.(?:pem|key|p12|pfx|backup|bak)$/u.test(path)
  );
}

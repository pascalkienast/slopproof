import { createServer, type Server } from "node:http";

const RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export function createGithubControlHealthServer(
  isReady: () => boolean,
): Server {
  return createServer((request, response) => {
    handleGithubControlHealthRequest(request, response, isReady);
  });
}

type HealthRequest = Readonly<{
  method?: string | undefined;
  url?: string | undefined;
}>;
type HealthResponse = Readonly<{
  end(body: string): unknown;
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
}>;

export function handleGithubControlHealthRequest(
  request: HealthRequest,
  response: HealthResponse,
  isReady: () => boolean,
): void {
  if (request.url !== "/healthz") {
    response.writeHead(404, RESPONSE_HEADERS);
    response.end('{"error":"not_found"}');
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { ...RESPONSE_HEADERS, allow: "GET" });
    response.end('{"error":"method_not_allowed"}');
    return;
  }

  const ready = isReady();
  response.writeHead(ready ? 200 : 503, RESPONSE_HEADERS);
  response.end(ready ? '{"status":"ok"}' : '{"status":"starting"}');
}

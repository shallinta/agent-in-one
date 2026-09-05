import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  InvalidPairIdError,
  parseSessionEventsQuery,
  type AssignPairTaskRequest,
  type AssignPairTaskResponse,
  type CreatePairRequest,
  type CreatePairResponse,
  type DshBuildRef,
  type GetPairResponse,
  type JsonObject,
  type ListPairSessionEventsQuery,
  type ListPairSessionEventsResponse,
  type PairProjection,
  type PairRuntimeCapabilities,
  type SendPairMessageRequest,
  type SendPairMessageResponse,
} from '@pair-agent/contracts';
import { LedgerConflictError, ProjectionInvariantError } from '@pair-agent/ledger';
import {
  BridgeFault,
  DeliveryPendingError,
  DuplicatePairError,
  InvalidCommandError,
  PairCoordinator,
  PairNotFoundError,
  PairNotReadyError,
  PairRegistry,
} from '@pair-agent/runtime';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface PairHostErrorBody {
  error: {
    code: string;
    message: string;
    details?: JsonObject;
  };
}

interface ActiveSseStream {
  close(): void;
}

interface PairHostState {
  activeStreams: Set<ActiveSseStream>;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

export interface CreatePairHostServerOptions {
  registry: PairRegistry;
  coordinator: PairCoordinator;
  dshBuild: DshBuildRef;
  capabilities?: PairRuntimeCapabilities;
  host?: string;
  port?: number;
  sse?: {
    write?: (response: ServerResponse, frame: string) => boolean;
    backpressureTimeoutMs?: number;
  };
}

const DEFAULT_RUNTIME_CAPABILITIES: PairRuntimeCapabilities = {
  schemaVersion: 1,
  stage: 'P0.5',
  sharedConversation: true,
  peerMessaging: true,
  completionHandoff: true,
  requestAudit: true,
  pilotWebSearch: false,
  goalControl: false,
  taskControl: false,
  executionPlanControl: false,
  attentionControl: false,
  pauseControl: false,
  subagents: false,
};

export interface PairHostServer {
  readonly server: Server;
  listen(): Promise<{ host: string; port: number; origin: string }>;
  close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(serialized)),
    ...headers,
  });
  response.end(serialized);
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: JsonObject,
  headers?: Record<string, string>,
): void {
  const body: PairHostErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  writeJson(response, status, body, headers);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    request.resume();
    throw new HttpRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
    );
  }
  const contentLength = request.headers['content-length'];
  if (
    contentLength !== undefined &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_JSON_BODY_BYTES
  ) {
    request.resume();
    throw new HttpRequestError(
      413,
      'BODY_TOO_LARGE',
      `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    );
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const rawChunk of request) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      byteLength += chunk.length;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        request.resume();
        throw new HttpRequestError(
          413,
          'BODY_TOO_LARGE',
          `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, 'REQUEST_ABORTED', 'Request body was aborted');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpRequestError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpRequestError(400, 'INVALID_BODY', 'JSON body must be an object');
  }
  return parsed;
}

function decodePairId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpRequestError(400, 'INVALID_PAIR_ID', 'Pair ID is malformed');
  }
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  writeError(
    response,
    405,
    'METHOD_NOT_ALLOWED',
    `Method is not allowed; use ${allow}`,
    undefined,
    { allow },
  );
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreatePairHostServerOptions,
  hostState: PairHostState,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://pair-host.local');
  const path = url.pathname;

  if (path === '/api/pairs') {
    if (method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    const body = await readJsonBody(request);
    const createRequest: CreatePairRequest = { pairId: body.pairId as string };
    const result = await options.coordinator.createPair({
      pairId: createRequest.pairId,
      dshBuild: options.dshBuild,
      expectedLedgerHead: 0,
    });
    if (result.status === 'failed') {
      writeError(
        response,
        503,
        'PAIR_AGENT_FAILED',
        result.reason,
        {
          pairId: result.projection.header.pairId,
          ledgerHead: result.projection.header.ledgerHead,
        },
      );
      return;
    }
    const createResponse: CreatePairResponse = {
      header: result.projection.header,
      panes: result.panes,
    };
    writeJson(response, 201, createResponse);
    return;
  }

  const getPairMatch = /^\/api\/pairs\/([^/]+)$/.exec(path);
  if (getPairMatch !== null) {
    if (method !== 'GET') {
      methodNotAllowed(response, 'GET');
      return;
    }
    const pair = await options.coordinator.getPair(
      decodePairId(getPairMatch[1]!),
    );
    const getResponse: GetPairResponse = {
      ...pair,
      capabilities: options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES,
    };
    writeJson(response, 200, getResponse);
    return;
  }

  const messageMatch =
    /^\/api\/pairs\/([^/]+)\/messages\/(navigator|pilot)$/.exec(path);
  if (messageMatch !== null) {
    if (method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    const pairId = decodePairId(messageMatch[1]!);
    const body = await readJsonBody(request);
    const messageRequest: SendPairMessageRequest = {
      text: body.text as string,
      expectedLedgerHead: body.expectedLedgerHead as number,
    };
    try {
      const result =
        messageMatch[2] === 'navigator'
          ? await options.coordinator.sendNavigator({ pairId, ...messageRequest })
          : await options.coordinator.sendPilot({ pairId, ...messageRequest });
      const messageResponse: SendPairMessageResponse = result;
      writeJson(response, 202, messageResponse);
    } catch (error) {
      if (!(error instanceof DeliveryPendingError)) throw error;
      const messageResponse: SendPairMessageResponse = {
        acceptedAtLedgerHead: error.acceptedAtLedgerHead,
        deliveryId: error.deliveryId,
        delivery: 'pending',
      };
      writeJson(response, 202, messageResponse);
    }
    return;
  }

  const taskMatch = /^\/api\/pairs\/([^/]+)\/tasks$/.exec(path);
  if (taskMatch !== null) {
    if (method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    const body = await readJsonBody(request);
    const taskRequest: AssignPairTaskRequest = {
      expectedLedgerHead: body.expectedLedgerHead as number,
      task: body.task as AssignPairTaskRequest['task'],
      ...(body.goalRef === undefined
        ? {}
        : { goalRef: body.goalRef as AssignPairTaskRequest['goalRef'] }),
    };
    try {
      const taskResponse: AssignPairTaskResponse =
        await options.coordinator.assignTask({
          pairId: decodePairId(taskMatch[1]!),
          ...taskRequest,
        });
      writeJson(
        response,
        202,
        taskResponse,
      );
    } catch (error) {
      if (!(error instanceof DeliveryPendingError)) throw error;
      const taskResponse: AssignPairTaskResponse = {
        acceptedAtLedgerHead: error.acceptedAtLedgerHead,
        deliveryId: error.deliveryId,
        delivery: 'pending',
      };
      writeJson(response, 202, taskResponse);
    }
    return;
  }

  const sessionEventsMatch = /^\/api\/pairs\/([^/]+)\/session-events$/.exec(path);
  if (sessionEventsMatch !== null) {
    if (method !== 'GET') {
      methodNotAllowed(response, 'GET');
      return;
    }
    const seenQueryKeys = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (seenQueryKeys.has(key)) {
        throw new HttpRequestError(
          400,
          'INVALID_QUERY',
          `Query parameter ${key} must not be repeated`,
        );
      }
      seenQueryKeys.add(key);
    }
    let query: ListPairSessionEventsQuery;
    try {
      query = parseSessionEventsQuery(Object.fromEntries(url.searchParams));
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new HttpRequestError(400, 'INVALID_QUERY', error.message);
    }
    const sessionEventsResponse: ListPairSessionEventsResponse =
      await options.coordinator.listSessionEvents(
        decodePairId(sessionEventsMatch[1]!),
        query,
      );
    writeJson(response, 200, sessionEventsResponse);
    return;
  }

  const eventsMatch = /^\/api\/pairs\/([^/]+)\/events$/.exec(path);
  if (eventsMatch !== null) {
    if (method !== 'GET') {
      methodNotAllowed(response, 'GET');
      return;
    }
    const pairId = decodePairId(eventsMatch[1]!);
    let closed = request.aborted || request.destroyed || response.destroyed;
    let finishing = false;
    let unsubscribe: (() => void) | undefined;
    let backpressureTimer: NodeJS.Timeout | undefined;
    let bufferedLatest: PairProjection | undefined;
    let pendingLatest: PairProjection | undefined;
    let blocked = false;
    let live = false;
    let lastSentLedgerHead = 0;
    const writeFrame =
      options.sse?.write ??
      ((target: ServerResponse, frame: string) => target.write(frame));
    const backpressureTimeoutMs =
      options.sse?.backpressureTimeoutMs ?? 5_000;
    const activeStream: ActiveSseStream = {
      close: () => finish(true),
    };
    const detach = (): void => {
      if (backpressureTimer !== undefined) {
        clearTimeout(backpressureTimer);
        backpressureTimer = undefined;
      }
      response.off('drain', onDrain);
      unsubscribe?.();
      unsubscribe = undefined;
      bufferedLatest = undefined;
      pendingLatest = undefined;
    };
    const cleanup = (): void => {
      if (closed && unsubscribe === undefined) return;
      closed = true;
      finishing = true;
      detach();
      hostState.activeStreams.delete(activeStream);
    };
    function finish(destroy: boolean): void {
      if (closed || finishing) return;
      finishing = true;
      detach();
      if (!response.writableEnded) response.end();
      if (destroy && !response.destroyed) response.destroy();
    }
    const armBackpressureTimeout = (): void => {
      if (backpressureTimer !== undefined || closed || finishing) return;
      backpressureTimer = setTimeout(() => finish(true), backpressureTimeoutMs);
      backpressureTimer.unref();
    };
    const writeProjection = (projection: PairProjection): void => {
      if (
        closed ||
        finishing ||
        response.destroyed ||
        response.writableEnded ||
        projection.header.ledgerHead <= lastSentLedgerHead
      ) {
        return;
      }
      if (blocked) {
        if (
          pendingLatest === undefined ||
          projection.header.ledgerHead > pendingLatest.header.ledgerHead
        ) {
          pendingLatest = projection;
        }
        return;
      }
      const accepted = writeFrame(
        response,
        `data: ${JSON.stringify(projection)}\n\n`,
      );
      lastSentLedgerHead = projection.header.ledgerHead;
      if (!accepted) {
        blocked = true;
        armBackpressureTimeout();
      }
    };
    function onDrain(): void {
      if (closed || finishing || !blocked) return;
      blocked = false;
      if (backpressureTimer !== undefined) {
        clearTimeout(backpressureTimer);
        backpressureTimer = undefined;
      }
      const pending = pendingLatest;
      pendingLatest = undefined;
      if (pending !== undefined) writeProjection(pending);
    }
    request.once('aborted', cleanup);
    request.once('close', cleanup);
    response.once('close', cleanup);
    response.on('drain', onDrain);
    hostState.activeStreams.add(activeStream);

    unsubscribe = options.registry.subscribe(pairId, (projection) => {
      if (closed || finishing) return;
      if (live) writeProjection(projection);
      else if (
        bufferedLatest === undefined ||
        projection.header.ledgerHead > bufferedLatest.header.ledgerHead
      ) {
        bufferedLatest = projection;
      }
    });
    if (closed || finishing) {
      cleanup();
      return;
    }

    try {
      const initial = await options.coordinator.getPair(pairId);
      if (closed || finishing) {
        cleanup();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      writeProjection(initial.projection);
      if (bufferedLatest !== undefined) writeProjection(bufferedLatest);
      bufferedLatest = undefined;
      live = true;
    } catch (error) {
      cleanup();
      if (request.aborted || request.destroyed || response.destroyed) return;
      throw error;
    }
    return;
  }

  writeError(response, 404, 'NOT_FOUND', 'Resource was not found');
}

function handleError(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (error instanceof HttpRequestError) {
    writeError(response, error.status, error.code, error.message);
  } else if (error instanceof BridgeFault) {
    writeError(
      response,
      503,
      'PAIR_BRIDGE_DEGRADED',
      'Pair shared-conversation bridge is degraded',
    );
  } else if (error instanceof DuplicatePairError) {
    writeError(response, 409, 'PAIR_DUPLICATE', error.message);
  } else if (error instanceof LedgerConflictError) {
    writeError(response, 409, 'LEDGER_CONFLICT', error.message, {
      expectedLedgerHead: error.expectedLedgerHead,
      actualLedgerHead: error.actualLedgerHead,
    });
  } else if (error instanceof PairNotFoundError) {
    writeError(response, 404, 'PAIR_NOT_FOUND', error.message);
  } else if (error instanceof PairNotReadyError) {
    writeError(response, 409, 'PAIR_NOT_READY', error.message);
  } else if (
    error instanceof InvalidCommandError ||
    error instanceof InvalidPairIdError ||
    error instanceof ProjectionInvariantError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    writeError(response, 400, 'INVALID_BODY', error.message);
  } else {
    writeError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export function createPairHostServer(
  options: CreatePairHostServerOptions,
): PairHostServer {
  const configuredHost = options.host ?? '127.0.0.1';
  const configuredPort = options.port ?? 0;
  const backpressureTimeoutMs = options.sse?.backpressureTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(backpressureTimeoutMs) || backpressureTimeoutMs <= 0) {
    throw new RangeError('sse.backpressureTimeoutMs must be a positive integer');
  }
  const hostState: PairHostState = { activeStreams: new Set() };
  const server = createServer((request, response) => {
    void routeRequest(request, response, options, hostState).catch((error: unknown) => {
      handleError(response, error);
    });
  });
  let listening = false;
  let closePromise: Promise<void> | undefined;

  return {
    server,
    async listen() {
      if (!listening) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off('error', onError);
            listening = true;
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(configuredPort, configuredHost);
        });
      }
      const address = server.address() as AddressInfo;
      const host = address.address;
      const originHost = host.includes(':') ? `[${host}]` : host;
      return { host, port: address.port, origin: `http://${originHost}:${address.port}` };
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      for (const stream of [...hostState.activeStreams]) stream.close();
      closePromise = (async () => {
        if (listening) {
          const serverClosed = new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error !== undefined) reject(error);
              else resolve();
            });
          });
          server.closeIdleConnections();
          await serverClosed;
          listening = false;
        }
        await options.coordinator.close();
      })();
      return closePromise;
    },
  };
}

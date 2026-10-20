import { EventEmitter } from 'node:events';
import type { Request, Response, RequestHandler, NextFunction } from 'express';
import { expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createImageHandler } from '../src/shared/files/image-upload.js';

function request() {
  return Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
}
const response = () => ({ destroyed: false }) as Response;
const pass: RequestHandler = (_req, _res, next) => next();

it('shares capacity across image routes and rejects excess work before parsing a body', async () => {
  const admission = createImageHandler(1);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const parsed = vi.fn(pass);
  const first = admission(pass, async () => gate);
  const second = admission(parsed, async () => {});
  const pending = first(request(), response(), vi.fn());
  const denied = vi.fn();
  await second(request(), response(), denied);
  expect(denied).toHaveBeenCalledWith(expect.objectContaining({ status: 503, code: 'FACE_BUSY' }));
  expect(parsed).not.toHaveBeenCalled();
  finish();
  await pending;
  await second(request(), response(), vi.fn());
  expect(parsed).toHaveBeenCalledOnce();
});

it('does not free capacity while disconnected requests still run asynchronous work', async () => {
  const admission = createImageHandler(1);
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const req = request(),
    res = response();
  const handle = admission(pass, async () => {
    started();
    await gate;
  });
  const pending = handle(req, res, vi.fn());
  await began;
  req.aborted = true;
  req.emit('aborted');
  res.destroyed = true;
  const denied = vi.fn();
  await handle(request(), response(), denied);
  expect(denied).toHaveBeenCalledWith(expect.objectContaining({ code: 'FACE_BUSY' }));
  finish();
  await pending;
});

it('recovers capacity when parsing aborts without invoking the operation', async () => {
  const admission = createImageHandler(1);
  const req = request(),
    action = vi.fn(async () => {}),
    failed = vi.fn();
  const handle = admission(() => {}, action);
  const pending = handle(req, response(), failed);
  req.aborted = true;
  req.emit('aborted');
  await pending;
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'UPLOAD_ABORTED' }));
  expect(action).not.toHaveBeenCalled();
  expect(req.listenerCount('aborted')).toBe(0);
  await admission(pass, action)(request(), response(), vi.fn());
  expect(action).toHaveBeenCalledOnce();
});

it('releases admission after parser and operation failures', async () => {
  const admission = createImageHandler(1);
  const failure = new Error('input fixture failed');
  const failed = vi.fn(),
    action = vi.fn(async () => {});
  await admission((_req, _res, next) => next(failure), action)(request(), response(), failed);
  expect(action).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith(failure);
  await admission(pass, async () => {
    throw failure;
  })(request(), response(), failed);
  await admission(pass, action)(request(), response(), vi.fn());
  expect(action).toHaveBeenCalledOnce();
});

it('delegates errors after headers are sent instead of writing a second response', () => {
  const failure = new Error('response already started');
  const res = { headersSent: true, status: vi.fn() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  errorHandler(pino({ level: 'silent' }))(failure, request(), res, next);
  expect(next).toHaveBeenCalledWith(failure);
  expect(res.status).not.toHaveBeenCalled();
});

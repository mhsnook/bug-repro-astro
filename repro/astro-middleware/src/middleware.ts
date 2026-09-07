import type { MiddlewareHandler } from "astro";
// A pass-through. It does nothing; its only role is to exist.
export const onRequest: MiddlewareHandler = (_context, next) => next();

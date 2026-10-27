/**
 * Client entry for SAM decoding: the implementation lives in
 * `@fitroom/shared` (`shared/src/sam.ts`) so Node checks decode fixtures
 * without a browser; this module re-exports it.
 */
export { segmentInstances, type SamInstance, type SamMask } from "@fitroom/shared";

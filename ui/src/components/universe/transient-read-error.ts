import {ApiError} from "../../api/client";

/** Retain previously authorized local state only for transport/server failures. */
export function isTransientUniverseReadError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status >= 500 && error.status <= 599);
}

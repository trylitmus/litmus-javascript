// SDK identification. Injected into every event as $lib and $lib_version
// so the ingest server knows which SDK sent it.
// Version is injected at build time from package.json via tsup's `define`.
declare const __SDK_VERSION__: string;

export const SDK_NAME = "litmus-ts";
export const SDK_VERSION = __SDK_VERSION__;
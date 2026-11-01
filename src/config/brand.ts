// Every product and tool name the UI shows lives here, so a rename is a one-line change.
// The Tauri bundle (src-tauri/tauri.conf.json, Cargo.toml) and index.html repeat the product name
// and the deep-link scheme, because they are read before any JS runs; keep them in step.

/** The product. */
export const PRODUCT = "Lightsmith";
/** This app. */
export const APP_NAME = `${PRODUCT} Studio`;
/** Desktop deep links: `${DEEP_LINK_SCHEME}://open?spec=...`. */
export const DEEP_LINK_SCHEME = "lightsmith-studio";
/** What a saved spec file is called in file dialogs. */
export const SPEC_FILE_LABEL = `${PRODUCT} spec`;

/** The library's own names, used in generated code and help text. */
export const LIBRARY = {
  /** `import <python> as <alias>` */
  python: "lightsmith",
  alias: "ls",
  /** `<cli> solve spec.json` */
  cli: "lightsmith",
  /** MCP server command */
  mcp: "lightsmith-mcp",
  /** Local compute server command, and the repository it lives in */
  server: "lightsmith-server",
  serverRepo: "lightsmith-cloud",
};

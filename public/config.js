// Runtime configuration. The Docker image overwrites this file at container start from its
// environment (see docker/40-studio-config.sh); static hosting can edit it by hand.
// Empty values fall back to the build-time defaults. Keys: see src/config/runtime.ts.
window.__STUDIO_CONFIG__ = {};

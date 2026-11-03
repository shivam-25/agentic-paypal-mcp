// thirdweb ships the x402 subpath but its types don't resolve under Node16
// module resolution in this project; we use it through a thin, typed wrapper.
declare module "thirdweb/x402";

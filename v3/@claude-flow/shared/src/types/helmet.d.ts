// Ambient stub for helmet — Express security middleware.
// Helmet ships its own types but isn't always hoisted in the build env.
declare module 'helmet' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helmet: any;
  export default helmet;
}

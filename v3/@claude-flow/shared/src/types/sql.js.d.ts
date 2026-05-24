// Ambient stub for sql.js — runtime dep, static import for the event store.
// Local package stub satisfies tsc when @types/sql.js isn't hoisted.
declare module 'sql.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs: any;
  export default initSqlJs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Database = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SqlValue = any;
}

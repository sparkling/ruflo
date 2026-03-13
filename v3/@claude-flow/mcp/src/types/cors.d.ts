declare module 'cors' {
  interface CorsOptions { origin?: any; methods?: string | string[]; allowedHeaders?: string | string[]; credentials?: boolean; }
  function cors(options?: CorsOptions): any;
  export = cors;
}

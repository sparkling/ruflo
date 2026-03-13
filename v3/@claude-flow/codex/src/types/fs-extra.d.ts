declare module 'fs-extra' {
  export function ensureDir(path: string): Promise<void>;
  export function pathExists(path: string): Promise<boolean>;
  export function readFile(path: string, encoding?: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function readdir(path: string, opts?: any): Promise<any[]>;
  export function stat(path: string): Promise<any>;
  export function remove(path: string): Promise<void>;
  export function copy(src: string, dest: string, opts?: any): Promise<void>;
}

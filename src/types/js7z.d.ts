/**
 * js7z-tools 模块类型声明
 *
 * js7z-tools 是 CommonJS 模块，使用 require() 导入。
 * 此声明为 TypeScript 提供类型信息。
 */
declare module "js7z-tools" {
  import type { JS7zFactory } from "./index";

  const factory: JS7zFactory;
  export = factory;
}

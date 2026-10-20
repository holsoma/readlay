import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);

// Execute the actual TypeScript source with controlled service and browser dependencies.
export function loadTypeScript(path, { stubs = {}, globals = {}, extra = "", env = {} } = {}) {
  const compiledModule = { exports: {} };
  const filename = new URL(path, root);
  const source = ts.transpileModule(readFileSync(filename, "utf8") + extra, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(source, {
    module: compiledModule,
    exports: compiledModule.exports,
    require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : require(id),
    process: { env },
    URL,
    Request,
    Response,
    TextDecoder,
    AbortController,
    AbortSignal,
    DOMException,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    ...globals,
  }, { filename: filename.pathname });
  return compiledModule.exports;
}

export const plain = (value) => JSON.parse(JSON.stringify(value));
export const emptyLibrary = () => ({ savedIds: [], progressByEdition: {}, bookmarks: [], lastReadBookId: null });
export const testBooks = [
  { id: "atomic-habits", slug: "atomic-habits", editionId: "edition-a", chapterCount: 2 },
  { id: "power-of-now", slug: "power-of-now", editionId: "edition-b", chapterCount: 1 },
];

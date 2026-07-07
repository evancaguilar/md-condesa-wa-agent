// Lets TypeScript resolve `import html from "./foo.html"` as a string. Mirrors
// text-modules.d.ts for *.md. The Wrangler Text rule must also glob **/*.html
// (integrator owns wrangler.jsonc) for the bundle to inline the file at build
// time; this declaration only satisfies the typechecker.
declare module "*.html" {
  const content: string;
  export default content;
}

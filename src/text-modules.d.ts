// Text-module ambient declarations. Wrangler's Text rule (wrangler.jsonc) inlines
// these files as strings at bundle time; these `declare module` blocks only satisfy
// the typechecker so `import x from "./y.md"` / `"./z.html"` resolve to a string.
//   *.md   → the compiled KB (src/kb.ts)
//   *.html → the admin dashboard SPA (src/routes/admin-ui.ts)
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.html" {
  const content: string;
  export default content;
}

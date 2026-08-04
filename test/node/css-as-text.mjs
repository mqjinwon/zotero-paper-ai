/**
 * Node test hook: treat .css imports as empty string modules
 * so panelView → katexCss can load under tsx (esbuild uses loader:text in builds).
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css") || url.includes(".css?")) {
    return {
      format: "module",
      shortCircuit: true,
      source: 'export default "";\n',
    };
  }
  return nextLoad(url, context);
}

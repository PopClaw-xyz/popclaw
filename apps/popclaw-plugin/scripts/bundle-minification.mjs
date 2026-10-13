/** Shared by the ESM graph and the CJS sources embedded for isolated workers.
 * Keep observable function/class names and license comments while shortening
 * local identifiers and expressions. Do not enable property-name mangling.
 * @satisfies {import('esbuild').BuildOptions} */
export const bundleMinification = {
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  keepNames: true,
  legalComments: 'eof',
};

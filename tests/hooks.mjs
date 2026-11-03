const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'sdk') return { url: stub('sdk.mjs'), shortCircuit: true };
  if (specifier === 'sdk/db') return { url: stub('sdk-db.mjs'), shortCircuit: true };
  if (/(^|\/)config\.js$/.test(specifier) && context.parentURL && context.parentURL.includes('/tgcloud/lib/')) {
    return { url: stub('config.mjs'), shortCircuit: true };
  }
  return next(specifier, context);
}

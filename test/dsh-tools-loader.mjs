export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return {
      shortCircuit: true,
      url: new URL('./mock-dsh-tools.mjs', import.meta.url).href,
    }
  }
  return nextResolve(specifier, context)
}
